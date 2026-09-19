---
name: control-browser
description: 需要操作浏览器/网页时使用——打开页面、点击、填表、截图、读取渲染后内容、验证前端改动效果。纯后端 HTTP 抓取、无浏览器参与的任务不要使用。
---

# 浏览器操作（CDP）

原理：以远程调试端口启动 Chromium 系浏览器（Chrome/Edge），用插件自带零依赖脚本
`scripts/cdp.js` 通过 CDP 协议下发命令。脚本路径已用 `${WCODE_PLUGIN_ROOT}` 写死，直接复制执行即可。

**第零步：探测 shell 语法。** wcode 的 bash 工具在桌面端可能落到 PowerShell：

```bash
echo $BASH_VERSION          # 有输出 = bash；报错/为空 = PowerShell
```

下面启动浏览器的命令按 shell 二选一；`node cdp.js ...` 的调用两种 shell 通用。

## 第一步：启动浏览器（带调试端口，后台）

Windows 优先 Edge（系统必有），按顺序探测可执行文件：

```
C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe
C:\Program Files\Microsoft\Edge\Application\msedge.exe
C:\Program Files\Google\Chrome\Application\chrome.exe
C:\Program Files (x86)\Google\Chrome\Application\chrome.exe
```

**PowerShell（桌面端缺省）**——`Start-Process` 天然后台、立即返回，不要加 `&`：

```powershell
Start-Process -FilePath "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" -ArgumentList '--remote-debugging-port=9222', "--user-data-dir=$env:TEMP\wcode-browser-profile", '--no-first-run', '--no-default-browser-check', '--headless=new', 'about:blank'
```

**bash（CLI/Git Bash）**——末尾 `&` 后台：

```bash
"C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe" \
  --remote-debugging-port=9222 \
  --user-data-dir="${TMPDIR:-/tmp}/wcode-browser-profile" \
  --no-first-run --no-default-browser-check --headless=new about:blank &
```

要点：
- `--user-data-dir` 必须是独立临时目录（否则并入日常实例、调试端口失效）。
- 无界面任务（截图/抓取）加 `--headless=new`（旧 `--headless` 截图有兼容问题）；
  需要人工看效果的验证类任务去掉该参数。

## 第二步：确认就绪

```bash
node "${WCODE_PLUGIN_ROOT}/scripts/cdp.js" tabs
```

连接失败可等 1~2 秒重试（浏览器启动需要时间）。

## 命令一览

| 命令 | 作用 |
|---|---|
| `tabs` | 列出所有标签页（序号 / targetId / 标题 / URL） |
| `open <url> [--tab 序号或id]` | 在指定（缺省当前）标签页导航；`--new` 新开标签页 |
| `eval "<js>"` | 在页面里执行 JS，输出返回值（支持 await/async IIFE） |
| `text` | 输出页面全文（document.body.innerText） |
| `shot <输出.png>` | 截图保存，用 read 工具查看图片验证效果 |
| `close` | 关闭标签页（`--tab`）；不带参数关闭整个浏览器 |

全局参数：`--port 9222`（调试端口，与启动参数一致）。

## 常见自动化模式（都用 eval 实现）

```bash
# 点击：优先真实元素 click()
node cdp.js eval "document.querySelector('button.submit').click()"

# 填表：React/Vue 受控输入要用原生 setter + 派发事件，直接赋值不生效
node cdp.js eval "(() => { const el = document.querySelector('#kw'); const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set; set.call(el, '搜索词'); el.dispatchEvent(new Event('input', { bubbles: true })); return el.value; })()"

# 等待元素出现（脚本本身不等待，用轮询）
node cdp.js eval "(async () => { for (let i = 0; i < 50; i++) { const el = document.querySelector('.result'); if (el) return el.innerText; await new Promise(r => setTimeout(r, 200)); } return 'TIMEOUT'; })()"

# 读表格/列表结构，先看 DOM 再写选择器
node cdp.js eval "document.querySelectorAll('li.item').length"
```

百度搜索的最短路径：`open https://www.baidu.com` → eval 填 `#kw`（上面的受控输入写法，key 用 `#kw`、事件 `input`）→ eval `document.getElementById('su').click()`（"百度一下"按钮）→ `text` 或 `shot` 验证结果。

## 收尾与排错

- 结束后执行 `node cdp.js close` 关闭浏览器，不留孤儿进程。
- `连接被拒绝/无法连接`：浏览器没起来或端口不一致；PowerShell 里重跑 Start-Process 前先确认上一个实例已退出。
- 起了但 tabs 为空/受控输入不生效：确认 `--user-data-dir` 是全新目录。
- **每次任务用全新的 `--user-data-dir` 目录**（如拼上时间戳）：上次实例未完全退出时，
  复用目录会让新实例直接退出（单例锁），表现为端口无人监听。
- 截图全黑：无头模式确认用的是 `--headless=new`。
- **遇到「百度安全验证」等验证码/反爬页**：无头浏览器 + 全新 profile 容易触发。
  先 `shot` 确认；解决途径是改用非无头模式（去掉 `--headless=new`）复用日常 profile，
  或把验证码环节交由用户人工完成，不要反复重试提交。
