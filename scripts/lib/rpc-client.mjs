/**
 * pi RPC 客户端。
 *
 * 拉起 `pi --mode rpc` 子进程，用 JSONL 与之对话：
 *   - 带 id 的命令会收到 { type: "response", id, ... }
 *   - 其余行是流式事件（agent_start / message_update / agent_end / ...）
 *
 * 只依赖 node 内置模块，插件安装后无需任何 npm install。
 */
import { spawn } from "node:child_process";
import { attachLineReader, serializeLine } from "./jsonl.mjs";

/** 单条命令等待响应的上限。prompt 只是「收下了」，真正的等待由 waitForIdle 负责。 */
const COMMAND_TIMEOUT_MS = 30_000;
/** 启动握手上限：靠一次 get_state 探活，比固定 sleep 更可靠。 */
const HANDSHAKE_TIMEOUT_MS = 30_000;
/**
 * 扩展弹窗（confirm/select/input/editor）兜底应答上限。我们是无人值守的 headless 客户端，
 * 扩展若没给 `ui.confirm()` 等调用传自己的 timeout，pi 会一直挂着等 `extension_ui_response`——
 * 到点没人答就自动回"取消"，避免这一轮永久挂起。
 */
const DEFAULT_DIALOG_TIMEOUT_MS = 30_000;
/** pi 侧会挂起等响应的扩展 UI 方法；notify/setStatus/setWidget/setTitle 等是 fire-and-forget，不用管。 */
const DIALOG_METHODS_NEEDING_RESPONSE = new Set(["confirm", "select", "input", "editor"]);

export class PiRpcClient {
  /**
   * @param {{
   *   cliPath?: string, cwd?: string, env?: Record<string,string>,
   *   provider?: string, model?: string, session?: boolean, extensions?: boolean,
   *   dialogTimeoutMs?: number, prefixArgs?: string[], extraArgs?: string[]
   * }} options
   *
   * prefixArgs 排在 `--mode rpc` 之前，测试用它把 cliPath 指向 node、再传入桩脚本路径。
   */
  constructor(options = {}) {
    this.options = options;
    this.process = null;
    this.detachStdout = null;
    this.listeners = new Set();
    this.pending = new Map();
    this.seq = 0;
    this.stderr = "";
    this.exited = null; // { code, signal }
    /** start() 的握手顺带拿回的会话状态，省掉调用方再问一次。 */
    this.initialState = null;
    /** 未应答的扩展弹窗兜底计时器：extension_ui_request.id -> Timeout */
    this.pendingDialogs = new Map();
    /** 正在等 agent_end 的人。他们不在 pending 里，进程死掉时得由 #fail 单独叫醒。 */
    this.idleWaiters = new Set();
    this.dialogTimeoutMs = options.dialogTimeoutMs ?? DEFAULT_DIALOG_TIMEOUT_MS;
  }

  // ---------------------------------------------------------------- 生命周期

