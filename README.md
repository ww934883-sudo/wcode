# wcode

编程 Agent（类 Claude Code / ZCode 形态），同一引擎三种形态：**终端 TUI**、**无头管道**（脚本/CI/定时任务）、**Electron 桌面端**。Monorepo，TypeScript，Node.js ≥ 24（`node:sqlite` 会话库要求；老环境可在 settings.json 配 `storage.type: "jsonl"` 回退）。

```
终端 TUI            无头 -p               桌面端
┌──────────┐      ┌──────────┐      ┌────────────────┐
│ ink 流式渲染 │      │ stdout 结果 │      │ 多会话/插件/用量/设置 │
│ 权限 diff 弹窗│      │ stderr 进度 │      │ 分屏/检查点分叉      │
└────┬─────┘      └────┬─────┘      └───────┬────────┘
     └────────────┬────┴───────────────────-─┘
          @wcode/core（Agent 循环 · 权限 · 工具 · 会话 · 插件）
                     │
        provider-anthropic / provider-openai（协议适配，可换）
```

## 包结构与依赖铁律

```
packages/
├─ core/                  # @wcode/core —— 引擎：循环/权限/工具管道/会话/上下文/插件/自动化存储（无 UI、无模型 SDK）
├─ provider-anthropic/    # Anthropic Messages 协议适配（fetch + SSE，零 SDK 依赖）
├─ provider-openai/       # OpenAI Chat Completions + Responses 协议适配
├─ cli/                   # @wcode/cli —— 终端组合根（bin: wcode）：TUI / 无头 / schedule / daemon
├─ desktop/               # @wcode/desktop —— Electron 桌面客户端（AgentHost 第四实现）
└─ evals/                 # 确定性评测集（套件 wcode-core-v1，20 个真实任务）
```

依赖单向自上而下，CI 用 dependency-cruiser 强制（`.dependency-cruiser.cjs`）：core 禁止依赖任何 UI 库与模型 SDK；provider 只准依赖 core；cli/desktop 是组合根。core 通过五个接缝与外界解耦：ModelProvider port、工具注册表、AgentHost 反向端口、SessionStore、分层 Config。

## 快速开始

```bash
pnpm install

# 配置密钥（密钥只放用户级 ~/.wcode/settings.json，仓库内绝不落盘）
#   ~/.wcode/settings.json:
#   { "providers": { "anthropic": { "type": "anthropic", "apiKeyEnv": "ANTHROPIC_API_KEY" } } }

pnpm dev                          # 终端 TUI（tsx 直跑，无需构建）
pnpm dev -- --selftest            # 无网络自检：FakeProvider 验证 Agent 循环与工具管道
pnpm desktop                      # Electron 桌面端（无 API key 自动进演示模式，离线可玩）
pnpm --filter @wcode/desktop preview   # 浏览器预览桌面 UI（mock-bridge 回放，localhost:4183）

pnpm typecheck && pnpm lint:deps && pnpm test   # 回归三件套（328 用例，无需网络）
pnpm eval                         # 评测集（需 provider，见文末）
```

## 功能总览

### 模型与 Provider

- **三种协议适配**，同一套工具/权限/上下文机制只换适配层：

| type | 协议 | 适用 |
| --- | --- | --- |
| `anthropic` | Anthropic Messages（`/v1/messages`，SSE 流式） | Claude 官方、火山 codingPlan（`baseUrl: https://ark.cn-beijing.volces.com/api/coding`） |
| `openai-compatible` | Chat Completions（`/chat/completions`） | DeepSeek / Qwen / GLM / Kimi 官方 API 等 |
| `openai-responses` | OpenAI Responses（`/responses`） | OpenAI 官方 |

- **思考档位**（off/low/medium/high）：provider 声明自己支持的档位（`thinkingLevels` 接缝），UI 与命令按当前模型过滤，不支持的模型线上兜底不发思考参数。
- **模型目录**：`/model` 拉取 provider 端点可用模型列表（三级 fallback 兼容火山/one-api 网关），会话内热切；桌面端可自建模型目录、供应商+模型一起切。
- **用量统计**：逐轮 token 统计；配置 `priceInput`/`priceOutput`（每百万 tokens 单价）后桌面端用量页折算费用。
- **多模态**：read 工具可读图（png/jpg/webp/gif），Anthropic 协议下图像回传模型。
- provider 密钥支持 `apiKeyEnv` 环境变量名或用户级 `apiKey`；错误统一翻译为可重试/不可重试两类，429/5xx 指数退避。

### Agent 核心

