# 桌面版路线图（M-D 系列）

> 本文件随代码入库：清理会话上下文后，新会话直接读本文件即可续接计划。

## 第 0 步 ✅（本次提交）

桌面版 demo 全量入库：Electron 壳 + `AgentHost` 第四实现（IpcHost）+ 渲染层。
已实现：多会话/多项目（jsonl 持久化，与 CLI 共享 `~/.wcode/projects/`）、跨会话搜索、
检查点分叉、分屏（代码保留，UI 入口待回归）、模型热切、思考级别（UI 偏好）、
权限模式、助理选择、插件页（MCP 启停 + Skills）、用量页、设置页、
CodePilot 式欢迎页（居中问候 + 引导卡）与一体化输入卡。

## M2-D3：真实模式补质量（下一冲刺）

1. **真实端到端冒烟**：用已配置的 volcengine key 真跑对话 + 工具调用，
   验证流式/权限/持久化在真实 provider 下的表现（目前只验证过装配）。
2. **思考级别接线**：core `ModelRequest` 加可选 thinking 字段（向后兼容）；
   provider-anthropic → thinking budget，openai 系 → reasoning_effort；
   volcengine 端点优先接。
3. **错误体验**：401/429/网络错误给可行动提示（跳设置页 / 重试按钮）。
4. **分屏入口回归**：侧栏顶部或 Ctrl+\ 快捷键（功能代码在，入口已按需求移除）。

## M3-D：产品化基座（定位确认后）

1. electron-builder：NSIS 安装包 + 应用图标 + electron-updater 自动更新。
2. CI：tag 触发 Windows 出包（参考 CodePilot 流水线思路，不拷代码——BSL）。
3. 安全审计：key 不进日志、渲染层零接触路径复核、CSP 收紧。
4. 成本统计：provider 定价换算，用量页显示费用。
5. SQLite 存储回归（Electron 内置 Node 与 `node:sqlite` 版本对齐后；jsonl 先顶）。

## M3-D+：功能补全（按价值排序）

- 定时任务 UI：core automation 模块现成，只差界面（小）。
- 检查点原地回退：现在只有分叉（中）。
- MCP 配置管理：增删改 server，现在只读 + 启停（中）。
- 图片生成 + 素材库：需媒体类 provider 端口（大）。
- 远程 Bridge（飞书/Telegram）：AgentHost 第五实现（大）。
- 生成式 UI（大，最后）。

## 待定决策

- **定位**：个人工具 / 公司内部工具 / 对外产品——决定 M3-D 优先级
  （内部铺开 → 打包+更新+安全先行；个人用 → 直接补功能）。
