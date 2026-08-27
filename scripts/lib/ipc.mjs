/**
 * 客户端 ↔ 守护进程的通信。
 *
 * 每个 slash 命令都是一次全新的 node 进程，而常驻 agent 必须活过这次调用，
 * 所以真正持有 pi 子进程的是一个后台守护进程，CLI 只是它的瘦客户端。
 *
 * 协议：连上后写一行 JSON 请求，读一行 JSON 响应，然后关闭。
 */
import net from "node:net";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, unlinkSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { platform } from "node:process";
import { STATE_DIR } from "./config.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

export const PID_PATH = join(STATE_DIR, "daemon.pid");
export const LOG_PATH = join(STATE_DIR, "daemon.log");

/** Windows 上 unix socket 不可用，退回具名管道。 */
export function socketPath() {
  if (platform === "win32") return "\\\\.\\pipe\\claude-pi-plugin";
  return join(STATE_DIR, "daemon.sock");
}

export function ensureStateDir() {
  mkdirSync(STATE_DIR, { recursive: true });
}

/** 单次请求-响应。连不上时抛出带 code 的错误，供上层决定是否拉起守护进程。 */
export function requestOnce(payload, { timeoutMs = 300_000 } = {}) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(socketPath());
    let buffer = "";
    let settled = false;

    const finish = (fn, arg) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      fn(arg);
    };

    const timer = setTimeout(
      () => finish(reject, new Error(`守护进程响应超时（${timeoutMs}ms）`)),
      timeoutMs,
    );

    socket.setEncoding("utf8");
    socket.on("connect", () => socket.write(JSON.stringify(payload) + "\n"));
    socket.on("data", (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline === -1) return;
      try {
        finish(resolve, JSON.parse(buffer.slice(0, newline)));
      } catch (err) {
        finish(reject, new Error(`守护进程返回了无法解析的内容：${err.message}`));
      }
    });
    socket.on("error", (err) => finish(reject, err));
    socket.on("close", () => finish(reject, new Error("守护进程提前关闭了连接")));
  });
}

function isDaemonAlive() {
  if (!existsSync(PID_PATH)) return false;
  const pid = Number.parseInt(readFileSync(PID_PATH, "utf8").trim(), 10);
  if (!Number.isInteger(pid)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** 清掉上次异常退出留下的 socket 残骸，否则新守护进程 listen 会 EADDRINUSE。 */
function clearStaleSocket() {
  if (platform === "win32") return;
  const path = socketPath();
  if (existsSync(path) && !isDaemonAlive()) {
    try {
      unlinkSync(path);
    } catch {
      /* 竞态下已被别人删掉，无妨 */
    }
  }
}

function spawnDaemon() {
  ensureStateDir();
  clearStaleSocket();
  const child = spawn(process.execPath, [join(HERE, "daemon.mjs")], {
    detached: true,
    stdio: "ignore",
    env: process.env,
  });
  child.unref();
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 发请求；守护进程没起来就先拉起再重试。
 */
export async function request(payload, options = {}) {
  ensureStateDir();
  try {
    return await requestOnce(payload, options);
  } catch (err) {
    if (!["ENOENT", "ECONNREFUSED"].includes(err.code)) throw err;
  }

  spawnDaemon();

  // 守护进程要跑起来并 listen，给它一点时间；每次重试都真的去连一次。
  let lastError;
  for (let attempt = 0; attempt < 50; attempt++) {
    await sleep(100);
    try {
      return await requestOnce(payload, options);
    } catch (err) {
      if (!["ENOENT", "ECONNREFUSED"].includes(err.code)) throw err;
      lastError = err;
    }
  }
  throw new Error(
    `无法连接 pi 守护进程（已重试 5s）。可查看日志：${LOG_PATH}\n最后错误：${lastError?.message ?? "未知"}`,
  );
}
