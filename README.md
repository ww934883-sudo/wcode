# wcode

运行在终端里的编程 Agent（类 Claude Code / ZCode 形态）。Monorepo，TypeScript + Node.js ≥ 24（node:sqlite 会话库要求；Node 20/22 老环境可在 settings.json 配 storage.type="jsonl" 回退）。

## 结构与依赖铁律

```
packages/
├─ core/                  # @wcode/core —— 引擎：循环/权限/工具管道/会话/配置/日志（无 UI、无模型 SDK）
├─ provider-anthropic/    # @wcode/provider-anthropic —— Anthropic 协议适配（fetch + SSE，零 SDK 依赖）
└─ cli/                  # @wcode/cli —— 组合根 + readline TUI（bin: wcode）
```

依赖单向（CI 用 dependency-cruiser 强制，见 `.dependency-cruiser.cjs`）：

- `core` 禁止依赖 cli / provider-* / 任何模型 SDK；
- `provider-*` 只准依赖 `@wcode/core` 与自身；
- `cli` 是组合根可依赖一切，TUI 代码只准在 `cli/src/ui/` 内（bin.ts 装配除外）。

## 快速开始

```bash
pnpm install
pnpm test                 # 全部单测 + e2e（150 用例，无需网络）
pnpm dev -- --selftest    # 无网络自检：验证 Agent 循环与工具管道
pnpm lint:deps            # 依赖门禁
pnpm typecheck            # 四包严格类型检查

# 配置 API key 后进入交互
export ANTHROPIC_API_KEY=sk-xxx
pnpm dev -- --mode=acceptEdits
```

## 配置（分层：默认 < 全局 < 项目 < CLI）

`~/.wcode/settings.json` / `.wcode/settings.json`：

```json
{
  "activeProvider": "anthropic",
  "model": "claude-sonnet-4-5",
  "providers": {
    "anthropic": { "type": "anthropic", "apiKeyEnv": "ANTHROPIC_API_KEY" }
  },
  "permissions": {
    "mode": "default",
    "allow": ["read(src/**)"],
    "deny": ["read(.env*)"]
  },
  "log": { "level": "info" }
}
```

provider `type` 支持三种协议（同一套工具/权限/上下文机制，只换协议适配层）：

| type | 协议 | 适用 |
| --- | --- | --- |
| `anthropic` | Anthropic Messages（`/v1/messages`） | Claude 官方、火山 codingPlan（`baseUrl: https://ark.cn-beijing.volces.com/api/coding`） |
| `openai-compatible` | OpenAI Chat Completions（`/chat/completions`） | DeepSeek / Qwen / GLM / Kimi 官方 API；火山 codingPlan 也可用 `baseUrl: https://ark.cn-beijing.volces.com/api/coding/v3` |
| `openai-responses` | OpenAI Responses（`/responses`） | OpenAI 官方 |

切换 provider 示例（跨模型评测对比直接换 `activeProvider` + `model` 后跑 `pnpm eval --compare`）：

```json
{
  "activeProvider": "deepseek",
  "model": "deepseek-chat",
  "providers": {
    "deepseek": {
      "type": "openai-compatible",
      "apiKeyEnv": "DEEPSEEK_API_KEY",
      "baseUrl": "https://api.deepseek.com/v1"
    }
  }
}
```

权限模式：`plan`（只读）/ `default`（变更需确认）/ `acceptEdits`（文件编辑放行）/ `bypass`（全放行）。
规则格式 `Tool(pattern)`，pattern 走 glob（`**` 跨目录、`*` 不跨目录）。
调试日志：`WCODE_LOG=debug`，落盘 `~/.wcode/logs/`；会话记录默认存 SQLite 单库 `~/.wcode/wcode.db`（WAL，按项目哈希分区；首次启动自动导入旧 JSONL 且不删原文件），`storage.type: "jsonl"` 时走 `~/.wcode/projects/<路径哈希>/` 旧目录形态。

## 设计文档

- `coding-agent-功能设计方案.md` —— 总体功能、里程碑与技术选型
- `M1-生产级架构设计.md` —— 分层、五个接缝、错误分类、测试与验收清单

## 当前进度（M1 全部完成，M2 首批能力已落地）

- 主循环（重试/中断/护栏/批内串并行）+ 权限引擎（四模式/规则/会话学习）
- 内置工具 read（含读图多模态）/ write（原子写+盲写保护）/ edit（唯一匹配+过期保护）/
  glob / grep（ripgrep+降级）/ bash（超时进程树清理+后台任务）/ task_output / task_stop
