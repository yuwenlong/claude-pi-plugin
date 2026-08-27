---
description: 向 Pi 智能体提一个问题，直接拿回答案（一次性，用完即走）
argument-hint: <问题或任务>
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/pi-agent.mjs" ask --stdin <<'CLAUDE_PI_EOF'
$ARGUMENTS
CLAUDE_PI_EOF`

上面是 Pi 智能体的回答。

直接把这段回答呈现给用户，保留其中的代码块与结构。**不要加引导语**（"以下是转述"、"Pi 已作答"之类），也不要在末尾追加与提问无关的说明——用户要的是答案本身，多余的包装只会拖慢响应。

只在确有必要时才补充一两句：答案与本项目实情冲突、明显有误、或需要用户接着做什么。

若输出以 `✗` 开头，说明调用失败，此时讲清失败原因，并提示可运行 `/claude-pi:doctor` 自检。不要替 Pi 重新回答问题。
