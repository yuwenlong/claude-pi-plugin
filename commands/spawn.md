---
description: 拉起一个常驻 Pi agent，可顺带派第一个任务
argument-hint: <agent名字> [初始任务]
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/pi-agent.mjs" spawn --stdin <<'CLAUDE_PI_EOF'
$ARGUMENTS
CLAUDE_PI_EOF`

上面是拉起常驻 Pi agent 的结果。

常驻 agent 会一直活着并保留上下文，后续用 `/claude-pi:send <名字> <消息>` 继续对话，用 `/claude-pi:stop <名字>` 收工。
请向用户简要说明 agent 已就绪（含模型与工作目录），若带回了首轮回复请一并完整转述。
若开头是 `✗`，请说明失败原因；名字冲突时建议换一个名字，或先 `/claude-pi:stop` 掉旧的。