- **子 Agent**：task 工具派生独立上下文子循环，readonly/all 工具子集，
  权限继承且可收紧，过程事件转发 UI，结果只回传结论
- **MCP 接入**：官方 SDK，`mcpServers` 配置，工具命名空间化 `mcp__<server>__<tool>`，
  连接失败降级跳过；InMemoryTransport 契约测试
- **会话恢复**：`wcode --continue` 接最近一次会话（存储重放；SQLite/jsonl 双实现契约对拍）
- 上下文管理：微清理（旧工具结果占位）+ 自动压缩（结构化摘要回填）
- AGENTS.md 项目记忆（兼容 CLAUDE.md）、Todo 清单、diff 确认
- 工具执行管道（Hooks → 权限 → schema 校验 → 执行 → 截断 → 审计）
- provider-anthropic（SSE 流解析、tool_use 增量拼接、图像块映射、错误分类）
- SQLite 会话持久化（`node:sqlite` 零依赖、schema_migration 版本化迁移、JSONL→SQLite 幂等导入、`storage.type` 开关）、脱敏日志、分层配置
- ink TUI 组件化渲染（Static 回滚区 + 流式 markdown + diff 弹窗 + todo 快照）
- 评测集 20 任务（glm-5.3-flash 实跑 20/20 基线）
- **Skills**：`skill` 工具按需加载指令，系统提示只放清单（渐进披露），`/技能名` 直接调用
- **Hooks**：`sessionStart` / `preToolUse` / `postToolUse` 三个生命周期事件，
  退出码 2 阻断（仅 pre），其余非零记告警不阻断
- **自定义子 Agent**：`.wcode/agents/*.md` 定义专属子 Agent（正文=system prompt，
  tools=工具白名单），task 工具按名字派生

测试与门禁：205 用例全绿；dependency-cruiser 依赖单向门禁；四包严格 TS；
`wcode --selftest` 无网络自检；`WCODE_UI_SMOKE=1 pnpm dev` UI 渲染管线冒烟。

## TUI（ink 组件化）

cli/src/ui 为 ink + React 实现：已完成内容走 `<Static>` 进终端回滚区
（用户/助手消息、工具行、todo 快照、用量），底部动态区渲染流式 markdown
（标题/列表/代码块/行内码）、运行中工具、任务清单与权限弹窗。
权限弹窗展示 edit/write 的着色 diff（y/a/n/Esc 决策）；输入框支持历史上下翻；
Ctrl+C 中断任务、两秒内再按退出。markdown 与 diff 为纯函数模块（有单测），
InkHost 是 AgentHost 的第二个实现（接缝三），core 零改动。

## 自动化（无头模式）

`wcode -p` 让 wcode 作为管道组件被脚本/CI/定时任务调用：不进 TUI，
进度（工具行/错误）写 **stderr**，最终结果写 **stdout**，跑完即退出。

```bash
wcode -p "运行 pnpm test 并修复失败用例"        # 直接执行
echo "总结今天的 git log" | wcode -p -          # 任务从 stdin 读（管道）
git diff | wcode -p - "审查这段 diff 的安全问题"
wcode -p --output-format=json "检查依赖"        # JSON 输出 {status, reply, usage, model, sessionId}
wcode -p -c "跟进上一会话的任务"                 # 无头续跑最近会话（配定时任务用）
```

- **退出码**：0 成功（含 max_turns，会提示不完整）；1 运行错误；2 配置错误。
- **权限**：无头模式无人确认，权限询问**自动拒绝**（stderr 可见）。
  需要放行时：`--mode=acceptEdits`（编辑放行）、`--mode=bypass`（全放行，慎用）、
  或在 settings.json 配 `permissions.allow` 规则。
- **定时任务示例**（Windows 计划任务 / crontab 每晚跑）：
  `wcode -p -c "检查未完成任务并继续推进，没有则汇报全部完成"`
- Skills、hooks、子 Agent、AGENTS.md 在无头模式下同样生效。

## Skills / Hooks / 自定义子 Agent（M2）

### 斜杠命令

交互中直接输入：

