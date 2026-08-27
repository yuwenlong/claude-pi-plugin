import { test } from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { createLineSplitter, attachLineReader, serializeLine } from "../scripts/lib/jsonl.mjs";

test("跨分片的行被正确拼回", () => {
  const split = createLineSplitter();
  assert.deepEqual(split('{"a":'), []);
  assert.deepEqual(split('1}\n{"b":2}\n'), ['{"a":1}', '{"b":2}']);
});

test("空行被丢弃，CRLF 被规整", () => {
  const split = createLineSplitter();
  assert.deepEqual(split("one\r\n\ntwo\r\n"), ["one", "two"]);
});

test("未收到换行前不吐出半截行", () => {
  const split = createLineSplitter();
  assert.deepEqual(split("未完待续"), []);
  assert.deepEqual(split("\n"), ["未完待续"]);
});

test("attachLineReader 逐行回调，退订后不再触发", () => {
  const stream = new PassThrough();
  const lines = [];
  const detach = attachLineReader(stream, (line) => lines.push(line));

  stream.write('{"type":"agent_start"}\n{"type":"agen');
  stream.write('t_end"}\n');
  assert.deepEqual(lines, ['{"type":"agent_start"}', '{"type":"agent_end"}']);

  detach();
  stream.write('{"type":"ignored"}\n');
  assert.equal(lines.length, 2);
});

test("serializeLine 产出恰好一行 JSON", () => {
  assert.equal(serializeLine({ type: "prompt", message: "hi" }), '{"type":"prompt","message":"hi"}\n');
});

test("消息体里的换行不会撕裂分帧", () => {
  const payload = { type: "prompt", message: "第一行\n第二行" };
  const split = createLineSplitter();
  const [line] = split(serializeLine(payload));
  assert.deepEqual(JSON.parse(line), payload);
});
