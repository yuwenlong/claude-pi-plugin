/**
 * 极简参数解析（零依赖）。
 *
 * 只认白名单里的带值选项与开关，`--` 之后一律当作位置参数——
 * slash 命令把用户原话直接拼进命令行，用户随口写个 `--fix` 不该被误当选项。
 */

const VALUE_FLAGS = new Set([
  "provider",
  "model",
  "thinking",
  "cwd",
  "timeout",
  "name",
]);

const BOOL_FLAGS = new Set(["all", "json", "no-wait", "help", "stdin", "full"]);

export function parseArgs(argv) {
  const options = {};
  const positional = [];
  let passthrough = false;

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];

    if (passthrough) {
      positional.push(token);
      continue;
    }
    if (token === "--") {
      passthrough = true;
      continue;
    }
    if (!token.startsWith("--")) {
      positional.push(token);
      continue;
    }

    const body = token.slice(2);
    const eq = body.indexOf("=");
    const key = eq === -1 ? body : body.slice(0, eq);

    if (VALUE_FLAGS.has(key)) {
      options[key] = eq === -1 ? argv[++i] : body.slice(eq + 1);
      continue;
    }
    if (BOOL_FLAGS.has(key)) {
      options[key] = true;
      continue;
    }
    // 不认识的 `--xxx` 当普通文本，别把用户的话吞掉。
    positional.push(token);
  }

  return { options, positional };
}

/** 把剩余位置参数还原成一句话。 */
export function joinText(parts) {
  return parts.join(" ").trim();
}

/**
 * 把 `--stdin` 读到的原始文本并入位置参数。
 *
 * slash 命令通过 quoted heredoc 把用户原话喂进 stdin，这样引号、`$`、换行都不会
 * 被 shell 二次解释。各子命令对这段文本的切法不同，由 shape 决定：
 *   "text"    整段都是内容（ask）
 *   "id+text" 首个词是 agent 名，其余是内容（send / steer / bash / spawn）
 *   "id"      只取首个词（state / stop）
 */
export function applyStdin(shape, raw, positional) {
  const text = (raw ?? "").trim();
  if (!text || shape === "none") return positional;
  if (shape === "text") return [...positional, text];

  const match = text.match(/^(\S+)\s*([\s\S]*)$/);
  if (!match) return positional;
  const [, id, rest] = match;
  if (shape === "id") return [...positional, id];
  return rest.trim() ? [...positional, id, rest.trim()] : [...positional, id];
}

export function parseTimeout(value, fallback) {
  if (value === undefined) return fallback;
  const ms = Number.parseInt(value, 10);
  if (!Number.isFinite(ms) || ms <= 0) throw new Error(`--timeout 需要正整数毫秒，收到：${value}`);
  return ms;
}
