import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { handlers, handle, dispatch, setClientFactory } from "../scripts/lib/daemon.mjs";
import { loadConfig } from "../scripts/lib/config.mjs";

/**
 * 假的 pi 客户端。
 *
 * 关键在于它**精确复现真实 PiRpcClient 的行为**：`ask` 只会「等下一个 agent_end，
 * 然后取最后一条助手文本」，认不出那个 agent_end 属于哪一轮——这正是串轮的成因。
 * 所以 daemon 那边一旦不排队，下面的测试就会挂。
 */
class FakeClient {
  constructor(options = {}) {
    this.options = options;
    this.listeners = new Set();
    this.stopped = false;
    this.turnMs = 30;
    this.failNextAsk = null;
    this.lastBashTimeout = null;
    this.lastAskTimeout = null;
    this.lastText = null;
    this.pendingTurns = [];
    this.busy = false;
    this.turnTimer = null;
  }

  async start() {}

  async stop() {
    this.stopped = true;
    clearTimeout(this.turnTimer);
  }

  onEvent(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async getState() {
    return { model: { provider: "fake", id: "fake-1" }, thinkingLevel: "medium", messageCount: 0 };
  }

  async setThinkingLevel() {}
  async prompt() {}
  async steer() {
    this.steered = true;
  }
  async abort() {
    this.aborted = true;
  }

  async bash(command, timeoutMs) {
    this.lastBashTimeout = timeoutMs;
    return { output: `ran: ${command}`, exitCode: 0, truncated: false };
  }

  async ask(message, timeoutMs) {
    if (this.failNextAsk) {
      const err = this.failNextAsk;
      this.failNextAsk = null;
      throw err;
    }
    this.lastAskTimeout = timeoutMs;
    // 与真实客户端一致：agent_end 迟迟不来就按 timeoutMs 超时，错误带 PI_TIMEOUT。
    let timer;
    const idle = new Promise((resolve, reject) => {
      const off = this.onEvent((e) => {
        if (e.type !== "agent_end") return;
        off();
        resolve();
      });
      if (timeoutMs !== undefined) {
        timer = setTimeout(() => {
          off();
          const err = new Error(`等待 pi 完成超时（${timeoutMs}ms）`);
          err.code = "PI_TIMEOUT";
          reject(err);
        }, timeoutMs);
        // stop() 会清掉 turnTimer、agent_end 再不会来，只剩这条超时 timer 兜底；
        // unref 让它别拖着测试进程不退（真实客户端靠进程退出事件打回等待者，不存在此问题）。
        timer.unref?.();
      }
    });
    this.#queueTurn(message);
    try {
      await idle;
    } finally {
      clearTimeout(timer);
    }
    return this.lastText;
  }

  // pi 侧自己也是串行的：消息排队，跑完这一轮才写回答案、才发 agent_end。
  #queueTurn(message) {
    this.pendingTurns.push(message);
    if (!this.busy) this.#runNext();
  }

  #runNext() {
    const message = this.pendingTurns.shift();
    if (message === undefined) {
      this.busy = false;
      return;
    }
    this.busy = true;
    this.#emit({ type: "agent_start" });
    this.turnTimer = setTimeout(() => {
      this.lastText = `回复：${message}`;
      this.#emit({ type: "agent_end" });
      this.#runNext();
    }, this.turnMs);
  }

  #emit(event) {
    for (const listener of [...this.listeners]) listener(event);
  }
}

/** 最近一次造出来的假客户端，测试里要拿它做断言。 */
let lastClient = null;

beforeEach(() => {
  setClientFactory((options) => (lastClient = new FakeClient(options)));
});

afterEach(async () => {
  await handlers.stop({ all: true });
  lastClient = null;
});

