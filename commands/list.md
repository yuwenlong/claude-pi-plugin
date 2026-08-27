---
description: 列出当前所有常驻 Pi agent 及其状态
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/pi-agent.mjs" list`

上面是当前常驻 Pi agent 的清单（`●` 表示正在干活，`○` 表示空闲）。

请整理成便于阅读的形式呈现给用户。若一个都没有，就直接说明，并提示可用 `/claude-pi:spawn <名字>` 拉起。
