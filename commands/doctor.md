---
description: 自检 Pi 插件环境（pi CLI、Node、配置、守护进程）
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/pi-agent.mjs" doctor`

上面是环境自检结果（`✓` 正常，`·` 提示，`✗` 需要处理）。

请把结果讲清楚。若 pi CLI 缺失，指引用户执行 `npm install -g @earendil-works/pi-coding-agent`；
若守护进程有问题，指引用户查看输出里给出的日志路径。