test("spawn 后 list 能看到它，stop 之后就没了", async () => {
  const { info } = await handlers.spawn({ id: "a1", cwd: "/tmp/x" });
  assert.equal(info.id, "a1");
  assert.equal(info.status, "idle");
  assert.equal(info.provider, "fake");

  assert.deepEqual(
    handlers.list().agents.map((a) => a.id),
    ["a1"],
  );

  assert.deepEqual(await handlers.stop({ id: "a1" }), { stopped: ["a1"] });
  assert.equal(lastClient.stopped, true);
  assert.deepEqual(handlers.list().agents, []);
});

test("同名 agent 不能重复 spawn", async () => {
  await handlers.spawn({ id: "a1", cwd: "." });
  await assert.rejects(() => handlers.spawn({ id: "a1", cwd: "." }), /已存在/);
});

test("找不到 agent 时，报错里带上当前都有谁在跑", async () => {
  await assert.rejects(() => handlers.send({ id: "ghost", message: "在吗" }), /当前没有任何常驻 agent/);
  await handlers.spawn({ id: "a1", cwd: "." });
  await assert.rejects(() => handlers.send({ id: "ghost", message: "在吗" }), /当前在跑的是：a1/);
});

test("agent 还忙着时再 send，拿回的是自己那一轮的答案，不会串轮", async () => {
  await handlers.spawn({ id: "a1", cwd: "." });

  // 先投一轮不等结果，让 agent 忙起来
  assert.deepEqual(await handlers.send({ id: "a1", message: "任务A", wait: false }), {
    id: "a1",
    queued: true,
  });

  // 紧接着再来一轮并等结果：不排队的话，它会被任务A 的 agent_end 提前唤醒，
  // 拿回「回复：任务A」——不报错，看着也正常，只是答非所问。
  const second = await handlers.send({ id: "a1", message: "任务B" });
  assert.equal(second.reply, "回复：任务B");
});

test("连着来三轮 send，各拿各的答案且顺序不乱", async () => {
  await handlers.spawn({ id: "a1", cwd: "." });
  const replies = await Promise.all([
    handlers.send({ id: "a1", message: "一" }),
    handlers.send({ id: "a1", message: "二" }),
    handlers.send({ id: "a1", message: "三" }),
  ]);
  assert.deepEqual(
    replies.map((r) => r.reply),
    ["回复：一", "回复：二", "回复：三"],
  );
});

test("首轮任务失败时 agent 仍在，只是带回 initialError", async () => {
  setClientFactory((options) => {
    lastClient = new FakeClient(options);
    lastClient.failNextAsk = new Error("等待 pi 完成超时（180000ms）");
    return lastClient;
  });

  const result = await handlers.spawn({ id: "a1", cwd: ".", initialPrompt: "干活" });
  assert.match(result.initialError, /等待 pi 完成超时/);
  assert.equal(result.reply, undefined);

  // 关键：agent 起来了就该留着，别让调用方以为没起来、换个名字重开。
  assert.deepEqual(
    handlers.list().agents.map((a) => a.id),
    ["a1"],
  );
  // 而且它接着就能干活。
  assert.equal((await handlers.send({ id: "a1", message: "再来" })).reply, "回复：再来");
});

test("spawn 传了 timeoutMs 时，首轮按它超时并带回 initialError，而不是挂满默认 180 秒", async () => {
  setClientFactory((options) => {
    lastClient = new FakeClient(options);
    lastClient.turnMs = 60_000; // 首轮怎么都跑不完
    return lastClient;
  });

  const startedAt = Date.now();
  const result = await handlers.spawn({ id: "a1", cwd: ".", initialPrompt: "慢活", timeoutMs: 50 });

  assert.ok(Date.now() - startedAt < 5000, "首轮该在 50ms 超时，而不是等满默认 180 秒");
  assert.equal(lastClient.lastAskTimeout, 50);
  assert.match(result.initialError, /等待 pi 完成超时（50ms）/);
  assert.equal(result.reply, undefined);
  // 首轮超时不该连 agent 一起判死
  assert.deepEqual(
    handlers.list().agents.map((a) => a.id),
    ["a1"],
  );
});

test("spawn 不传 timeoutMs 时，首轮回退到 defaultTimeoutMs", async () => {
  await handlers.spawn({ id: "a1", cwd: ".", initialPrompt: "干活" });
  assert.equal(lastClient.lastAskTimeout, loadConfig().limits.defaultTimeoutMs);
});

