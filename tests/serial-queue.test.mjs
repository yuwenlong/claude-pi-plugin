import { test } from "node:test";
import assert from "node:assert/strict";
import { createQueue, enqueue } from "../scripts/lib/serial-queue.mjs";

/** 手动可控的 promise，用来把一轮任务按在半路上。 */
function defer() {
  let resolve;
  const promise = new Promise((res) => (resolve = res));
  return { promise, resolve };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

test("后一轮必须等前一轮落地才开跑", async () => {
  const queue = createQueue();
  const first = defer();
  const started = [];

  const a = enqueue(queue, () => {
    started.push("a");
    return first.promise;
  });
  const b = enqueue(queue, () => {
    started.push("b");
    return "B 的结果";
  });

  await tick();
  assert.deepEqual(started, ["a"], "第一轮还没结束，第二轮不该开跑");

  first.resolve("A 的结果");
  assert.equal(await a, "A 的结果");
  assert.equal(await b, "B 的结果");
  assert.deepEqual(started, ["a", "b"]);
});

test("每一轮拿回的都是自己的结果，不会串轮", async () => {
  const queue = createQueue();
  const results = await Promise.all([
    enqueue(queue, () => "第一轮"),
    enqueue(queue, () => "第二轮"),
    enqueue(queue, () => "第三轮"),
  ]);
  assert.deepEqual(results, ["第一轮", "第二轮", "第三轮"]);
});

test("某一轮失败不会卡死整条队列", async () => {
  const queue = createQueue();
  const failing = enqueue(queue, () => Promise.reject(new Error("这一轮炸了")));
  const next = enqueue(queue, () => "照常继续");

  await assert.rejects(() => failing, /这一轮炸了/);
  assert.equal(await next, "照常继续");
});

test("失败那一轮的错误只打回它自己的调用方", async () => {
  const queue = createQueue();
  const ok = enqueue(queue, () => "先来一轮");
  const bad = enqueue(queue, () => Promise.reject(new Error("第二轮炸了")));

  assert.equal(await ok, "先来一轮");
  await assert.rejects(() => bad, /第二轮炸了/);
});
