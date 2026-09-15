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

## 当前进度（对应里程碑 W1，已完成）

- 主循环（重试/中断/护栏/批内串并行）+ 权限引擎（四模式/规则/会话学习）
- 内置工具 read / write（原子写+盲写保护）/ glob / grep（ripgrep + 降级）
- 工具执行管道（Hook 占位 → 权限 → schema 校验 → 执行 → 截断 → 审计）
- provider-anthropic（SSE 流解析、tool_use 增量拼接、错误分类）
- JSONL 会话持久化、脱敏日志、分层配置、readline REPL

后续（W2）：Edit / Bash 工具、上下文压缩、AGENTS.md、后台任务。
