#!/usr/bin/env node
/**
 * pi 常驻 agent 守护进程。
 *
 * 持有一组 `pi --mode rpc` 子进程，让它们活过单次 slash 命令调用。
 * 由 ipc.mjs 按需拉起，长时间无 agent 且无请求时自行退场。
 */
import net from "node:net";
import { existsSync, unlinkSync, writeFileSync, appendFileSync } from "node:fs";
import { platform } from "node:process";
import { PiRpcClient } from "./rpc-client.mjs";
import { loadConfig, resolveAuthEnv, resolveAgentOptions } from "./config.mjs";
import { socketPath, ensureStateDir, PID_PATH, LOG_PATH } from "./ipc.mjs";

const config = loadConfig();
/** @type {Map<string, {client: PiRpcClient, info: object}>} */
const agents = new Map();

let idleTimer = null;

function log(message) {
  try {
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

async function spawnAgent({ id, cwd, provider, model, thinkingLevel, initialPrompt }) {
  if (agents.has(id)) throw new Error(`agent "${id}" 已存在`);
  if (agents.size >= config.limits.maxConcurrentAgents) {
    throw new Error(`并发 agent 数已达上限（${config.limits.maxConcurrentAgents}）`);
  }

  const resolved = resolveAgentOptions(config, { provider, model, thinkingLevel });
  const client = new PiRpcClient({
    cwd,
    provider: resolved.provider,
    model: resolved.model,
    env: resolveAuthEnv(resolved.provider, config),
    session: true,
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
    info.lastActivityAt = new Date().toISOString();
  });

  // 子进程意外死亡时把 agent 摘掉，别留一个连不上的僵尸条目。
  client.process?.once("exit", () => {
    if (agents.get(id)?.client === client) {
      log(`agent ${id} 的 pi 进程退出，已移除`);
      agents.delete(id);
    }
  });

  agents.set(id, { client, info });

  let reply;
  if (initialPrompt) {
    reply = await client.ask(initialPrompt, config.limits.defaultTimeoutMs);
  }
  return { info, reply };
}

async function stopAgent(id) {
  const agent = agents.get(id);
  if (!agent) return false;
  agents.delete(id);
  await agent.client.stop();
  return true;
}

// ------------------------------------------------------------------ 请求分发

const handlers = {
  ping: () => ({ pid: process.pid, agents: agents.size }),

  spawn: (args) => spawnAgent(args),

  async send({ id, message, wait = true, timeoutMs }) {
    const { client, info } = requireAgent(id);
    if (!wait) {
      await client.prompt(message);
      return { id, queued: true };
    }
    const reply = await client.ask(message, timeoutMs ?? config.limits.defaultTimeoutMs);
    return { id, reply, model: info.model };
  },

  async steer({ id, message }) {
    await requireAgent(id).client.steer(message);
    return { id, steered: true };
  },

  async state({ id }) {
    const { client, info } = requireAgent(id);
    return { info, state: await client.getState() };
  },

  async bash({ id, command }) {
    return { id, result: await requireAgent(id).client.bash(command) };
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

async function handle(payload) {
  const handler = handlers[payload?.cmd];
  if (!handler) throw new Error(`未知指令：${payload?.cmd}`);
  return handler(payload.args ?? {});
}

// ------------------------------------------------------------------ 服务器

const server = net.createServer((socket) => {
  resetIdleTimer();
  socket.setEncoding("utf8");

  let buffer = "";
  socket.on("data", async (chunk) => {
    buffer += chunk;
    const newline = buffer.indexOf("\n");
    if (newline === -1) return;

    const line = buffer.slice(0, newline);
    buffer = "";

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
    for (const path of [PID_PATH, platform === "win32" ? null : socketPath()]) {
      if (path && existsSync(path)) {
        try {
          unlinkSync(path);
        } catch {
          /* 已被清掉 */
        }
      }
    }
    process.exit(code);
  });
}

ensureStateDir();
if (platform !== "win32" && existsSync(socketPath())) {
  try {
    unlinkSync(socketPath());
  } catch {
    /* 让下面的 listen 报错更具体 */
  }
}

server.listen(socketPath(), () => {
  writeFileSync(PID_PATH, String(process.pid));
  log(`守护进程已启动，pid=${process.pid}，socket=${socketPath()}`);
  resetIdleTimer();
});

server.on("error", (err) => {
  log(`守护进程启动失败：${err.message}`);
  process.exit(1);
});

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => shutdown(0));
}
