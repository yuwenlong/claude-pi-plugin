# claude-pi-plugin

在 Claude Code 里用**斜杠命令**直接驱动 [Pi](https://github.com/earendil-works/pi) 编程智能体。

```
/claude-pi:ask 你是什么大模型？
→ 【pi · kimi-coding/k3】
  臣是 Kimi，由月之暗面（Moonshot AI）开发的大模型。
```

不用开新终端，不用配 MCP，装完即用。

---

## 它解决什么

Claude Code 擅长统筹，Pi 是另一个快而能干的编程智能体。这个插件把两者接起来：Claude 当工头，Pi 当干活的班组。

```
/claude-pi:spawn tester   给 auth.ts 补齐单元测试
/claude-pi:spawn refactor 把 db.ts 重构成仓储模式
/claude-pi:list           看看谁在忙、谁空了
/claude-pi:send tester 覆盖率到多少了？
```

常驻 agent 各自独立、并行推进、保留自己的上下文，Claude 主会话不用被它们的中间过程刷屏。

---

## 安装

**前置条件**

- Node.js >= 20
- Pi CLI：`npm install -g @earendil-works/pi-coding-agent`
- Pi 那边至少配好一个 provider（本插件直接复用 `~/.pi/agent/auth.json`，不用重复填 key）

**装插件**

```
/plugin marketplace add yuwenlong/claude-pi-plugin
/plugin install claude-pi@claude-pi
```

本地开发时改用路径：

```
/plugin marketplace add /path/to/claude-pi-plugin
/plugin install claude-pi@claude-pi
```

装完运行 `/claude-pi:doctor` 自检。**插件运行时零第三方依赖**，只用 Node 内置模块，所以不需要 `npm install`。

---

## 命令

插件命令一律带 `claude-pi:` 前缀（Claude Code 的命名空间规则，裸名不注册）。交互式下敲 `/pi` 再按 Tab，这几条都会被模糊匹配出来。

| 命令 | 作用 |
|------|------|
| `/claude-pi:ask <问题>` | 一次性提问，问完就退。最常用 |
| `/claude-pi:spawn <名字> [初始任务]` | 拉起一个常驻 agent |
| `/claude-pi:send <名字> <消息>` | 给常驻 agent 发消息并等结果 |
| `/claude-pi:steer <名字> <指令>` | 在它干活途中插话纠偏 |
| `/claude-pi:abort <名字>` | 打断某个 agent 当前这一轮 |
| `/claude-pi:list` | 列出所有常驻 agent 及状态 |
| `/claude-pi:bash <名字> <命令>` | 借它的 shell 执行命令 |
| `/claude-pi:stop <名字>` | 停掉某个 agent（`--all` 全停） |
| `/claude-pi:doctor` | 环境自检 |

### 响应快慢由什么决定

一次调用的耗时基本全在 LLM 推理上，插件自身的开销很小：

| 环节 | 耗时 | 能否优化 |
|------|------|----------|
| pi 进程冷启动 + 握手 | ~0.36s | 已优化（`ask` 默认不加载扩展，原为 ~1.7s） |
| LLM 推理 | 数秒到数十秒 | 取决于 provider 当时的负载，插件无能为力 |
| IPC / 分帧 / 收尾 | < 20ms | 可忽略 |

所以觉得慢时，先怀疑 provider 而不是插件。几条实测有效的提速手段：

- `ask` 默认已禁用 pi 扩展（省约 1.4s 冷启动）。要用扩展就加 `--full`。
- 简单问答可以压低思考级别：`/claude-pi:ask --thinking low 你的问题`。pi 默认可能是 `high`，问一句话用不上。
- 要连问多轮，用 `spawn` 起常驻 agent，之后每次 `send` 都省掉整个冷启动。

### `ask` 与 `spawn` 怎么选

`ask` 每次都新起一个 pi 进程，问完即销毁，不留会话文件——适合单点提问、换个模型问个第二意见。

`spawn` 起的 agent 常驻在后台，**记得上文**，适合交给它一件需要多轮推进的活。用完记得 `stop`。

---

## 配置

默认零配置：provider、模型、凭据一概跟随 Pi 自己的 `~/.pi/agent/settings.json` 与 `auth.json`。

只有想覆盖默认值时才需要写 `~/.claude-pi-plugin/config.json`：

```json
{
  "providers": {
    "openrouter": {
      "apiKeyEnvVar": "OPENROUTER_API_KEY",
      "defaultModel": "moonshotai/kimi-k2.6"
    }
  },
  "defaults": {
    "provider": "openrouter",
    "model": "moonshotai/kimi-k2.6",
    "thinkingLevel": "medium"
  },
  "limits": {
    "maxConcurrentAgents": 5,
    "defaultTimeoutMs": 180000,
    "daemonIdleTimeoutMs": 1800000,
    "extensionDialogTimeoutMs": 30000
  }
}
```

`extensionDialogTimeoutMs` 见下方"扩展弹窗会不会卡死常驻 agent"一节。

单次调用也可以临时覆盖，但**只在直接跑 CLI 时**生效（见下方"开发"一节），
不是把选项打在 slash 命令的问题文本里：

```bash
node scripts/pi-agent.mjs ask --provider anthropic --model claude-sonnet-4 -- "这段代码有什么问题？"
```

因为 slash 命令的 `$ARGUMENTS` 一律经 `--stdin` 当作纯文本喂给 pi-agent（见"已知边界"），
`/claude-pi:ask --provider anthropic 这段代码有什么问题？` 这样打字，`--provider anthropic`
不会被识别成选项，而是会原样出现在发给 pi 的问题里——这是故意的：不然用户话里随口带的
`--` 就可能被误当成选项吞掉。

---

## 架构

```
┌─────────────┐   斜杠命令    ┌──────────────┐
│ Claude Code │──────────────►│ pi-agent.mjs │
└─────────────┘   回注输出 ◄──│    (CLI)     │
                              └──────┬───────┘
                     ask（一次性）   │   常驻 agent
                    ┌───────────────┘└──────────────┐
                    ▼                               ▼
             ┌─────────────┐              ┌──────────────────┐
             │ pi --mode   │              │ 守护进程          │
             │   rpc       │              │ (unix socket)    │
             └─────────────┘              └────────┬─────────┘
              用完即走                              │ 持有多个
                                          ┌─────────┴─────────┐
                                          ▼         ▼         ▼
                                       pi rpc    pi rpc    pi rpc
```

- **一次性问答**直连 pi，不经守护进程，链路最短最不容易出岔子。
- **常驻 agent** 必须活过单次命令调用，所以由后台守护进程持有；它按需自动拉起，长时间闲置后自行退场。
- 与 pi 之间走 `--mode rpc` 的 JSONL 协议，客户端自研，只用 `node:*`。

---

## 排错

| 症状 | 处理 |
|------|------|
| 提示找不到 pi CLI | `npm install -g @earendil-works/pi-coding-agent` |
| 命令卡住不返回 | 加大 `--timeout`，或 `/claude-pi:list` 看 agent 是不是还在忙 |
| 常驻 agent 一直显示 `busy` 不动 | 先 `/claude-pi:abort <名字>` 打断当前这一轮；若还是不动，看下面"扩展弹窗会不会卡死常驻 agent" |
| 守护进程连不上 | 看日志 `~/.claude-pi-plugin/daemon.log` |
| 想彻底重置 | `/claude-pi:stop --all`，必要时删掉 `~/.claude-pi-plugin/daemon.sock` |

**已知边界**：斜杠命令的参数经由 shell 传递，插件用 quoted heredoc 兜住了引号、`$`、换行等特殊字符；但如果提问里带**反引号**，会提前终止命令的反引号包裹。这种情况请改用 `/claude-pi:send` 分多次说，或把代码放进文件再让 agent 去读。

### 扩展弹窗会不会卡死常驻 agent

pi 的内置工具（read/bash/edit/write）在 `--mode rpc` 下不会弹确认框，正常干活不受影响。
唯一的风险来自 pi **扩展**：扩展可以调用 `ui.confirm/select/input/editor` 弹一个交互对话框，
如果扩展自己没给这次调用传 `timeout`，pi 会一直等回应——而这里没有人在盯着屏幕点确认。

插件对此有兜底：客户端收到这类弹窗请求后起一个计时器（默认 30 秒，`limits.extensionDialogTimeoutMs`
可调），到点没人应答就自动回"取消"，让那一轮收场，而不是永久挂起。`/claude-pi:send`/`ask`
本身也自带超时（默认 180 秒），所以即便真遇上这种情况，Claude 的主会话也不会被拖死；
真正会"卡住"的只是那个 pi agent 本身，会一直显示 `busy` 直到兜底超时触发或你手动 `abort`。

不想承担这份风险的话，`spawn` 一个纯实施型 agent 时可以直接不加载扩展（见"开发"一节里的
CLI 用法，`--no-extensions` 打在 slash 命令的参数文本里不生效）——从源头避免这类弹窗。

---

## 开发

```bash
npm test                        # node:test，零依赖，不需要真的 pi
node scripts/pi-agent.mjs doctor
node scripts/pi-agent.mjs ask -- "你是什么大模型？"
node scripts/pi-agent.mjs spawn --no-extensions -- worker "重构 auth 模块"
```

测试用 `tests/fixtures/fake-pi.mjs` 这个协议桩替代真实 pi，所以离线也能跑全。

---

## License

MIT
