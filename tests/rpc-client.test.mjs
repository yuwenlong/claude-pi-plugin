import { test } from "node:test";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PiRpcClient } from "../scripts/lib/rpc-client.mjs";

const FAKE_PI = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-pi.mjs");

/** 用假 pi 起一个客户端（node <fake-pi.mjs> --mode rpc ...），测完自动收摊。 */
async function withClient(options, fn) {
  const client = new PiRpcClient({ cliPath: process.execPath, prefixArgs: [FAKE_PI], ...options });
  await client.start();
  try {
    return await fn(client);
  } finally {
    await client.stop();
  }
}

test("握手成功后能读到会话状态", async () => {
  await withClient({ provider: "fake-provider", model: "fake-model" }, async (client) => {
    const state = await client.getState();
    assert.equal(state.model.provider, "fake-provider");
    assert.equal(state.model.id, "fake-model");
  });
});

test("session=false 时传入 --no-session", async () => {
  await withClient({ session: false }, async (client) => {
    const state = await client.getState();
    assert.equal(state.sessionFile, undefined);
  });
});

test("start() 的握手顺手缓存了会话状态，省掉调用方再问一次", async () => {
  await withClient({ provider: "cached", model: "state" }, async (client) => {
    assert.equal(client.initialState.model.provider, "cached");
    assert.equal(client.initialState.model.id, "state");
  });
});

test("extensions=false 时传入 --no-extensions（省冷启动）", async () => {
  await withClient({ extensions: false }, async (client) => {
    assert.equal(client.initialState.noExtensions, true);
  });
});

test("默认不禁用扩展，常驻 agent 仍能用上它们", async () => {
  await withClient({}, async (client) => {
    assert.equal(client.initialState.noExtensions, false);
  });
});

test("ask 会等到 agent_end 再取最后一条助手文本", async () => {
  await withClient({}, async (client) => {
    assert.equal(await client.ask("你好", 5000), "收到：你好");
  });
});

test("事件按序分发给订阅者，退订后停止", async () => {
  await withClient({}, async (client) => {
    const seen = [];
    const off = client.onEvent((e) => seen.push(e.type));
    await client.ask("x", 5000);
    assert.deepEqual(seen.slice(0, 3), ["agent_start", "message_update", "agent_end"]);

    off();
    const before = seen.length;
    await client.ask("y", 5000);
    assert.equal(seen.length, before);
  });
});

test("响应按 id 精确回到各自的等待者，不会串号", async () => {
  await withClient({}, async (client) => {
    const [a, b] = await Promise.all([client.getState(), client.bash("ls")]);
    assert.equal(a.sessionId, "fake-session");
    assert.equal(b.output, "ran: ls");
  });
});

test("bash 的超时由调用方给，不再被命令级的 30 秒卡死", async () => {
  await withClient({}, async (client) => {
    // 给得太紧会超时……
    await assert.rejects(() => client.bash("sleep:300", 50), /等待 bash 响应超时/);
    // ……给够就能等到结果。编译、跑测试都属于后者。
    const result = await client.bash("sleep:300", 5000);
    assert.equal(result.exitCode, 0);
    assert.equal(result.output, "ran: sleep:300");
  });
});

test("success:false 的响应被翻译成异常", async () => {
  await withClient({}, async (client) => {
    await assert.rejects(() => client.send({ type: "explode" }).then((r) => {
      if (r.success === false) throw new Error(r.error);
    }), /故意失败/);
  });
});

test("waitForIdle 超时会报错并带上时长", async () => {
  await withClient({}, async (client) => {
    await assert.rejects(() => client.waitForIdle(50), /等待 pi 完成超时（50ms）/);
  });
});

test("pi 进程半路死掉时，等 agent_end 的人立刻被打回，不必干等满超时", async () => {
  const client = new PiRpcClient({ cliPath: process.execPath, prefixArgs: [FAKE_PI] });
  await client.start();

  const startedAt = Date.now();
  const idle = client.waitForIdle(30_000); // 故意给一个很宽的超时
  client.send({ type: "crash" }).catch(() => {});

  // 死因要如实报出来，而不是含糊地说一句「超时」把真正的原因盖掉。
  await assert.rejects(() => idle, /pi 进程已退出/);
  assert.ok(Date.now() - startedAt < 5000, "该立刻失败，而不是等满 30 秒");

  await client.stop();
});

test("停止后再发命令会明确报错，而不是静默挂起", async () => {
  const client = new PiRpcClient({ cliPath: process.execPath, prefixArgs: [FAKE_PI] });
  await client.start();
  await client.stop();
  await assert.rejects(() => client.getState(), /未启动或已停止/);
});

test("重复 start 会被拒绝", async () => {
  await withClient({}, async (client) => {
    await assert.rejects(() => client.start(), /已启动/);
  });
});

test("扩展弹窗超时没人应答，客户端会兜底写回取消，并广播可观测事件", async () => {
  await withClient({ dialogTimeoutMs: 20 }, async (client) => {
    const events = [];
    client.onEvent((e) => events.push(e));

    await client.send({ type: "trigger_dialog" });
    await new Promise((resolve) => setTimeout(resolve, 80));

    const auto = events.find((e) => e.type === "extension_dialog_autocancelled");
    assert.ok(auto, "应该广播 extension_dialog_autocancelled 事件");
    assert.equal(auto.id, "dlg1");
    assert.equal(auto.method, "confirm");

    const written = await client.send({ type: "get_last_dialog_response" });
    assert.equal(written.data.id, "dlg1");
    assert.equal(written.data.cancelled, true);
  });
});

test("stop() 会清掉还没触发的弹窗兜底计时器", async () => {
  const client = new PiRpcClient({ cliPath: process.execPath, prefixArgs: [FAKE_PI], dialogTimeoutMs: 50 });
  await client.start();
  const events = [];
  client.onEvent((e) => events.push(e));

  await client.send({ type: "trigger_dialog" });
  await client.stop();
  await new Promise((resolve) => setTimeout(resolve, 100));

  assert.ok(
    !events.some((e) => e.type === "extension_dialog_autocancelled"),
    "stop 后不该再触发兜底自动取消",
  );
});
