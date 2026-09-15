# wcode

运行在终端里的编程 Agent（类 Claude Code / ZCode 形态）。Monorepo，TypeScript + Node.js ≥ 20。

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
pnpm test                 # 全部单测 + e2e（62 用例，无需网络）
pnpm dev -- --selftest    # 无网络自检：验证 Agent 循环与工具管道
pnpm lint:deps            # 依赖门禁
pnpm typecheck            # 三包严格类型检查

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

权限模式：`plan`（只读）/ `default`（变更需确认）/ `acceptEdits`（文件编辑放行）/ `bypass`（全放行）。
规则格式 `Tool(pattern)`，pattern 走 glob（`**` 跨目录、`*` 不跨目录）。
调试日志：`WCODE_LOG=debug`，落盘 `~/.wcode/logs/`；会话记录 `~/.wcode/projects/<路径哈希>/`。

## 设计文档

- `coding-agent-功能设计方案.md` —— 总体功能、里程碑与技术选型
- `M1-生产级架构设计.md` —— 分层、五个接缝、错误分类、测试与验收清单

## 当前进度（对应里程碑 W3，已完成）

- 主循环（重试/中断/护栏/批内串并行）+ 权限引擎（四模式/规则/会话学习）
- 内置工具 read（含读图多模态）/ write（原子写+盲写保护）/ edit（唯一匹配+过期保护）/
  glob / grep（ripgrep+降级）/ bash（超时进程树清理+后台任务）/ task_output / task_stop
- **子 Agent**：task 工具派生独立上下文子循环，readonly/all 工具子集，
  权限继承且可收紧，过程事件转发 UI，结果只回传结论
- **MCP 接入**：官方 SDK，`mcpServers` 配置，工具命名空间化 `mcp__<server>__<tool>`，
  连接失败降级跳过；InMemoryTransport 契约测试
- **会话恢复**：`wcode --continue` 接最近一次会话（JSONL 重放）
- 上下文管理：微清理（旧工具结果占位）+ 自动压缩（结构化摘要回填）
- AGENTS.md 项目记忆（兼容 CLAUDE.md）、Todo 清单、diff 确认
- 工具执行管道（Hook 占位 → 权限 → schema 校验 → 执行 → 截断 → 审计）
- provider-anthropic（SSE 流解析、tool_use 增量拼接、图像块映射、错误分类）
- JSONL 会话持久化、脱敏日志、分层配置、readline REPL

测试与门禁：100 用例全绿；dependency-cruiser 依赖单向门禁；三包严格 TS；
`wcode --selftest` 无网络自检。

后续（W3 后半）：ink TUI 重构、自定义子 Agent 配置、Skills/Hooks、评测集。
