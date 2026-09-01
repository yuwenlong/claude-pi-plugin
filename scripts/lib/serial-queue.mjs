/**
 * 单个 agent 的串行队列。
 *
 * pi 一次只跑一轮，而 `waitForIdle` 只认「下一个 agent_end」，分不清那是哪一轮的。
 * 前一轮还没落地就发下一个 prompt，第二个等待者会被前一轮的 agent_end 提前唤醒，
 * 拿回上一轮的答案——不报错，答案看着也正常，只是答非所问。
 *
 * 所以同一个 agent 的每一轮对话都必须排队：前一轮结束，下一轮才开口。
 */

/** 新建一条空队列。 */
export function createQueue() {
  return { tail: Promise.resolve() };
}

/**
 * 把一轮任务排到队尾，返回这一轮自己的结果。
 *
 * 队列本身不因某一轮失败而中断：下一轮照常接上，只是拿不到上一轮的结果。
 */
export function enqueue(queue, task) {
  // 两个分支都接上，前一轮成败都不影响下一轮开跑；task 不接收上一轮的结果。
  const turn = queue.tail.then(
    () => task(),
    () => task(),
  );
  queue.tail = turn.then(
    () => {},
    () => {},
  );
  return turn;
}
