---
description: 给常驻 Pi agent 派活但不等结果（长任务用）
argument-hint: <agent名字> <消息>
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/pi-agent.mjs" send --no-wait --stdin <<'CLAUDE_PI_EOF'
$ARGUMENTS
CLAUDE_PI_EOF`

消息已投递给该 Pi agent——派完即走，不等它跑完，适合耗时长的任务。

向用户确认任务已派出即可：agent 在后台跑，用 `/claude-pi:list` 查看进度；
跑完后再用 `/claude-pi:send <名字> 把结果给我` 要结果，等不及就 `/claude-pi:abort <名字>` 打断。

若开头是 `✗`，说明投递失败；提示找不到 agent 时，可用 `/claude-pi:list` 看看当前都有谁在跑，或先 `/claude-pi:spawn` 拉起一个。
