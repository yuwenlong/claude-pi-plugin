---
description: 打断常驻 Pi agent 当前这一轮
argument-hint: <agent名字>
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/pi-agent.mjs" abort --stdin <<'CLAUDE_PI_EOF'
$ARGUMENTS
CLAUDE_PI_EOF`

上面是打断操作的结果。

用于"这一轮想太久、跑偏了，想立刻打断重来"的场景。若 agent 是卡在扩展弹出的确认框
上（没人应答），插件本身有兜底超时会自动取消那类弹窗，不一定需要先 abort；`abort` 更适合
主动打断正在运行的推理/工具调用。若打断后 agent 仍无响应，用 `/claude-pi:list` 确认状态，
必要时 `/claude-pi:stop` 掉重新 `/claude-pi:spawn`。

请简要告知用户结果即可。