- **主循环**：流式响应、工具批调度（全只读并行/含写串行）、中断、护栏、失败重试。
- **子 Agent**：`task` 工具派生独立上下文子循环（大范围搜索/多文件调研），工具集 `readonly`（默认）/`all`，权限与 hooks 继承且可收紧，只回传结论；轮数上限 25。
- **上下文管理**：微清理（老的大体积工具结果替换为占位符，保留最近 2 条原文）+ 自动压缩（默认 200k × 0.8 阈值触发，同一 provider 生成结构化摘要回填）；`/compact` 立即压缩。
- **任务目标**：`/goal` 设定目标并入 system prompt，压缩后依然有效。
- **项目记忆**：`~/.wcode/AGENTS.md` + 项目 `AGENTS.md`（兼容 `CLAUDE.md`）自动注入系统提示；`/init` 探索仓库自动生成。

### 内置工具（11 个）

| 工具 | 说明 |
| --- | --- |
| `read` | 读文件（带行号、大文件分页、读图多模态、二进制拒显） |
| `write` | 整文件原子写入；已存在文件必须先 read（防盲写覆盖） |
| `edit` | 精确字符串替换；多匹配报错展示冲突片段；未 read 拒编辑、外部改动过期保护 |
| `glob` | 文件名 glob 搜索（按修改时间倒序，最多 200 条） |
| `grep` | 内容正则搜索（ripgrep 优先 + 内置扫描降级，最多 100 条） |
| `bash` | shell 命令（超时杀进程树、`run_in_background` 后台任务、Windows 无 bash 自动降级 PowerShell） |
| `task_output` / `task_stop` | 查看后台任务输出（可等待）/ 终止后台任务（进程树 kill） |
| `todo_write` / `todo_read` | 任务清单维护（`todos_changed` 事件驱动 UI 实时快照） |
| `task` | 派生子 Agent（见上） |

另有 `skill` 工具（按需加载技能正文）。所有工具输出超长自动截断（`tools.maxOutputChars`，默认 30k），截断提示说明剩余量与获取方式。工具管道：Hooks（pre）→ 权限 → schema 校验 → 执行 → 截断 → Hooks（post）→ 审计。

### 权限引擎

- **四模式**：`plan`（只读硬上限，allow 也越不过）/ `default`（只读放行，写操作确认）/ `acceptEdits`（编辑类放行）/ `bypass`（全放行）。
- **规则**：`allow` / `deny` 数组，格式 `Tool(pattern)`；路径 glob `*` 不跨目录、`**` 跨目录；命令级规则 `Bash(git *)` 按命令串匹配（`*` 跨空格）。deny > plan 硬上限 > allow > 会话学习 > 模式默认。
- **会话学习**：权限弹窗选"总是允许"后，同模式操作本会话内不再询问（重启不保留，越不过 deny）。
- **交互**：TUI 弹窗展示 write/edit 着色 diff（y 一次 / a 总是 / n 拒绝）；桌面端权限卡；无头模式自动拒绝（配 `--mode` 或 allow 规则放行）。

### 扩展机制

- **Skills（技能）**：`~/.wcode/skills/<名>/SKILL.md` 或项目 `.wcode/skills/`；系统提示只注入名字+描述清单（渐进披露），正文按需加载；`/技能名 参数` 直接调用；输入框 `$` 引用（桌面端）。
- **自定义命令**：`~/.wcode/commands/<名>.md`（frontmatter 写 description），正文提示词模板支持 `$ARGUMENTS` / `$1..$9`。
- **自定义子 Agent**：`~/.wcode/agents/<名>.md`，frontmatter `tools` 白名单，正文 = system prompt；task 工具按名派生；桌面端侧栏选"助理"。
- **Hooks**：7 个生命周期事件（settings.json，键 camelCase）：

| 事件 | 时机 | 退出码 2 的效果 |
| --- | --- | --- |
| `sessionStart` | 会话启动 | — |
| `userPromptSubmit` | 用户输入提交 | 拦下整条输入 |
| `preToolUse` | 工具执行前 | 阻断本次工具调用 |
| `permissionRequest` | 权限询问时 | 自动拒绝 |
| `postToolUse` / `postToolUseFailure` | 工具成功 / 失败后 | — |
| `stop` | 任务回合结束 | — |

  hook 进程从 stdin 收 JSON（event/cwd/toolName/toolInput/prompt/timestamp）；`matcher` 正则过滤工具名；0 放行、2 阻断、其余告警不阻断；超时默认 30s。
- **MCP**：`mcpServers` 配置 stdio（command+args+env）与 http/sse（url+headers）两种接入，工具命名空间化 `mcp__<server>__<tool>`，连接失败降级跳过；`/mcp` 查看状态。

### 插件系统