| 命令 | 说明 |
| --- | --- |
| `/help` | 显示命令清单 |
| `/model` | 列出 provider 端点可用模型（不支持时降级手输） |
| `/model` <序号|名称> | 切换模型（会话内生效，/btw 等同步跟随） |
| `/skill` | 列出可用技能 |
| `/skill` <名称> [参数] / `/技能名` | 调用技能 |
| `/init` | 探索仓库并生成/完善 AGENTS.md |
| `/btw` <问题> | 顺带一问：单轮直答，不进入任务上下文 |
| `/compact` | 立即压缩上下文（结构化摘要 + 最近消息） |
| `/goal` [目标] | 查看/设定任务目标（并入 system prompt，压缩后依然有效）；`/goal clear` 清除 |
| `/reload` | 热重载配置、权限规则、hooks、技能与子 Agent 定义（MCP 连接与 provider 保持不变） |
| `/mcp` [名称] | 查看 MCP 服务器连接状态、命令与工具清单 |
| `/resume` [序号] | 列出历史会话；`/resume 2` 恢复第 2 个（当前会话也在列表中，内容已落盘不丢失） |
| `/quit`、`/exit` | 退出 |

内置命令优先于同名技能；未知命令会报错提示 `/help`。

### Skills（技能）

放置位置（同名项目级覆盖用户级）：

- 用户级：`~/.wcode/skills/<技能名>/SKILL.md`
- 项目级：`<项目>/.wcode/skills/<技能名>/SKILL.md`

```markdown
---
name: commit-helper
description: 提交代码时使用，按仓库约定生成提交信息
---

第一步：读取仓库 AGENTS.md 中的提交约定
第二步：……
```

- 系统提示只注入「名字 + 描述」清单（渐进披露），正文由 `skill` 工具按需加载；
- 模型在任务匹配时自行调用，用户也可以输入 `/commit-helper 附加参数` 直接调用；
- 名字需匹配 `[a-z0-9][a-z0-9_-]*`，description 缺省时取正文首行。

### Hooks（生命周期钩子）

`~/.wcode/settings.json` 或项目 `.wcode/settings.json`：

```json
{
  "hooks": {
    "timeoutMs": 30000,
    "preToolUse": [
      { "matcher": "bash", "command": "node scripts/guard-dangerous.js" }
    ],
    "postToolUse": [
      { "matcher": "write|edit", "command": "node scripts/notify.js" }
    ],
    "sessionStart": [{ "command": "node scripts/print-env.js" }]
  }
}
```

- hook 进程从 stdin 收到 JSON：`{ event, cwd, toolName?, toolInput?, timestamp }`；
- **退出码 0** 放行；**退出码 2** 阻断本次工具调用（stderr/stdout 为原因，
  仅 `preToolUse` 有效）；其余退出码记告警不阻断；
- `matcher` 是对工具名的正则（如 `"write|edit"`），缺省匹配全部工具；
- 超时（`timeoutMs`，默认 30s）强制终止并记告警；hook 对主 Agent 与子 Agent 均生效。

### 自定义子 Agent

放置位置（同名项目级覆盖用户级）：

- 用户级：`~/.wcode/agents/<名字>.md`
- 项目级：`<项目>/.wcode/agents/<名字>.md`

```markdown
---
name: reviewer
description: 只读代码审查，输出问题清单
tools: read, glob, grep
---

你是代码审查员。检查给定文件的安全与质量问题，输出分级问题清单。
```

- 正文成为子 Agent 的 system prompt；`tools` 是工具白名单（逗号分隔），
  `all` = 全部内置工具，缺省 `readonly`（只读集）；`task` 永远不进入子 Agent（防递归）；
- 模型通过 task 工具的 `subagent: "reviewer"` 参数派生，可用列表动态注入工具描述；
- 继承权限引擎（写操作仍需用户确认）与 hooks。

## 评测集（真实任务基线）

`packages/evals`：20 个确定性任务（编辑/代码理解/多文件/调试/命令/搜索/综合），
评分不依赖模型自评（文件断言 + 命令运行 + JSON 字段比对）。

```bash
pnpm eval -- --list                    # 查看任务清单
pnpm eval                              # 跑全套（需配置 provider，结果写入 evals-results/）
pnpm eval -- --only edit-typo,debug-off-by-one
pnpm eval -- --compare evals-results/<基线>.json   # 与基线对比，找回退/修复
```

每次换模型、改 system prompt 或核心循环后跑一遍，回退即报警。
harness 本身有离线测试（FakeProvider 驱动，CI 不花 token）。

后续：provider-openai 适配器（DeepSeek/Qwen/GLM 官方 API + 跨模型评测对比）、
Skills/Hooks 的 eval 任务扩充。
