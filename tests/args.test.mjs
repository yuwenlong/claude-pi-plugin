import { test } from "node:test";
import assert from "node:assert/strict";
import { parseArgs, joinText, parseTimeout, applyStdin } from "../scripts/lib/args.mjs";

test("带值选项支持空格与等号两种写法", () => {
  assert.deepEqual(parseArgs(["--model", "k3"]).options, { model: "k3" });
  assert.deepEqual(parseArgs(["--model=k3"]).options, { model: "k3" });
});

test("开关选项被识别为 true", () => {
  const { options } = parseArgs(["--all", "--json"]);
  assert.equal(options.all, true);
  assert.equal(options.json, true);
});

test("`--` 之后的一切都是位置参数", () => {
  const { options, positional } = parseArgs(["--model", "k3", "--", "--all", "这是问题"]);
  assert.deepEqual(options, { model: "k3" });
  assert.deepEqual(positional, ["--all", "这是问题"]);
});

test("不认识的 --flag 当作文本保留，不吞用户的话", () => {
  const { positional } = parseArgs(["帮我", "--重构", "代码"]);
  assert.deepEqual(positional, ["帮我", "--重构", "代码"]);
});

test("joinText 拼回原句并去掉首尾空白", () => {
  assert.equal(joinText([" 你是", "什么大模型？ "]), "你是 什么大模型？");
});

test("parseTimeout 缺省时用回退值，非法值报错", () => {
  assert.equal(parseTimeout(undefined, 1000), 1000);
  assert.equal(parseTimeout("5000", 1000), 5000);
  assert.throws(() => parseTimeout("abc", 1000), /正整数毫秒/);
  assert.throws(() => parseTimeout("-1", 1000), /正整数毫秒/);
});

test("applyStdin: text 形态整段当内容", () => {
  assert.deepEqual(applyStdin("text", '  说说 "引号" 和 $VAR \n', []), ['说说 "引号" 和 $VAR']);
});

test("applyStdin: id+text 形态切出首个词作为 agent 名", () => {
  assert.deepEqual(applyStdin("id+text", "worker 重构 auth 模块", []), ["worker", "重构 auth 模块"]);
});

test("applyStdin: id+text 只有名字时不产生空消息", () => {
  assert.deepEqual(applyStdin("id+text", "  worker  ", []), ["worker"]);
});

test("applyStdin: id 形态丢弃多余内容", () => {
  assert.deepEqual(applyStdin("id", "worker 多余的话", []), ["worker"]);
});

test("applyStdin: none 形态与空输入都原样返回", () => {
  assert.deepEqual(applyStdin("none", "worker", ["x"]), ["x"]);
  assert.deepEqual(applyStdin("text", "   ", ["x"]), ["x"]);
});

test("applyStdin: 多行内容完整保留换行", () => {
  const [id, body] = applyStdin("id+text", "w1 第一行\n第二行", []);
  assert.equal(id, "w1");
  assert.equal(body, "第一行\n第二行");
});
