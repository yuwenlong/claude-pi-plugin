---
description: 借某个 Pi agent 的 shell 执行命令（在它的工作目录里）
argument-hint: <agent名字> <shell命令>
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/pi-agent.mjs" bash --timeout 100000 --stdin <<'CLAUDE_PI_EOF'
$ARGUMENTS
CLAUDE_PI_EOF`

上面是命令在该 agent 工作目录下的执行结果。

请把退出码与输出如实呈现给用户，不要臆测未显示的内容。退出码非 0 时说明失败原因。

若开头是 `⏳`，说明 100 秒内没跑完——这不是失败，命令还在该 agent 的后台跑，把提示照实转告用户即可。