test("错误响应透传 code 字段，CLI 据此把 PI_TIMEOUT 按「还在跑」收场", async () => {
  await handlers.spawn({ id: "a1", cwd: "." });
  lastClient.failNextAsk = Object.assign(new Error("等待 pi 完成超时（100000ms）"), { code: "PI_TIMEOUT" });

  const response = await dispatch(JSON.stringify({ cmd: "send", args: { id: "a1", message: "x" } }));
  assert.equal(response.ok, false);
  assert.equal(response.code, "PI_TIMEOUT");
  assert.match(response.error, /等待 pi 完成超时/);

  // 普通错误没有 code，字段是 undefined（JSON 序列化时会丢弃，旧调用方无感）
  const plain = await dispatch(JSON.stringify({ cmd: "send", args: { id: "ghost", message: "x" } }));
  assert.equal(plain.ok, false);
  assert.equal(plain.code, undefined);
});

test("stop --all 一次收掉所有 agent", async () => {
  await handlers.spawn({ id: "a1", cwd: "." });
  await handlers.spawn({ id: "a2", cwd: "." });
  const { stopped } = await handlers.stop({ all: true });
  assert.deepEqual(stopped.sort(), ["a1", "a2"]);
  assert.deepEqual(handlers.list().agents, []);
});

test("bash 默认用 defaultTimeoutMs，而不是命令级的 30 秒", async () => {
  await handlers.spawn({ id: "a1", cwd: "." });
  const { result } = await handlers.bash({ id: "a1", command: "npm run build" });
  assert.equal(result.output, "ran: npm run build");
  assert.equal(lastClient.lastBashTimeout, loadConfig().limits.defaultTimeoutMs);
});

test("bash 的超时可以按次覆盖", async () => {
  await handlers.spawn({ id: "a1", cwd: "." });
  await handlers.bash({ id: "a1", command: "x", timeoutMs: 5000 });
  assert.equal(lastClient.lastBashTimeout, 5000);
});

test("steer 与 abort 不排队，直接插进当前这一轮", async () => {
  await handlers.spawn({ id: "a1", cwd: "." });
  await handlers.send({ id: "a1", message: "慢活", wait: false });

  // 队列里还压着一轮，但这两条得立刻到达，否则「中途纠偏」就无从谈起。
  assert.deepEqual(await handlers.steer({ id: "a1", message: "换个方向" }), { id: "a1", steered: true });
  assert.equal(lastClient.steered, true);
  assert.deepEqual(await handlers.abort({ id: "a1" }), { id: "a1", aborted: true });
  assert.equal(lastClient.aborted, true);
});

test("agent 的轮次与状态跟着事件走", async () => {
  await handlers.spawn({ id: "a1", cwd: "." });
  assert.equal(handlers.list().agents[0].turns, 0);
  await handlers.send({ id: "a1", message: "一轮" });
  const [info] = handlers.list().agents;
  assert.equal(info.turns, 1);
  assert.equal(info.status, "idle");
});

test("ping 报告存活的 agent 数", async () => {
  assert.equal(handlers.ping().agents, 0);
  await handlers.spawn({ id: "a1", cwd: "." });
  assert.equal(handlers.ping().agents, 1);
});

test("handle 把指令派给对应的 handler", async () => {
  const { agents } = await handle({ cmd: "ping" });
  assert.equal(agents, 0);
});

test("原型链上的成员冒充不了指令", async () => {
  // handlers 是普通对象字面量，`handlers["toString"]` 拿得到 Object.prototype.toString——
  // 只判 truthy 的话，它会被当成一个合法 handler 调用，返回 "[object Object]"。
  await assert.rejects(() => handle({ cmd: "toString" }), /未知指令：toString/);
  await assert.rejects(() => handle({ cmd: "constructor" }), /未知指令：constructor/);
  await assert.rejects(() => handle({}), /未知指令/);
});
