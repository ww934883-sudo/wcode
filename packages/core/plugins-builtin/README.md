# 内置插件（plugins-builtin）

本目录下的插件随 wcode 应用分发，对齐 zcode 内置官方插件的行为：

- **browser-use** — 浏览器操作：远程调试端口驱动 Chrome/Edge，打开页面、执行 JS、
  点击填表、截图、读取渲染后内容（`scripts/cdp.js` 为零依赖 CDP 客户端，要求 Node ≥ 22）。
- **computer-use** — 电脑控制：屏幕截图、鼠标点击、键盘输入、进程与窗口管理
  （Windows PowerShell 脚本，macOS/Linux 给等价命令；PS1 已带 UTF-8 BOM，
  不要用无 BOM 编辑器重存，否则中文会按 ANSI 解码炸掉）。

## 机制

- CLI（bootstrap）与桌面端（runtime.init）启动时把本目录插件"播种"到
  `~/.wcode/plugins/cache/wcode-builtin/<名>/<版本>/`，默认启用；
- 版本号变更后自动重播种并清理旧版本；用户卸载过的记入
  `~/.wcode/settings.json` 的 `plugins.blockedBuiltins`，不随升级装回；
- 组件与普通插件一致：技能名 `插件名:技能名`；技能/命令正文可用
  `${WCODE_PLUGIN_ROOT}`（指向已播种的插件根）与 `${WCODE_PROJECT_DIR}` 引用自带脚本。

## 增改须知

- 新增内置插件：在本目录建插件包（`.zcode-plugin/plugin.json` + 组件目录），
  `packages/core/src/plugins/builtin.test.ts` 的 smoke 测试会自动覆盖到。
- 发布新版本：改对应插件的 `version` 即可，播种器按版本号识别升级。
- 打包发布（electron-builder 等）：把本目录配置为随包资源，并用
  `WCODE_BUILTIN_PLUGINS_DIR` 指向其解包路径（开发态两者都会自动定位到仓库路径）。
