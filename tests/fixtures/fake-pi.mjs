#!/usr/bin/env node
/**
 * 假的 pi RPC 端，供测试用。
 * 只实现协议里被客户端依赖的那几条，行为可预测，不联网。
 */
import { createLineSplitter, serializeLine } from "../../scripts/lib/jsonl.mjs";

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
};

// 把收到的启动参数回显出来，测试据此断言参数拼装是否正确。
const state = {
  model: { provider: flag("--provider") ?? "fake", id: flag("--model") ?? "fake-1", contextWindow: 1000, reasoning: false },
  thinkingLevel: "medium",
  isStreaming: false,
  isCompacting: false,
  steeringMode: "all",
  followUpMode: "all",
  sessionId: "fake-session",
  sessionFile: args.includes("--no-session") ? undefined : "/tmp/fake.jsonl",
  noExtensions: args.includes("--no-extensions"),
  autoCompactionEnabled: true,
  messageCount: 0,
  pendingMessageCount: 0,
};

let lastText = null;

const write = (obj) => process.stdout.write(serializeLine(obj));
const respond = (id, command, data) => write({ id, type: "response", command, success: true, ...(data !== undefined ? { data } : {}) });

const split = createLineSplitter();
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  for (const line of split(chunk)) {
    const cmd = JSON.parse(line);
    switch (cmd.type) {
      case "get_state":
        respond(cmd.id, "get_state", state);
        break;
      case "set_thinking_level":
        state.thinkingLevel = cmd.level;
        respond(cmd.id, "set_thinking_level");
        break;
      case "prompt":
        respond(cmd.id, "prompt");
        lastText = `收到：${cmd.message}`;
        state.messageCount += 2;
        // 模拟真实 pi：先流式事件，agent_end 之后还会有 agent_settled。
        write({ type: "agent_start" });
        write({ type: "message_update", message: { role: "assistant", content: [] } });
        write({ type: "agent_end", messages: [] });
        write({ type: "agent_settled" });
        break;
      case "steer":
        respond(cmd.id, "steer");
        break;
      case "get_last_assistant_text":
        respond(cmd.id, "get_last_assistant_text", { text: lastText });
        break;
      case "bash":
        respond(cmd.id, "bash", { output: `ran: ${cmd.command}`, exitCode: 0, cancelled: false, truncated: false });
        break;
      case "explode":
        write({ id: cmd.id, type: "response", command: "explode", success: false, error: "故意失败" });
        break;
      default:
        write({ id: cmd.id, type: "response", command: cmd.type, success: false, error: `未实现：${cmd.type}` });
    }
  }
});
