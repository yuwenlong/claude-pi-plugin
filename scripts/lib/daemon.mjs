#!/usr/bin/env node
/**
 * pi 常驻 agent 守护进程。
 *
 * 持有一组 `pi --mode rpc` 子进程，让它们活过单次 slash 命令调用。
 * 由 ipc.mjs 按需拉起，长时间无 agent 且无请求时自行退场。
 */
import net from "node:net";
import { existsSync, unlinkSync, writeFileSync, appendFileSync, readFileSync, statSync, renameSync } from "node:fs";
import { platform } from "node:process";
import { pathToFileURL } from "node:url";
import { PiRpcClient } from "./rpc-client.mjs";
import { loadConfig, resolveAuthEnv, resolveAgentOptions } from "./config.mjs";
import { socketPath, ensureStateDir, PID_PATH, LOG_PATH } from "./ipc.mjs";
import { createQueue, enqueue } from "./serial-queue.mjs";
import { createLineSplitter } from "./jsonl.mjs";

const config = loadConfig();
/** @type {Map<string, {client: PiRpcClient, info: object, queue: object}>} */
const agents = new Map();

let idleTimer = null;

/** 只 append 不轮转，日志会一直长下去；到这个大小就滚一份，历史只留最近一份。 */
const LOG_MAX_BYTES = 1_000_000;

function log(message) {
  try {
    if (existsSync(LOG_PATH) && statSync(LOG_PATH).size > LOG_MAX_BYTES) {
      if (existsSync(`${LOG_PATH}.1`)) unlinkSync(`${LOG_PATH}.1`);
      renameSync(LOG_PATH, `${LOG_PATH}.1`);
    }
    appendFileSync(LOG_PATH, `${new Date().toISOString()} ${message}\n`);
  } catch {
    /* 日志写不进去不该影响主流程 */
  }
}

// ------------------------------------------------------------------ 空闲退场

function resetIdleTimer() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    if (agents.size > 0) return resetIdleTimer();
    log("空闲超时，守护进程退出");
    shutdown(0);
  }, config.limits.daemonIdleTimeoutMs);
  idleTimer.unref?.();
}

// ------------------------------------------------------------------ agent 操作

function requireAgent(id) {
  const agent = agents.get(id);
  if (!agent) {
    const known = [...agents.keys()];
    throw new Error(
      known.length
        ? `没有名为 "${id}" 的 agent。当前在跑的是：${known.join(", ")}`
        : `没有名为 "${id}" 的 agent，当前没有任何常驻 agent。`,
    );
  }
  return agent;
}

/** 造一个 pi 客户端。测试用 setClientFactory 换成协议桩，生产走真实实现。 */
let createClient = (options) => new PiRpcClient(options);

export function setClientFactory(factory) {
  createClient = factory;
}

async function spawnAgent({ id, cwd, provider, model, thinkingLevel, initialPrompt, extensions }) {
  if (agents.has(id)) throw new Error(`agent "${id}" 已存在`);
  if (agents.size >= config.limits.maxConcurrentAgents) {
    throw new Error(`并发 agent 数已达上限（${config.limits.maxConcurrentAgents}）`);
  }

  const resolved = resolveAgentOptions(config, { provider, model, thinkingLevel });
  const client = createClient({
    cwd,
    provider: resolved.provider,
    model: resolved.model,
    env: resolveAuthEnv(resolved.provider, config),
    session: true,
    extensions: extensions === false ? false : undefined,
    dialogTimeoutMs: config.limits.extensionDialogTimeoutMs,
  });

  await client.start();
  if (resolved.thinkingLevel) {
    // 部分模型不支持思考级别，设置失败不该让 spawn 整体失败。
    try {
      await client.setThinkingLevel(resolved.thinkingLevel);
    } catch (err) {
      log(`agent ${id} 设置 thinkingLevel 失败：${err.message}`);
    }
  }

  const state = await client.getState().catch(() => null);
  const info = {
    id,
    cwd,
    provider: state?.model?.provider ?? resolved.provider ?? "(pi 默认)",
    model: state?.model?.id ?? resolved.model ?? "(pi 默认)",
    thinkingLevel: state?.thinkingLevel ?? resolved.thinkingLevel,
    status: "idle",
    startedAt: new Date().toISOString(),
    lastActivityAt: new Date().toISOString(),
    turns: 0,
  };

  client.onEvent((event) => {
    if (event?.type === "agent_start") info.status = "busy";
    if (event?.type === "agent_end") {
      info.status = "idle";
      info.turns += 1;
    }
    if (event?.type === "extension_dialog_autocancelled") {
      log(`agent ${id} 有个扩展弹窗（${event.method}${event.title ? `：${event.title}` : ""}）没人应答，已兜底自动取消`);
    }
    info.lastActivityAt = new Date().toISOString();
  });

  // 子进程意外死亡时把 agent 摘掉，别留一个连不上的僵尸条目。
  client.process?.once("exit", () => {
    if (agents.get(id)?.client === client) {
      log(`agent ${id} 的 pi 进程退出，已移除`);
      agents.delete(id);
    }
  });

  const agent = { client, info, queue: createQueue() };
  agents.set(id, agent);

  let reply;
  let initialError;
  if (initialPrompt) {
    try {
      reply = await enqueue(agent.queue, () => client.ask(initialPrompt, config.limits.defaultTimeoutMs));
    } catch (err) {
      // agent 本身已经起来了，首轮任务失败不该连它一起判死：报就绪并带上错误，
      // 免得调用方以为没起来、换个名字重开，白白扔掉一个能用的 agent。
      initialError = err.message;
      log(`agent ${id} 首轮任务失败：${err.message}`);
    }
  }
  return { info, reply, initialError };
}