- **插件包**：根下 `.zcode-plugin/plugin.json`（`.claude-plugin/` 兼容 Claude Code 插件直接复用），组件含 **skills / commands（斜杠命令）/ agents / hooks（hooks.json）/ mcpServers / dependencies（递归安装）**。
- **发现与命名空间**：用户/项目级 + 已安装插件统一装配；插件组件命名空间化（技能 `插件名:技能名`、命令 `/插件名:命令名`、MCP `plugin:<插件名>:<服务名>`），用户/项目级同名组件优先。
- **市场与安装**：`/plugin install <名>[@市场]`，市场来源支持 GitHub（`owner/repo`）、git url、本地目录、zip url（sha256 校验）；`/plugin list|uninstall|enable|disable`，`/plugin market list|add|refresh|remove`；安装到 `~/.wcode/plugins/cache/<市场>/<插件>/<版本>/`。
- **内置插件**（随应用分发，启动时播种到本机缓存，升级自动重播、卸载过的不装回 `plugins.blockedBuiltins`）：
  - **browser-use** —— 远程调试端口驱动 Chrome/Edge：打开页面、执行 JS、点击填表、截图、读取渲染后内容（零依赖 CDP 客户端）。
  - **computer-use** —— 屏幕截图、鼠标点击、键盘输入、窗口与进程管理（Windows PowerShell 脚本 + macOS/Linux 等价命令）。
- **变量替换**：插件组件正文可用 `${WCODE_PLUGIN_ROOT}`（插件根目录）与 `${WCODE_PROJECT_DIR}`（当前项目），兼容 `${CLAUDE_PLUGIN_ROOT}` 等别名。

### 会话与存储

- **SQLite 单库** `~/.wcode/wcode.db`（WAL，版本化迁移，会话/消息/事件/自动化/模型目录分区；首次启动幂等导入旧 JSONL 且不删原文件）；`storage.type: "jsonl"` 回退旧目录形态。
- **恢复与搜索**：`--continue` 接最近会话；`/resume` 列出/恢复历史；`/sessions <关键词>` 跨会话消息级搜索；`/stats` 项目存储统计。
- **桌面端加成**：多会话/多项目侧栏（置顶跨重启持久）、检查点分叉（从任意用户消息复制出新会话）、分屏双会话（事件按 sessionId 多路复用）、原地回退。

### 自动化（无头 + 调度）

`wcode -p` 作为管道组件：进度写 **stderr**，结果写 **stdout**，退出码 0 成功 / 1 运行错误 / 2 配置错误；`--output-format=json` 输出 `{status, reply, usage, model, sessionId}`；Skills、hooks、子 Agent、插件、AGENTS.md 无头下同样生效。

```bash
wcode -p "运行 pnpm test 并修复失败用例"
echo "总结今天的 git log" | wcode -p -
git diff | wcode -p - "审查这段 diff 的安全问题"
wcode -p -c "跟进上一会话的任务"                  # 无头续跑最近会话
```

内置调度器（任务存 `~/.wcode/wcode.db`，daemon 到点派发 `wcode -p` 子进程执行）：

```bash
wcode schedule add "每晚检查未完成任务并继续推进" --cron="0 23 * * *" --mode=acceptEdits
wcode schedule add "给 TODO 补一条周报" --at="2026-09-20T09:00"   # 一次性（也支持 --at="+10m"）
wcode schedule list [--project=path]      # 状态一览（bypass 任务标 ⚠）
wcode schedule run|pause|resume|remove <id>   # id 可用前缀
wcode schedule log [id]                   # 运行历史（结局/耗时/会话 id，可 /resume 回看）
wcode daemon                              # 常驻守护（每 60s 扫描）
wcode daemon --tick                       # 只跑一轮（挂 Windows 计划任务 / crontab）
```

- **认领互斥**：daemon 与手动 run 并发只执行一方；崩溃残留 2 小时后可重新认领（CLI 与桌面端自动化页共库互斥）。
- **失败退避**：基础设施失败按 60s×2ⁿ 重试（封顶 1h），不计入次数。
- **无人值守权限**：默认 `default` 模式 = 变更类操作自动拒绝，天然只读安全。

### 桌面端（Electron）

- 左侧 Rail：会话 / 插件 / 自动化 / 素材库（规划中）/ 用量 / 设置。
- **输入区四件套**：模型选择（热切）/ 上下文窗口 / 权限模式 / 项目文件夹；`$`（技能）/ `@`（插件与文件）/ `#`（历史会话）引用面板，长粘贴自动转附件。
- **插件页**：MCP 服务器启停与新增、技能/子 Agent 清单、插件与市场管理（安装/卸载/启停）。
- **用量页**：项目聚合 token + 费用估算；**设置页**：供应商管理、API key 录入（渲染层永不接触明文）、连通性测试。
- **演示模式**：无 API key 自动进入（脚本化模型输出 + 真实工具/权限/落盘），`WCODE_DESKTOP_DEMO=1` 强制。
- 安全基线：`contextIsolation + sandbox + nodeIntegration:false`；渲染层与主进程经 v2 桥接协议（类型共享，三条事件流）。

