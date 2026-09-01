---
description: 拉起一个常驻 Pi agent，可顺带派第一个任务
argument-hint: <agent名字> [初始任务]
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/pi-agent.mjs" spawn --timeout 100000 --stdin <<'CLAUDE_PI_EOF'
$ARGUMENTS
CLAUDE_PI_EOF`

上面是拉起常驻 Pi agent 的结果。

常驻 agent 会一直活着并保留上下文，后续用 `/claude-pi:send <名字> <消息>` 继续对话，用 `/claude-pi:stop <名字>` 收工。
请向用户简要说明 agent 已就绪（含模型与工作目录），若带回了首轮回复请一并完整转述。
若开头是 `✗`，请说明失败原因；名字冲突时建议换一个名字，或先 `/claude-pi:stop` 掉旧的。

这条 slash 命令的 `$ARGUMENTS` 一律当纯文本传给 pi-agent（避免用户话里带 `--` 被误当选项），
所以 `--no-extensions` 这个开关**打在这里不生效**。纯实施型 agent 想从源头不加载 pi 扩展
（既省冷启动，也彻底避免扩展弹窗把这一轮卡死），需要直接用 CLI 调用：
`node "${CLAUDE_PLUGIN_ROOT}/scripts/pi-agent.mjs" spawn --no-extensions -- <名字> [初始任务]`。
插件本身对扩展弹窗也有兜底自动取消（默认 30 秒），不用 `--no-extensions` 也不至于永久卡死。
