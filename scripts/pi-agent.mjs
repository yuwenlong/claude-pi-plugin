#!/usr/bin/env node
/**
 * claude-pi-plugin 的 CLI 入口。
 *
 * 所有 slash 命令都落到这里。一次性问答（ask）直连 pi，用完即走；
 * 常驻 agent 相关的子命令转交后台守护进程，因为它们要活过单次调用。
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { PiRpcClient } from "./lib/rpc-client.mjs";
import { loadConfig, resolveAuthEnv, resolveAgentOptions, CONFIG_PATH } from "./lib/config.mjs";
import { request, LOG_PATH } from "./lib/ipc.mjs";
import { parseArgs, joinText, parseTimeout, applyStdin } from "./lib/args.mjs";

const USAGE = `用法：pi-agent <子命令> [选项] [--] <文本>

子命令
  ask   <问题>                 一次性问答，问完就退（不占用常驻 agent）
  spawn <名字> [初始任务]       拉起一个常驻 pi agent
  send  <名字> <消息>           给常驻 agent 发消息并等结果
  steer <名字> <消息>           在 agent 干活途中插话纠偏
  abort <名字>                 打断 agent 当前这一轮
  list                         列出所有常驻 agent
  state <名字>                 查看某个 agent 的详细状态
  bash  <名字> <命令>           借 agent 的 shell 执行命令
  stop  <名字> | --all         停掉 agent
  doctor                       环境自检

选项
  --provider <名>   指定 provider（默认跟随 pi 自己的设置）
  --model <名>      指定模型
  --thinking <级别> off|minimal|low|medium|high|xhigh
  --cwd <目录>      agent 的工作目录（默认当前目录）
  --timeout <毫秒>  等待上限（默认 180000）
  --no-wait         send 时只投递不等结果
  --full            ask 时加载 pi 扩展（默认不加载，省约 0.8s 冷启动）
  --no-extensions   spawn 时不加载 pi 扩展。给纯实施型 agent 用：既省冷启动，
                    也从源头避免扩展弹出未设超时的确认框把这一轮卡死
  --json            输出原始 JSON
  --stdin           位置参数改从标准输入读取（slash 命令用它绕开 shell 引号问题）`;

// ------------------------------------------------------------------ 输出helper

function out(text) {
  process.stdout.write(text.endsWith("\n") ? text : text + "\n");
}

function fail(message) {
  process.stderr.write(`✗ ${message}\n`);
  process.exit(1);
}

function formatAgentRow(a) {
  const flag = a.status === "busy" ? "●" : "○";
  return `${flag} ${a.id}  [${a.status}]  ${a.provider}/${a.model}  轮次:${a.turns}  目录:${a.cwd}`;
}

// ------------------------------------------------------------------ 守护进程调用

async function callDaemon(cmd, args, timeoutMs) {
  const response = await request({ cmd, args }, timeoutMs ? { timeoutMs: timeoutMs + 30_000 } : {});
  if (!response.ok) throw new Error(response.error);
  return response.data;
}

// ------------------------------------------------------------------ 子命令

async function cmdAsk(options, positional) {
  const question = joinText(positional);
  if (!question) fail("请给出要问的内容，例如：pi-agent ask -- 你是什么大模型？");

  const config = loadConfig();
  const timeoutMs = parseTimeout(options.timeout, config.limits.defaultTimeoutMs);
  const resolved = resolveAgentOptions(config, {
    provider: options.provider,
    model: options.model,
    thinkingLevel: options.thinking,
  });

  const client = new PiRpcClient({
    cwd: options.cwd ?? process.cwd(),
    provider: resolved.provider,
    model: resolved.model,
    env: resolveAuthEnv(resolved.provider, config),
    session: false, // 一次性问答不落盘，免得污染 `pi -r` 的会话列表
    // 问一句话用不上扩展，省下大半冷启动时间；要完整能力就传 --full。
    extensions: options.full ? undefined : false,
    dialogTimeoutMs: config.limits.extensionDialogTimeoutMs,
  });

  try {
    await client.start();
    if (resolved.thinkingLevel) {
      await client.setThinkingLevel(resolved.thinkingLevel).catch(() => {});
    }
    const state = client.initialState; // start() 握手时已经拿到，不必再问一次
    const reply = await client.ask(question, timeoutMs);

    if (options.json) return out(JSON.stringify({ question, reply, state }, null, 2));

    const model = state?.model ? `${state.model.provider}/${state.model.id}` : "pi 默认模型";
    out(`【pi · ${model}】\n${reply || "(pi 没有返回文本)"}`);
  } finally {
    await client.stop();
  }
}

async function cmdSpawn(options, positional) {
  const [id, ...rest] = positional;
  if (!id) fail("请给 agent 起个名字，例如：pi-agent spawn worker");

  const data = await callDaemon("spawn", {
    id,
    cwd: options.cwd ?? process.cwd(),
    provider: options.provider,
    model: options.model,
    thinkingLevel: options.thinking,
    initialPrompt: joinText(rest) || undefined,
    extensions: options["no-extensions"] ? false : undefined,
  });

  if (options.json) return out(JSON.stringify(data, null, 2));
  out(`✓ agent "${id}" 已就绪（${data.info.provider}/${data.info.model}，目录 ${data.info.cwd}）`);
  if (data.reply) out(`\n【${id} 的回复】\n${data.reply}`);
}

async function cmdSend(options, positional) {
  const [id, ...rest] = positional;
  const message = joinText(rest);
  if (!id || !message) fail("用法：pi-agent send <名字> -- <消息>");

  const config = loadConfig();
  const timeoutMs = parseTimeout(options.timeout, config.limits.defaultTimeoutMs);
  const data = await callDaemon("send", { id, message, wait: !options["no-wait"], timeoutMs }, timeoutMs);

  if (options.json) return out(JSON.stringify(data, null, 2));
  if (data.queued) return out(`✓ 消息已投递给 "${id}"，用 /claude-pi:list 查看进度`);
  out(`【${id} · ${data.model}】\n${data.reply || "(pi 没有返回文本)"}`);
}

async function cmdSteer(options, positional) {
  const [id, ...rest] = positional;
  const message = joinText(rest);
  if (!id || !message) fail("用法：pi-agent steer <名字> -- <消息>");
  await callDaemon("steer", { id, message });
  out(`✓ 已向 "${id}" 插话：${message}`);
}

async function cmdAbort(options, positional) {
  const [id] = positional;
  if (!id) fail("用法：pi-agent abort <名字>");
  await callDaemon("abort", { id });
  out(`✓ 已打断 "${id}" 当前这一轮`);
}

async function cmdList(options) {
  const { agents } = await callDaemon("list");
  if (options.json) return out(JSON.stringify(agents, null, 2));
  if (!agents.length) return out("当前没有常驻 pi agent。用 /claude-pi:spawn <名字> 拉起一个。");
  out(`常驻 pi agent（${agents.length}）：\n` + agents.map(formatAgentRow).join("\n"));
}

async function cmdState(options, positional) {
  const [id] = positional;
  if (!id) fail("用法：pi-agent state <名字>");
  const data = await callDaemon("state", { id });
  if (options.json) return out(JSON.stringify(data, null, 2));

  const { info, state } = data;
  out(
    [
      `agent: ${info.id}`,
      `状态: ${info.status}${state.isStreaming ? "（正在输出）" : ""}`,
      `模型: ${state.model ? `${state.model.provider}/${state.model.id}` : info.model}`,
      `思考级别: ${state.thinkingLevel}`,
      `目录: ${info.cwd}`,
      `消息数: ${state.messageCount}（待处理 ${state.pendingMessageCount}）`,
      `完成轮次: ${info.turns}`,
      `启动于: ${info.startedAt}`,
      `会话文件: ${state.sessionFile ?? "(未落盘)"}`,
    ].join("\n"),
  );
}

async function cmdBash(options, positional) {
  const [id, ...rest] = positional;
  const command = joinText(rest);
  if (!id || !command) fail("用法：pi-agent bash <名字> -- <命令>");

  const { result } = await callDaemon("bash", { id, command });
  if (options.json) return out(JSON.stringify(result, null, 2));
  out(`$ ${command}\n退出码: ${result.exitCode}${result.truncated ? "（输出已截断）" : ""}\n${result.output}`);
}

async function cmdStop(options, positional) {
  const [id] = positional;
  if (!options.all && !id) fail("用法：pi-agent stop <名字>，或 pi-agent stop --all");
  const { stopped } = await callDaemon("stop", { id, all: Boolean(options.all) });
  out(stopped.length ? `✓ 已停止：${stopped.join(", ")}` : "没有需要停止的 agent。");
}

async function cmdDoctor() {
  const lines = [];

  try {
    const version =
      process.platform === "win32"
        ? execFileSync("cmd.exe", ["/d", "/s", "/c", "pi", "--version"], { encoding: "utf8" }).trim()
        : execFileSync("pi", ["--version"], { encoding: "utf8" }).trim();
    lines.push(`✓ pi CLI: ${version}`);
  } catch {
    lines.push("✗ 找不到 pi CLI，请先安装：npm install -g @earendil-works/pi-coding-agent");
  }

  lines.push(`✓ Node: ${process.version}`);
  lines.push(existsSync(CONFIG_PATH) ? `✓ 插件配置: ${CONFIG_PATH}` : `· 插件配置: 未创建（走 pi 自身默认值即可）`);

  try {
    const { pid, agents } = await callDaemon("ping");
    lines.push(`✓ 守护进程: 运行中（pid=${pid}，常驻 agent ${agents} 个）`);
  } catch (err) {
    lines.push(`· 守护进程: 未运行（首次使用常驻 agent 时会自动拉起）—— ${err.message}`);
  }

  lines.push(`· 守护进程日志: ${LOG_PATH}`);
  out(lines.join("\n"));
}

// ------------------------------------------------------------------ 分发

const COMMANDS = {
  ask: { handler: cmdAsk, stdin: "text" },
  spawn: { handler: cmdSpawn, stdin: "id+text" },
  send: { handler: cmdSend, stdin: "id+text" },
  steer: { handler: cmdSteer, stdin: "id+text" },
  abort: { handler: cmdAbort, stdin: "id" },
  bash: { handler: cmdBash, stdin: "id+text" },
  state: { handler: cmdState, stdin: "id" },
  stop: { handler: cmdStop, stdin: "id" },
  list: { handler: cmdList, stdin: "none" },
  doctor: { handler: cmdDoctor, stdin: "none" },
};

async function readStdin() {
  if (process.stdin.isTTY) return "";
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

export async function run(argv) {
  const [name, ...rest] = argv;
  if (!name || name === "help" || name === "--help") return out(USAGE);

  const command = COMMANDS[name];
  if (!command) fail(`未知子命令 "${name}"。\n\n${USAGE}`);

  const { options, positional } = parseArgs(rest);
  if (options.help) return out(USAGE);

  const args = options.stdin
    ? applyStdin(command.stdin, await readStdin(), positional)
    : positional;

  await command.handler(options, args);
}

// 只有被直接执行时才跑；被测试 import 时保持安静。
const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  run(process.argv.slice(2)).catch((err) => fail(err?.message ?? String(err)));
}
