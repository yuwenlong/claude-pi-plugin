/**
 * JSONL 分帧工具。
 *
 * pi 的 RPC 模式以「一行一个 JSON」在 stdout 上说话，其中 message_update 事件
 * 会携带完整消息体，单行可达数百 KB，所以这里按缓冲区手工切分而非依赖 readline，
 * 避免行长与换行风格带来的意外。
 */

/**
 * 创建一个增量分帧器：喂入任意分片的字符串，吐出完整的行。
 * @returns {(chunk: string) => string[]}
 */
export function createLineSplitter() {
  let buffer = "";
  return (chunk) => {
    buffer += chunk;
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    return lines.map((line) => line.replace(/\r$/, "")).filter((line) => line.length > 0);
  };
}

/**
 * 把可读流按 JSONL 逐行交给回调，返回取消订阅函数。
 * @param {import("node:stream").Readable} stream
 * @param {(line: string) => void} onLine
 */
export function attachLineReader(stream, onLine) {
  const split = createLineSplitter();
  const handler = (data) => {
    for (const line of split(data.toString("utf8"))) onLine(line);
  };
  stream.setEncoding?.("utf8");
  stream.on("data", handler);
  return () => stream.off("data", handler);
}

/** 序列化为一行 JSON（含换行）。 */
export function serializeLine(value) {
  return JSON.stringify(value) + "\n";
}