## 配置参考

分层合并：内置默认 < `~/.wcode/settings.json` < `<项目>/.wcode/settings.json` < CLI 覆盖（对象深合并，数组整体替换）。

```jsonc
{
  "activeProvider": "anthropic",
  "model": "claude-sonnet-4-5",
  "providers": {
    "anthropic": {
      "type": "anthropic",
      "apiKeyEnv": "ANTHROPIC_API_KEY"
      // "baseUrl" / "apiKey"（仅用户级）/ "priceInput" / "priceOutput"（$/M tokens）
    }
  },
  "permissions": {
    "mode": "default",
    "allow": ["read(src/**)", "Bash(git *)"],
    "deny": ["read(.env*)"]
  },
  "tools": { "bashTimeoutMs": 120000, "maxOutputChars": 30000 },
  "context": { "maxContextTokens": 200000, "compactThreshold": 0.8 },
  "hooks": { "timeoutMs": 30000, "preToolUse": [{ "matcher": "bash", "command": "node guard.js" }] },
  "mcpServers": { "docs": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-docs"] } },
  "plugins": { "enabled": {}, "blockedBuiltins": [] },
  "storage": { "type": "sqlite" },
  "log": { "level": "info" }
}
```

`~/.wcode/` 目录一览：`settings.json`（配置+密钥）、`wcode.db`（SQLite）、`AGENTS.md`（全局记忆）、`skills/`、`agents/`、`commands/`（用户级扩展）、`plugins/`（cache/marketplaces）、`projects/`（jsonl 分区）、`tasks/`（后台任务日志）、`logs/`（运行日志，`WCODE_LOG=debug` 开调试）。

## 斜杠命令（CLI TUI）

| 命令 | 说明 |
| --- | --- |
| `/help` | 命令清单 |
| `/model` [序号\|名称] | 列出/切换模型（会话内生效） |
| `/skill` <名称> [参数] / `/技能名` | 调用技能 |
| `/plugin` | 插件管理：`list` / `install` / `uninstall` / `enable` / `disable` / `market …` |
| `/init` | 探索仓库并生成/完善 AGENTS.md |
| `/btw` <问题> | 顺带一问：单轮直答，不进入任务上下文 |
| `/compact` | 立即压缩上下文 |
| `/goal` [目标] | 查看/设定任务目标（`/goal clear` 清除） |
| `/reload` | 热重载配置、权限规则、hooks、技能、命令、子 Agent、插件（MCP 连接保持） |
| `/mcp` [名称] | MCP 连接状态与工具清单 |
| `/sessions` [关键词] | 列出最近会话 / 跨会话搜索消息内容 |
| `/resume` [序号] | 恢复历史会话 |
| `/stats` | 项目存储统计（会话/消息/token） |
| `/quit`、`/exit` | 退出 |

内置命令 > 自定义命令（`~/.wcode/commands/`）> 同名技能。TUI 另有：`<Static>` 回滚区、流式 markdown、diff 权限弹窗、todo 实时快照、输入历史上下翻、Ctrl+C 中断/双击退出、`WCODE_UI_SMOKE=1` 无头渲染冒烟。

## 评测集

`packages/evals`：20 个确定性真实任务（编辑/代码理解/多文件/调试/命令/搜索/综合），评分不依赖模型自评——文件断言 / 正则 / JSON 字段 / 命令运行六种检查器，任务跑在临时工作区（bypass 模式的正式用武之地）。

```bash
pnpm eval -- --list                     # 任务清单
pnpm eval                               # 全套（结果写入 evals-results/）
pnpm eval -- --only edit-typo,debug-off-by-one
pnpm eval -- --compare evals-results/<基线>.json   # 与基线对比，▼ 回退 / ▲ 修复
```

换模型、改 system prompt 或核心循环后跑一遍，回退即报警。harness 本身有离线测试（FakeProvider，CI 不花 token）。

## 设计文档

- `coding-agent-功能设计方案.md` —— 总体功能、里程碑与技术选型
- `M1-生产级架构设计.md` —— 分层、五个接缝、错误分类、测试与验收清单
- `packages/desktop/README.md` —— 桌面端架构与已实现能力明细
- `packages/core/plugins-builtin/README.md` —— 内置插件机制与发布说明
- `AGENTS.md` —— 本仓库工程约定（Agent 工作前必读）