async function stopAgent(id) {
  const agent = agents.get(id);
  if (!agent) return false;
  agents.delete(id);
  await agent.client.stop();
  return true;
}

// ------------------------------------------------------------------ 请求分发

export const handlers = {
  ping: () => ({ pid: process.pid, agents: agents.size }),

  spawn: (args) => spawnAgent(args),

  async send({ id, message, wait = true, timeoutMs }) {
    const agent = requireAgent(id);
    // 排队而不是直接发：前一轮没落地就开口，等待者会被上一轮的 agent_end 提前唤醒，
    // 拿回上一轮的答案（见 serial-queue.mjs）。
    const turn = enqueue(agent.queue, () =>
      agent.client.ask(message, timeoutMs ?? config.limits.defaultTimeoutMs),
    );
    if (!wait) {
      // 只投递不等结果，但仍要占住队列里的位置，保证后来者排在它后面。
      turn.catch((err) => log(`agent ${id} 排队中的任务失败：${err.message}`));
      return { id, queued: true };
    }
    return { id, reply: await turn, model: agent.info.model };
  },

  async steer({ id, message }) {
    await requireAgent(id).client.steer(message);
    return { id, steered: true };
  },

  async abort({ id }) {
    await requireAgent(id).client.abort();
    return { id, aborted: true };
  },

  async state({ id }) {
    const { client, info } = requireAgent(id);
    return { info, state: await client.getState() };
  },

  async bash({ id, command, timeoutMs }) {
    const result = await requireAgent(id).client.bash(command, timeoutMs ?? config.limits.defaultTimeoutMs);
    return { id, result };
  },

  list: () => ({ agents: [...agents.values()].map((a) => ({ ...a.info })) }),

  async stop({ id, all }) {
    if (all) {
      const ids = [...agents.keys()];
      await Promise.all(ids.map(stopAgent));
      return { stopped: ids };
    }
    const ok = await stopAgent(id);
    if (!ok) throw new Error(`没有名为 "${id}" 的 agent`);
    return { stopped: [id] };
  },

  async shutdown() {
    setTimeout(() => shutdown(0), 50).unref?.();
    return { shuttingDown: true };
  },
};

export async function handle(payload) {
  const cmd = payload?.cmd;
  // 认自有属性，别让 `toString`、`constructor` 这类原型链上的成员冒充成指令。
  if (!Object.hasOwn(handlers, cmd)) throw new Error(`未知指令：${cmd}`);
  return handlers[cmd](payload.args ?? {});
}

// ------------------------------------------------------------------ 服务器

const server = net.createServer((socket) => {
  resetIdleTimer();
  socket.setEncoding("utf8");

  // 与 pi 那侧共用同一个分帧器。协议是一请求一响应，但别靠「一个 chunk 正好一整行」
  // 这种假设吃饭：请求分片到达时照样能拼回来。
  const split = createLineSplitter();
  let handled = false;
  socket.on("data", async (chunk) => {
    const [line] = split(chunk);
    if (!line || handled) return;
    handled = true;

    let response;
    try {
      response = { ok: true, data: await handle(JSON.parse(line)) };
    } catch (err) {
      response = { ok: false, error: err?.message ?? String(err) };
    }
    resetIdleTimer();
    socket.end(JSON.stringify(response) + "\n");
  });

  socket.on("error", (err) => log(`连接出错：${err.message}`));
});

let shuttingDown = false;
function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  const clients = [...agents.values()];
  agents.clear();
  Promise.allSettled(clients.map((a) => a.client.stop())).finally(() => {
    server.close();
    releasePidFile();
    removeStaleSocketFile();
    process.exit(code);
  });
}

// ------------------------------------------------------------------ 启动

/** PID 文件里记的是不是另一个还活着的守护进程。 */
function anotherDaemonAlive() {
  if (!existsSync(PID_PATH)) return false;
  try {
    const pid = Number.parseInt(readFileSync(PID_PATH, "utf8").trim(), 10);
    if (!Number.isInteger(pid) || pid === process.pid) return false;
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** 只清理属于自己的 PID 文件，别把接班进程写的那份误删了。 */
function releasePidFile() {
  try {
    if (readFileSync(PID_PATH, "utf8").trim() === String(process.pid)) unlinkSync(PID_PATH);
  } catch {
    /* 文件不在，或已被接管 */
  }
}

/** Windows 的具名管道随进程走，不留文件；unix 才需要清 socket 残骸。 */
function removeStaleSocketFile() {
  if (platform === "win32" || !existsSync(socketPath())) return;
  try {
    unlinkSync(socketPath());
  } catch {
    /* 已被清掉 */
  }
}

export function start() {
  ensureStateDir();

  // unix 上 listen 会顶替掉现有的 socket 文件，把在跑的守护进程手里的 agent 全变成
  // 连不上的孤儿。所以先判活：已经有人在岗就让位，让调用方去连它。
  if (anotherDaemonAlive()) {
    log("已有守护进程在跑，本进程让位退出");
    process.exit(0);
  }

  // 先占住 PID 文件再 listen，把「判活 → 接管 socket」之间的窗口压到最小；
  // listen 失败时在 error 处理里退还。
  writeFileSync(PID_PATH, String(process.pid));
  removeStaleSocketFile();

  server.listen(socketPath(), () => {
    log(`守护进程已启动，pid=${process.pid}，socket=${socketPath()}`);
    resetIdleTimer();
  });

  server.on("error", (err) => {
    log(`守护进程启动失败：${err.message}`);
    releasePidFile();
    process.exit(1);
  });

  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    process.on(signal, () => shutdown(0));
  }
}

// 只有被直接执行时才开张；被测试 import 时保持安静（同 pi-agent.mjs 的做法）。
const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) start();
