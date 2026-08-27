# claude-pi-plugin 开发计划

目标：把 claude-pi-bridge 的能力重做成一个**标准 Claude Code 插件**（可 `/plugin marketplace add` + `/plugin install`），
入口改为 **slash 命令**（不再暴露 MCP 工具，二者不共存），底层 RPC 客户端自研、零第三方依赖。

## 设计决策

- 分发形态：仓库根 `.claude-plugin/{plugin.json,marketplace.json}`，仓库自身即市场（对齐 claude-hud 的做法）
- 底层实现：自研 `pi --mode rpc` JSONL 客户端，仅用 `node:*` 内置模块（插件安装后不会跑 npm install，必须零依赖）
- 交互入口：slash 命令唯一入口，命令体内用 `!` 直接执行脚本并回注输出
- 常驻 agent 由后台守护进程持有（unix socket / named pipe IPC），一次性问答走直连不经守护进程

## 任务清单

- [x] 验证本机 `pi --mode rpc` 协议连通（返回 "Kimi"，provider=kimi-coding/k3）
- [x] 搭建目录骨架
- [x] `scripts/lib/jsonl.mjs` — JSONL 增量分帧
- [x] `scripts/lib/rpc-client.mjs` — 自研 JSONL RPC 客户端
- [x] `scripts/lib/config.mjs` — 可选配置加载
- [x] `scripts/lib/args.mjs` — 零依赖参数解析 + stdin 通道
- [x] `scripts/lib/ipc.mjs` — 客户端/守护进程通信 + 守护进程自举
- [x] `scripts/lib/daemon.mjs` — 常驻 agent 注册表与生命周期
- [x] `scripts/pi-agent.mjs` — CLI 入口（ask/spawn/send/steer/list/state/bash/stop/doctor）
- [x] `commands/*.md` — 8 个 slash 命令
- [x] `.claude-plugin/plugin.json` + `marketplace.json`
- [x] README / LICENSE / .gitignore / package.json
- [x] `tests/` — node:test 单测 + 假 pi 协议桩（零依赖）
- [x] 自测：单测全绿（37/37）
- [x] 自测：真实呼起 pi 问"你是什么大模型"
- [x] 自测：常驻 agent 全链路（spawn → send → state → bash → stop）
- [x] 自测：`claude plugin validate` + 真实安装 + slash 命令端到端

## 评审

### 交付结果

零运行时依赖（只用 `node:*`），`claude plugin validate` 通过，已在本机真实安装。
8 个命令：`/claude-pi:ask`、`spawn`、`send`、`steer`、`list`、`bash`、`stop`、`doctor`。

一次性问答直连 pi 用完即走；常驻 agent 由后台守护进程持有，按需自举、闲置 30 分钟自行退场。

### 验证证据

1. **单测**：`node --test "tests/**/*.test.mjs"` → 37 tests / 37 pass / 0 fail
2. **真实呼起 pi**：`ask "你是什么大模型？"` → `【pi · kimi-coding/k3】臣是 Kimi，由月之暗面（Moonshot AI）开发`，耗时 10s
3. **常驻链路**：spawn(轮次1) → send 追问"我刚才问你什么"，pi 准确复述上一轮原话，证明上下文延续；state 显示 messageCount=4、会话文件已落盘；bash 正确回显 exitCode=0
4. **插件装载**：`claude plugin validate .` 通过 → `marketplace add` → `install` → `plugin list` 显示 enabled
5. **端到端**：`claude -p "/claude-pi:ask 你是什么大模型？"` 返回 Kimi 自述；`claude -p "/claude-pi:spawn e2e ..."` 后该会话退出，`list` 仍显示 e2e 存活且 cwd 正确继承——常驻机制成立

### 遇到的坑

1. **插件命令必须带 `插件名:` 前缀**。实测 `/pi` 报 `Unknown command: /pi. Did you mean /pdf?`，`/claude-pi:pi` 才通。据此把命令文件从 `pi-*.md` 改名为 `ask/spawn/...`，避免 `/claude-pi:pi-spawn` 这种 "pi" 重复两遍的冗余。
2. **slash 命令的 `$ARGUMENTS` 是字面替换后交给 shell**，用户提问里的引号、`$` 会击穿命令。改用 quoted heredoc（`<<'CLAUDE_PI_EOF'`）传 stdin，配合 CLI 的 `--stdin`，把引号/`$`/换行全挡住。残留边界：提问含反引号仍会提前终止 `!`…`` 包裹，已写进 README 的已知边界。
3. **pi 在 `agent_end` 之后还会发 `agent_settled`**，`waitForIdle` 以 `agent_end` 为准即可，不必等后者。
4. **首个 prompt 前需等 pi 初始化完毕**。参考实现用固定 `sleep(100)`，臣改为主动发一次 `get_state` 做握手，慢机器上也不会丢命令。
5. **插件安装是复制到 cache 目录**，改源码后必须 `uninstall` + `install` 才生效，不是软链。

---

## 2026-08-27 追加：性能优化

圣上反馈"响应有点慢"（一次 `/claude-pi:ask` 走了 24s）。先分阶段计时定位，再动刀。

### 耗时定位（实测，非估算）

首轮 profile 把 9.2s 的链路拆开：

| 环节 | 耗时 |
|------|------|
| pi 进程冷启动 + 握手 | 1610ms |
| LLM 推理（prompt → agent_end） | 7613ms |
| 取回文本 + 收尾 | 21ms |

而圣上看到的是 24s，**差出的约 15s 在 Claude 这一侧**（决定调用 skill + 生成转述），插件够不着。
结论：插件能优化的只有那 1.6s 本地开销，LLM 那 7.6s 由 provider 决定。

### 已落地的改动

1. **`ask` 默认 `--no-extensions`**。实测扩展加载占冷启动大头：1739ms → 357ms（降 79%），
   且抖动消失（原先首次会飙到 2811ms，现稳定在 351-368ms）。加 `--full` 可恢复完整加载。
   `spawn` 起的常驻 agent 要真干活，**不受影响**，照常加载扩展。
2. **复用 `start()` 握手拿到的 state**。`cmdAsk` 原先还会再发一次 `get_state`，纯属多余，
   现在缓存在 `client.initialState` 里。
3. **削减命令模板的冗余包装**。原模板要求"完整转述"，导致 Claude 输出
   "启禀圣上…臣如实转述"加引用加补充说明。改为直接呈现答案、禁止引导语与无关收尾。

### 一处被否掉的方案

臣本想让 Claude **完全不转述**（理由：`!` 的输出用户已经看到了，复述纯属浪费）。
翻看圣上贴的实际日志才发现——skill 的原始输出是**折叠**的，圣上看到的正是转述那段。
若不转述，圣上将一无所见。故只削减包装，保留答案本身。**假设必须拿实际证据校验。**

### 一处测量陷阱

中途测思考级别（off/low/medium/high）的影响，得到 35s/52s/52s/53s，
而几分钟前同样代码同样问题只要 6-12s——是 kimi 服务端在剧烈降速，
四组数据全被噪声淹没，**不足以支撑任何结论**，遂弃用。
改用只测本地开销的 profile2（不含 LLM 调用），才拿到可复现的数据。

教训：跑在远端服务上的性能对比，先确认基线稳不稳，否则量的是别人的负载。

### 验证

- 单测 40/40 通过（新增 3 条：握手缓存、`--no-extensions` 透传、默认不禁用扩展）
- 三条路径端到端实跑正常：精简 `ask`、`--full` `ask`、`spawn` 常驻 agent