  async start() {
    if (this.process) throw new Error("客户端已启动");

    const args = [...(this.options.prefixArgs ?? []), "--mode", "rpc"];
    if (this.options.provider) args.push("--provider", this.options.provider);
    if (this.options.model) args.push("--model", this.options.model);
    // 一次性问答不落 session，免得污染 `pi -r` 的会话列表；常驻 agent 则保留。
    if (this.options.session === false) args.push("--no-session");
    // 加载扩展占了 pi 冷启动的大头（实测 1.2s → 0.4s）。一次性问答用不上它们，
    // 常驻 agent 要真干活则照常加载。
    if (this.options.extensions === false) args.push("--no-extensions");
    if (this.options.extraArgs?.length) args.push(...this.options.extraArgs);

    const cli = this.options.cliPath ?? "pi";
    // Windows 的 npm 全局 bin 是 .cmd 垫片：CVE-2024-27980 之后 Node 直接 spawn 它会
    // ENOENT/EINVAL，必须经 cmd.exe。用 shell:true 会导致 args 不再逐个转义（DEP0190，
    // 带空格的路径会被拆散）；改成把 cmd.exe 本身当成目标程序、参数原样透传，Node 对
    // 非 shell 模式的参数仍会做标准 Windows 转义，两头都对。
    const [command, spawnArgs] =
      process.platform === "win32" ? ["cmd.exe", ["/d", "/s", "/c", cli, ...args]] : [cli, args];

    this.process = spawn(command, spawnArgs, {
      cwd: this.options.cwd,
      env: { ...process.env, ...this.options.env },
      stdio: ["pipe", "pipe", "pipe"],
      // 守护进程是 detached 起来的、自身没有 console，Windows 便会给 cmd.exe 这个
      // 控制台程序新开一个可见窗口（Win11 下由 Windows Terminal 承载），且 agent
      // 活多久它就杵多久。CREATE_NO_WINDOW 把它按住，stdio 仍走管道，不受影响。
      windowsHide: true,
    });

    this.process.on("error", (err) => this.#fail(new Error(`无法启动 pi：${err.message}`)));
    this.process.stderr.setEncoding("utf8");
    this.process.stderr.on("data", (text) => {
      // 只留尾部，避免长跑 agent 把内存吃光。
      this.stderr = (this.stderr + text).slice(-8192);
    });

    this.detachStdout = attachLineReader(this.process.stdout, (line) => this.#handleLine(line));

    this.process.on("exit", (code, signal) => {
      this.exited = { code, signal };
      this.#fail(new Error(`pi 进程已退出（code=${code} signal=${signal}）${this.#stderrTail()}`));
    });

    // 握手：等 pi 真正开始应答，再放行后续命令。顺手把状态留下，调用方就不必再问一次。
    const handshake = await this.send({ type: "get_state" }, HANDSHAKE_TIMEOUT_MS);
    this.initialState = handshake?.success === false ? null : (handshake?.data ?? null);
  }

  async stop() {
    const proc = this.process;
    if (!proc) return;

    this.detachStdout?.();
    this.detachStdout = null;
    this.process = null;

    if (proc.exitCode !== null) return;

    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        proc.kill("SIGKILL");
        resolve();
      }, 2000);
      proc.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
      proc.kill("SIGTERM");
    });

    this.pending.clear();
    for (const timer of this.pendingDialogs.values()) clearTimeout(timer);
    this.pendingDialogs.clear();
  }

  // ---------------------------------------------------------------- 事件订阅

  /** 订阅事件，返回退订函数。 */
  onEvent(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getStderr() {
    return this.stderr;
  }

  /**
   * 主动应答一次扩展弹窗（`confirm`/`select`/`input`/`editor`）。
   * 当前没有 UI 承载方，唯一调用方是内部的兜底超时；留成公开方法是给未来接入真实交互留口子。
   */
  respondToDialog(id, response) {
    const stdin = this.process?.stdin;
    if (!stdin) return;
    const timer = this.pendingDialogs.get(id);
    if (timer) {
      clearTimeout(timer);
      this.pendingDialogs.delete(id);
    }
    stdin.write(serializeLine({ type: "extension_ui_response", id, ...response }));
  }

  // ---------------------------------------------------------------- 命令封装

  async prompt(message) {
    await this.send({ type: "prompt", message });
  }

  async steer(message) {
    await this.send({ type: "steer", message });
  }

  async abort() {
    await this.send({ type: "abort" });
  }

  async getState() {
    return this.#data(await this.send({ type: "get_state" }));
  }

  async setThinkingLevel(level) {
    await this.send({ type: "set_thinking_level", level });
  }

  /** 跑一条 shell 命令。编译、测试动辄几分钟，所以超时由调用方给，不套用命令级的 30s。 */
  async bash(command, timeoutMs) {
    try {
      return this.#data(await this.send({ type: "bash", command }, timeoutMs));
    } catch (err) {
      // 与 waitForIdle 的超时同码：超时只代表「还没跑完」，不是失败，
      // 守护进程把 code 透传给 CLI，由它按「还在跑」收场。
      if (/^等待 bash 响应超时/.test(err.message)) err.code = "PI_TIMEOUT";
      throw err;
    }
  }

  async getLastAssistantText() {
    const data = this.#data(await this.send({ type: "get_last_assistant_text" }));
    return data?.text ?? null;
  }

  async getSessionStats() {
    return this.#data(await this.send({ type: "get_session_stats" }));
  }

  /** 等待本轮跑完（agent_end）。pi 之后还会发 agent_settled，不必等它。 */
  waitForIdle(timeoutMs = 180_000) {
    return new Promise((resolve, reject) => {
      const settle = (fn, arg) => {
        clearTimeout(timer);
        off();
        this.idleWaiters.delete(waiter);
        fn(arg);
      };

      const timer = setTimeout(() => {
        // 打上 code：守护进程把它透传给 CLI，send/bash 据此按「还在跑」而非失败收场。
        const err = new Error(`等待 pi 完成超时（${timeoutMs}ms）${this.#stderrTail()}`);
        err.code = "PI_TIMEOUT";
        settle(reject, err);
      }, timeoutMs);

      // 登记进来：pi 半路死了，agent_end 永远不会来，得由 #fail 立刻打回，
      // 而不是让调用方干等满整个超时、还拿到一句掩盖真实死因的「超时」。
      const waiter = { reject: (err) => settle(reject, err) };
      this.idleWaiters.add(waiter);

      const off = this.onEvent((event) => {
        if (event.type === "agent_end") settle(resolve);
      });
    });
  }

  /** 发一句话并等到跑完，返回最后一条助手文本。 */
  async ask(message, timeoutMs) {
    const idle = this.waitForIdle(timeoutMs);
    await this.prompt(message);
    await idle;
    return (await this.getLastAssistantText()) ?? "";
  }

  // ---------------------------------------------------------------- 内部实现

  send(command, timeoutMs = COMMAND_TIMEOUT_MS) {
    const stdin = this.process?.stdin;
    if (!stdin) return Promise.reject(new Error("客户端未启动或已停止"));

    const id = `req_${++this.seq}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`等待 ${command.type} 响应超时${this.#stderrTail()}`));
      }, timeoutMs);

      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      });

      stdin.write(serializeLine({ ...command, id }), (err) => {
        if (!err) return;
        this.pending.delete(id);
        clearTimeout(timer);
        reject(new Error(`写入 pi stdin 失败：${err.message}`));
      });
    });
  }

  #handleLine(line) {
    let payload;
    try {
      payload = JSON.parse(line);
    } catch {
      return; // 非 JSON 的噪声行直接丢弃
    }

    if (payload?.type === "response" && payload.id && this.pending.has(payload.id)) {
      const waiter = this.pending.get(payload.id);
      this.pending.delete(payload.id);
      waiter.resolve(payload);
      return;
    }

    if (payload?.type === "extension_ui_request") {
      this.#armDialogFallback(payload);
    }

    this.#emit(payload);
  }

  /** 分发给所有订阅者；供真实协议行、以及下面的兜底超时合成事件共用。 */
  #emit(payload) {
    for (const listener of [...this.listeners]) {
      try {
        listener(payload);
      } catch {
        // 监听器自身出错不该拖垮读取循环
      }
    }
  }

  /**
   * 对需要应答的扩展弹窗起一个兜底计时器：`dialogTimeoutMs` 内没人主动 `respondToDialog`，
   * 就自动回"取消"，防止扩展没传自己的 timeout 时把这一轮永久挂起。
   */
  #armDialogFallback(request) {
    if (!DIALOG_METHODS_NEEDING_RESPONSE.has(request.method)) return;
    const timer = setTimeout(() => {
      this.respondToDialog(request.id, { cancelled: true });
      this.#emit({
        type: "extension_dialog_autocancelled",
        id: request.id,
        method: request.method,
        title: request.title,
      });
    }, this.dialogTimeoutMs);
    timer.unref?.();
    this.pendingDialogs.set(request.id, timer);
  }

  /** 进程挂掉时，把所有在途请求和等待者一次性打回。 */
  #fail(error) {
    for (const waiter of this.pending.values()) waiter.reject(error);
    this.pending.clear();
    for (const waiter of [...this.idleWaiters]) waiter.reject(error);
    this.idleWaiters.clear();
  }

  #data(response) {
    if (response?.success === false) throw new Error(response.error ?? "pi 返回未知错误");
    return response?.data;
  }

  #stderrTail() {
    const tail = this.stderr.trim();
    return tail ? `\npi stderr: ${tail.slice(-1000)}` : "";
  }
}
