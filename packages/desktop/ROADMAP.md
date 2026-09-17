# 桌面版路线图（M-D 系列）

> 本文件随代码入库：清理会话上下文后，新会话直接读本文件即可续接计划。

## 第 0 步 ✅（本次提交）

桌面版 demo 全量入库：Electron 壳 + `AgentHost` 第四实现（IpcHost）+ 渲染层。
已实现：多会话/多项目（jsonl 持久化，与 CLI 共享 `~/.wcode/projects/`）、跨会话搜索、
检查点分叉、分屏（代码保留，UI 入口待回归）、模型热切、思考级别（UI 偏好）、
权限模式、助理选择、插件页（MCP 启停 + Skills）、用量页、设置页、
CodePilot 式欢迎页（居中问候 + 引导卡）与一体化输入卡。

## M2-D3 ✅：真实模式补质量（已完成）

1. **真实端到端冒烟 ✅**：volcengine key（doubao-seed-code-preview）真跑通过——
   流式回复、thinking=medium/high 预算均被火山 anthropic 兼容端点接受、
   write 权限卡→允许→真实落盘→模型自读回验、jsonl 落盘（与 CLI 共享）、
   重启后 12 条历史全量重放、分屏开关、listModels 三段降级（v1 401 → v3 bearer）。
2. **思考级别接线 ✅**：core `ModelRequest.thinking?`（缺省不传，向后兼容）；
   `AgentSession.setThinkingLevel` 运行期生效（子 Agent 继承，摘要请求不带）；
   anthropic → `thinking{budget_tokens}` low/medium/high = 4k/16k/32k，
   max_tokens 自动抬到预算之上；openai-chat → `reasoning_effort`，
   openai-responses → `reasoning.effort`；desktop 选择器即时生效。
   已知约束：官方 Anthropic 在思考+工具循环时要求回传 thinking 块，
   归一化消息不携带——接官方端点跑工具任务遇 400 时应关思考级别。
3. **错误体验 ✅**：渲染层 `classifyError` 分类——401/403 → 错误卡「打开设置」；
   429/网络 → 「重试」（重发最后一条用户输入）；core 重试倒计时渲染为普通提示。
4. **分屏入口回归 ✅**：侧栏顶部 ⫿ 按钮（高亮态）+ Ctrl+\ 快捷键，激活面板描边。

## M3-D：产品化基座（定位确认后）

1. electron-builder：NSIS 安装包 + 应用图标 + electron-updater 自动更新。
2. CI：tag 触发 Windows 出包（参考 CodePilot 流水线思路，不拷代码——BSL）。
3. 安全审计：key 不进日志、渲染层零接触路径复核、CSP 收紧。
4. 成本统计 ✅：provider 配置加可选 priceInput/priceOutput/priceCurrency
   （单位 priceCurrency/百万 tokens），用量页显示费用估算卡；未配置给配置指引。
5. SQLite 存储回归（Electron 内置 Node 与 `node:sqlite` 版本对齐后；jsonl 先顶）。

## M3-D+：功能补全（按价值排序）

- 定时任务 UI ✅：主进程 AutomationDesk——core AutomationStore 直连
  （与 CLI daemon 共库 claim 互斥防双跑）+ 60s 内置 tick + 进程内 headless
  执行（不开子进程；权限询问自动拒绝，会话 jsonl 落盘可回看）；
  渲染层「定时任务」页：cron/一次性创建、启停、手动运行、运行记录、删除。
  浏览器预览模式为内存 mock。
- 检查点原地回退 ✅：core truncate 标记行（jsonl 标记可恢复/sqlite 真删除，
  重放/列表/搜索/统计四路对拍）+ 桌面用户消息旁 ⏪ 按钮（运行守卫 + 确认框）。
- MCP 配置管理 ✅：插件页增删 server（写用户级 settings，项目级条目引导改文件）；
  新增后立即连接，失败给可读提示。顺带修复：loadConfig 在 demo 模式下未传
  homeDir，设置读写与真实 ~/.wcode 分裂的装配裂缝。
- 图片生成 + 素材库：需媒体类 provider 端口（大）。
- 远程 Bridge（飞书/Telegram）：AgentHost 第五实现（大）。
- 生成式 UI（大，最后）。

## 待定决策

- **定位**：个人工具 / 公司内部工具 / 对外产品——决定 M3-D 优先级
  （内部铺开 → 打包+更新+安全先行；个人用 → 直接补功能）。
