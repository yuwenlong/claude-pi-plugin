---
description: 在 Pi agent 干活途中插话纠偏
argument-hint: <agent名字> <纠偏指令>
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/pi-agent.mjs" steer --stdin <<'CLAUDE_PI_EOF'
$ARGUMENTS
CLAUDE_PI_EOF`

上面是插话结果。

插话是异步的：消息已排进该 agent 的队列，它会在当前这轮里尽快消化，这里不会等到最终回复。
请告诉用户已插话成功，并提示用 `/claude-pi:list` 看状态、用 `/claude-pi:send` 追问结果。
