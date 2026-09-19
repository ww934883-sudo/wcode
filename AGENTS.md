# AGENTS.md

本文件是 wcode 仓库的工程约定。wcode 启动时会自动把它加载进系统提示词，作为在本仓库内工作的所有 Agent 的强制长期指令。

## 项目结构

pnpm workspaces 单仓，依赖单向自上而下：

- `packages/core` — 领域核心：agent loop、工具、权限、上下文管理、会话持久化。**禁止**依赖任何 UI 库（ink/react）和模型 SDK。
- `packages/provider-anthropic` — Anthropic Messages 协议适配器（raw fetch + SSE 解析，不用 SDK）。
- `packages/cli` — 终端入口与 ink TUI。UI 代码只能放在 `src/ui/`（`src/bin.tsx` 是唯一例外）。
- `packages/evals` — 确定性评测集（套件名 `wcode-core-v1`，20 个真实任务）。

依赖规则由 dependency-cruiser 在 CI 强制执行（`.dependency-cruiser.cjs`），违规即红。

## 接缝纪律（改代码前先想接缝）

core 通过五个接缝与外界解耦，新增能力优先考虑"放进哪个接缝"，而不是直接 import 具体实现：

1. `ModelProvider` port — 模型协议适配
2. Tool/ToolSource 注册表 — 工具来源（内置 / MCP / 子 Agent）
3. `AgentHost` 反向端口 — core 通知 UI，绝不反向依赖
4. `SessionStore` — 会话持久化
5. `Config` — zod 分层合并（用户级 `~/.wcode/settings.json` → 项目级 → CLI 覆盖）

新协议适配器（如未来的 provider-openai）只依赖 core，绝不反向。

## 语言与代码风格

- TypeScript strict，含 `noUncheckedIndexedAccess`：数组与索引访问返回 `T | undefined`，必须判空。
- 注释、UI 文案、测试描述一律中文；注释只写代码本身表达不了的约束（为什么），不写"这行做了什么"。
- 业务错误不抛进 loop：工具返回结构化的错误结果（isError），说清错在哪、模型该怎么改；`AbortedError` 是唯一允许穿透 pipeline 的异常。

## 工具开发规范

- 新工具用 `defineTool` 定义，放在 `packages/core/src/tools/builtin/`。
- 报错必须"教学式"：给模型可行动的修正信息（例：edit 内容不唯一时展示实际冲突片段），不要丢原始异常文本。
- 工具输出超长会被截断到 `tools.maxOutputChars`（默认 30k 字符），截断提示要说明还剩多少、如何获取全量。
- 只读工具必须正确声明 `isReadOnly`——它决定工具批是否并行执行，以及权限引擎的默认判定。
- Windows 优先：进程终止用进程树 kill，文件操作对 EBUSY/EPERM 做有限重试，路径统一 `node:path`，glob 输出统一正斜杠。

## ink TUI 约定

- 历史 scrollback 用 `<Static>` 渲染：**history 必须不可变追加**（`[...old, item]`），原地 push 会被 useMemo 吞掉、静默不渲染。
- 权限对话框等交互组件必须处理 raw mode 不可用的降级路径（见 `src/ui/lib/tty.ts`）。
- 新组件一律配套 FakeProvider / `--selftest` 或 `WCODE_UI_SMOKE=1` 的无头验证，不依赖真实模型。

## 提交与回归

- **每完成一批代码改动必须立即 commit**（跑完回归就提，不积攒工作区改动），保证任意时点可回滚找回。
- 提交信息：`M1-Wx: 中文摘要`（或里程碑内小结的等价形式），中文描述改动本质。
- 任何改动提交前跑回归三件套：`pnpm typecheck && pnpm lint:deps && pnpm test`。
- 涉及模型行为的改动加跑 `pnpm eval`，用 `--compare` 对比基线（基线报告在 `packages/evals/evals-results/`，已被 .gitignore 排除）。

## 密钥与配置

密钥只放用户级 `~/.wcode/settings.json`（仓库外，provider 的 `apiKey` 字段或 `apiKeyEnv` 环境变量），仓库内 `.wcode/` 已在 .gitignore，任何形式的密钥绝不进入提交。
