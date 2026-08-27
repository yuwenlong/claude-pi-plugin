---
description: 停掉指定的常驻 Pi agent（传 --all 则全部停掉）
argument-hint: <agent名字> | --all
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/pi-agent.mjs" stop --stdin <<'CLAUDE_PI_EOF'
$ARGUMENTS
CLAUDE_PI_EOF`

上面是停止操作的结果。

被停掉的 agent 会丢失内存中的上下文（pi 侧的会话文件仍在磁盘上保留）。
请简要告知用户结果即可。
