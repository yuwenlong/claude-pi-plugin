---
description: 给常驻 Pi agent 发一条消息并等它做完
argument-hint: <agent名字> <消息>
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/pi-agent.mjs" send --timeout 100000 --stdin <<'CLAUDE_PI_EOF'
$ARGUMENTS
CLAUDE_PI_EOF`

上面是该 Pi agent 的回复。

直接呈现给用户，保留代码块与结构，不要加引导语或无关的收尾说明。这个 agent 记得之前的对话，所以回复可能是在延续上文。

若开头是 `⏳`，说明 100 秒内没跑完——这不是失败，agent 还在后台跑、上下文完好，把提示照实转告用户即可。

若开头是 `✗`，说明失败原因；提示找不到 agent 时，可用 `/claude-pi:list` 看看当前都有谁在跑。
