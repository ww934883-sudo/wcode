# @wcode/desktop — wcode 桌面版

Electron 壳 + React 渲染层的 wcode 桌面客户端。核心能力全部复用 `@wcode/core`：
桌面 UI 只是 `AgentHost` 的第四个实现（接缝三），core 零改动。

## 快速体验

```bash
pnpm desktop          # = 构建 + 启动 Electron 应用
```

- **无 API key**：自动进入**演示模式**——模型输出为本地脚本，但 read/write 工具
  真实执行、写文件弹出真实权限确认、会话真实落盘，完整闭环离线可复现。
- **已有 key**（`~/.wcode/settings.json`）：自动进入**真实模型**，顶栏徽章显示。

浏览器预览（无 Electron，事件由页内脚本回放，供无头验证）：

```bash
pnpm --filter @wcode/desktop build && pnpm --filter @wcode/desktop preview
# http://localhost:4183 （加 --host 可局域网手机访问）
```

强制演示模式（CI 冒烟 / 不消耗 token）：`WCODE_DESKTOP_DEMO=1 pnpm desktop`

## 已实现能力（v2）

- **多会话/多项目**：侧栏按工作目录分组，新建/切换/续聊；jsonl 存储（真实模式与
  CLI 共享 `~/.wcode/projects/` 分区），重启后点历史会话即恢复上下文。
- **跨会话搜索**：侧栏搜索框走 `SessionDriver.search()`，消息级命中。
- **检查点分叉**：用户消息旁 ⟲ 从该轮之前的历史复制出新会话（原会话不动）。
- **分屏双会话**：⫿ 切换双面板，事件按 sessionId 多路复用。
- **输入区四件套**：模型选择（`setProvider` 热切空闲会话）/ 上下文窗口 / 权限模式
  （请求批准·自动批准编辑·完全访问·计划）/ 项目文件夹选择（原生目录对话框）。
- **助理**：侧栏选择自定义 Agent（`discoverAgents`），人设注入 system prompt。
- **插件页**：MCP 服务器启停（启用即时连接共享注册表）+ Skills 清单。
- **用量页**：项目聚合统计 + 最近会话消息量图。
- **设置页**：服务商列表 / 录入 API key / 切换默认服务商（写回用户级 settings.json，
  原子落盘；渲染层永不接触明文）。
- **权限交互**：核心闭环——流式回复 → 工具卡片 → 权限卡（允许一次/总是允许/拒绝）
  → 结果汇报，与 CLI 同一权限引擎。

## 架构

```
渲染层 (React+Vite)  ──window.wcode──▶  preload (contextBridge 白名单)
      ▲                                        │ ipcRenderer.invoke / on
      │                                        ▼
      │                              Electron 主进程
      │                              ├─ IpcHost（AgentHost 第四实现，按 sessionId 复用）
      │                              ├─ DesktopRuntime（会话管理器：多项目/持久化/分叉/MCP/设置）
      │                              └─ AgentSession + SessionDriver（core，未改动）
```

- `src/shared/protocol.ts`：桥接协议 v2（19 个动词 + 3 条事件流），两端共享类型。
- `src/main/runtime.ts`：组合根。会话按需挂载（新建=store 全新 / 打开=resume 语义 /
  分叉=消息行预种），demo 与 real 的 provider 策略在此分支。
- `src/renderer/state.ts`：`AgentEvent` → UI 状态纯归约器 + 历史水合，配套测试。
- 安全：`contextIsolation + sandbox + nodeIntegration:false`；密钥只经主进程写
  `~/.wcode/settings.json`。

## 已知边界

- 素材库（图片生成）与生成式 UI 未实现——需要媒体类 provider 端口，规划中。
- 上下文窗口 / 权限模式 / 助理切换对**新会话**生效；模型选择即时热切。
- SQLite 存储未接（Electron 内置 Node 与 `node:sqlite` 版本待对齐），当前 jsonl。
- 打包（electron-builder NSIS）与自动更新通道未配。
