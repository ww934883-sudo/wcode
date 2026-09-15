import type { EvalTask } from "./types";

/**
 * wcode 核心评测套件 v1：20 个真实任务。
 * 原则：种子文件确定、评分确定性（不依赖模型自评）、小而快、覆盖各能力面。
 * 跑分：pnpm eval（需 ANTHROPIC_API_KEY）
 */

const NEEDLE_DIR: Record<string, string> = {
  "src/index.js": "// entry\nimport './a.js';\nimport './b/c.js';\n",
  "src/a.js": "export const tag = 'alpha';\n",
  "src/b/c.js": "// c module\nimport './d/e.js';\nexport const note = 'nothing here';\n",
  "src/b/d/e.js": "// e module\n// TODO: review later\nexport const id = 'e-1';\n",
  "src/util/format.js": "export const fmt = (s) => s.trim();\n",
  "src/util/deep/reader.js": "// data reader\n// marker: NEEDLE-42\nexport const read = () => 'data';\n",
  "src/util/deep/writer.js": "export const write = () => 'ok';\n",
  "docs/readme.txt": "internal docs, no markers\n",
};

export const evalTasks: EvalTask[] = [
  // ── 编辑 ────────────────────────────────────────────────
  {
    id: "edit-typo",
    title: "修正全文拼写错误",
    category: "编辑",
    prompt: "修正 notes.txt 中所有拼写错误：把 recieve 改为 receive，不要改动其他内容。",
    files: {
      "notes.txt": "We recieve the package today.\nPlease recieve it again tomorrow.\n",
    },
    checks: [
      { type: "file_contains", path: "notes.txt", must_all: ["receive"], must_none: ["recieve"] },
    ],
  },
  {
    id: "edit-precise",
    title: "精确修改配置项",
    category: "编辑",
    prompt: "把 config.ini 中 server 段的 timeout 从 30 改为 120，其他内容一律不动。",
    files: {
      "config.ini": "[server]\ntimeout=30\nretries=5\n[log]\nlevel=info\n",
    },
    checks: [
      {
        type: "file_contains",
        path: "config.ini",
        must_all: ["timeout=120", "retries=5", "level=info", "[log]"],
        must_none: ["timeout=30"],
      },
    ],
  },
  {
    id: "create-gitignore",
    title: "新建 .gitignore",
    category: "编辑",
    prompt: "新建 .gitignore 文件，内容为两行：node_modules/ 和 dist/。",
    checks: [
      { type: "file_exists", path: ".gitignore" },
      { type: "file_contains", path: ".gitignore", must_all: ["node_modules/", "dist/"] },
    ],
  },
  {
    id: "edit-css-color",
    title: "修改样式颜色",
    category: "编辑",
    prompt: "style.css 中 .error 的颜色当前是 #fff，请改为 #d33，其他规则不要动。",
    files: {
      "style.css": "body {\n  margin: 0;\n}\n\n.error {\n  color: #fff;\n}\n",
    },
    checks: [
      { type: "file_regex", path: "style.css", pattern: "\\.error\\s*\\{[^}]*#d33" },
      { type: "file_contains", path: "style.css", must_none: ["#fff"] },
    ],
  },

  // ── 代码理解 ────────────────────────────────────────────
  {
    id: "understand-find-fn",
    title: "找到计算面积的函数",
    category: "代码理解",
    prompt: "math.js 里计算圆面积的函数叫什么名字？把函数名（不带括号）写入 answer.txt，只写名字一行。",
    files: {
      "math.js":
        "export function computeCircumference(r) {\n  return 2 * Math.PI * r;\n}\n\nexport function computeArea(r) {\n  return Math.PI * r * r;\n}\n",
    },
    checks: [
      {
        type: "file_contains",
        path: "answer.txt",
        must_all: ["computeArea"],
        must_none: ["computeCircumference"],
      },
    ],
  },
  {
    id: "understand-count",
    title: "统计 ERROR 行数",
    category: "代码理解",
    prompt: "统计 app.log 中包含 ERROR 的行数，把数字写入 count.txt（只写数字）。",
    files: {
      "app.log": [
        "2026-01-01 INFO boot",
        "2026-01-02 ERROR disk full",
        "2026-01-03 INFO tick",
        "2026-01-04 ERROR conn reset",
        "2026-01-05 WARN slow",
        "2026-01-06 INFO tick",
        "2026-01-07 ERROR oom",
        "2026-01-08 ERROR timeout",
        "2026-01-09 INFO tick",
        "2026-01-10 ERROR panic",
        "2026-01-11 ERROR retry fail",
        "2026-01-12 INFO stop",
        "2026-01-13 WARN drain",
        "2026-01-14 ERROR halt",
      ].join("\n") + "\n",
    },
    checks: [{ type: "file_regex", path: "count.txt", pattern: "^\\s*7\\s*$", flags: "m" }],
  },

  // ── 多文件 ──────────────────────────────────────────────
  {
    id: "multi-rename",
    title: "跨文件重命名函数",
    category: "多文件",
    prompt: "把 fetchData 在所有文件里重命名为 httpGet（api.js 的定义与所有 import/调用都要改），不要改变行为。",
    files: {
      "api.js": "export async function fetchData(url) {\n  const res = await fetch(url);\n  return res.json();\n}\n",
      "app.js": "import { fetchData } from './api.js';\n\nexport async function main() {\n  return fetchData('/api/x');\n}\n",
      "test.js": "import { fetchData } from './api.js';\n\nexport const target = fetchData;\n",
    },
    checks: [
      { type: "file_contains", path: "api.js", must_all: ["httpGet"], must_none: ["fetchData"] },
      { type: "file_contains", path: "app.js", must_all: ["httpGet"], must_none: ["fetchData"] },
      { type: "file_contains", path: "test.js", must_all: ["httpGet"], must_none: ["fetchData"] },
    ],
  },
  {
    id: "multi-dead-import",
    title: "移除失效引用",
    category: "多文件",
    prompt: "index.js 引用的 oldUtil 已不存在，请移除对它的 import 与调用，让 main 直接返回数字 42，保持文件可运行。",
    files: {
      "index.js": "import { oldUtil } from './old-util.js';\n\nexport function main() {\n  return oldUtil();\n}\n",
    },
    checks: [
      { type: "file_contains", path: "index.js", must_all: ["42"], must_none: ["oldUtil"] },
    ],
  },

  // ── 调试 ────────────────────────────────────────────────
  {
    id: "debug-off-by-one",
    title: "修复数组越界（运行验证）",
    category: "调试",
    prompt: "sum.js 期望输出数组 [1,2,3,4,5] 的和（15），但当前有 bug。修复它并确保 node sum.js 输出 15 且退出码为 0。",
    files: {
      "sum.js":
        "const arr = [1, 2, 3, 4, 5];\nlet total = 0;\nfor (let i = 0; i <= arr.length; i++) {\n  total += arr[i];\n}\nconsole.log(total);\n",
    },
    checks: [
      { type: "command", command: "node sum.js", expect_exit: 0, output_contains: "15" },
    ],
  },
  {
    id: "debug-broken-json",
    title: "修复非法 JSON",
    category: "调试",
    prompt: "broken.json 当前不是合法 JSON，请修复它（保持字段与值不变）。",
    files: {
      "broken.json": '{\n  "name": "cfg" "retries": 3\n}\n',
    },
    checks: [
      { type: "json_equals", path: "broken.json", field: "name", value: "cfg" },
      { type: "json_equals", path: "broken.json", field: "retries", value: 3 },
    ],
  },
  {
    id: "debug-case-insensitive",
    title: "修复大小写敏感逻辑（跑测试）",
    category: "调试",
    prompt: "palindrome.js 的 isPalindrome 应当大小写不敏感（Level 是回文），当前实现有 bug。修复后确保 node test.js 全部通过（退出码 0）。",
    files: {
      "palindrome.js":
        "export function isPalindrome(s) {\n  const r = [...s].reverse().join('');\n  return s === r;\n}\n",
      "test.js":
        "import { isPalindrome } from './palindrome.js';\nconst cases = [['Level', true], ['hello', false], ['Anna', true]];\nfor (const [s, want] of cases) {\n  if (isPalindrome(s) !== want) {\n    console.error('FAIL ' + s);\n    process.exit(1);\n  }\n}\nconsole.log('ALL PASS');\n",
    },
    checks: [
      { type: "command", command: "node test.js", expect_exit: 0, output_contains: "ALL PASS" },
    ],
  },

  // ── 命令 ────────────────────────────────────────────────
  {
    id: "cmd-version-to-file",
    title: "执行脚本并记录输出",
    category: "命令",
    prompt: "运行 node version.js，把它的输出（版本号）写入 VERSION 文件（只写版本号）。",
    files: {
      "version.js": "console.log('1.2.3');\n",
    },
    checks: [
      { type: "file_regex", path: "VERSION", pattern: "^\\s*1\\.2\\.3\\s*$", flags: "m" },
    ],
  },
  {
    id: "cmd-cleanup-tmp",
    title: "清理临时文件",
    category: "命令",
    prompt: "删除当前工作区里所有 .tmp 文件（包括子目录里的），其他文件不要动。",
    files: {
      "a.tmp": "tmp",
      "b.tmp": "tmp",
      "keep.txt": "keep me",
      "sub/c.tmp": "tmp",
    },
    checks: [
      { type: "file_absent", path: "a.tmp" },
      { type: "file_absent", path: "b.tmp" },
      { type: "file_absent", path: "sub/c.tmp" },
      { type: "file_exists", path: "keep.txt" },
    ],
  },

  // ── 搜索 ────────────────────────────────────────────────
  {
    id: "search-needle",
    title: "多文件定位标记",
    category: "搜索",
    prompt: "在 src/ 目录中找出唯一一个包含 NEEDLE-42 的文件，把它的相对路径（如 src/a.js）写入 found.txt，只写路径一行。",
    files: NEEDLE_DIR,
    checks: [
      {
        type: "file_contains",
        path: "found.txt",
        must_all: ["reader.js"],
        must_none: ["writer.js", "index.js", "a.js", "e.js", "format.js"],
      },
    ],
  },

  // ── 综合 ────────────────────────────────────────────────
  {
    id: "combo-json-bump",
    title: "更新版本号并添加字段",
    category: "综合",
    prompt: "package.json：把 version 改为 2.0.0，并添加字段 \"type\": \"module\"。保持其他字段不变。",
    files: {
      "package.json": '{\n  "name": "demo",\n  "version": "1.0.0"\n}\n',
    },
    checks: [
      { type: "json_equals", path: "package.json", field: "version", value: "2.0.0" },
      { type: "json_equals", path: "package.json", field: "type", value: "module" },
      { type: "json_equals", path: "package.json", field: "name", value: "demo" },
    ],
  },
  {
    id: "combo-readme-section",
    title: "追加 README 小节",
    category: "综合",
    prompt: "在 README.md 末尾追加一个小节：标题为「## 安装」，正文包含 npm install 命令。已有内容不要动。",
    files: {
      "README.md": "# Demo\n\n一个演示项目。\n",
    },
    checks: [
      { type: "file_contains", path: "README.md", must_all: ["# Demo", "一个演示项目。", "## 安装", "npm install"] },
    ],
  },
  {
    id: "combo-csv-total",
    title: "计算 CSV 数量总和",
    category: "综合",
    prompt: "计算 data.csv 中 qty 列的总和，把数字写入 total.txt（只写数字）。",
    files: {
      "data.csv": "item,qty\na,3\nb,5\nc,6\n",
    },
    checks: [{ type: "file_regex", path: "total.txt", pattern: "^\\s*14\\s*$", flags: "m" }],
  },
  {
    id: "combo-i18n",
    title: "补全翻译词条",
    category: "综合",
    prompt: "i18n.js 的 zh 缺少 bye 词条，请补上（值为 再见），en 保持不变。",
    files: {
      "i18n.js": "export const messages = {\n  en: { hello: 'Hello', bye: 'Bye' },\n  zh: { hello: '你好' },\n};\n",
    },
    checks: [
      { type: "file_regex", path: "i18n.js", pattern: "bye:\\s*'再见'" },
      { type: "file_contains", path: "i18n.js", must_all: ["Hello", "你好"] },
    ],
  },
  {
    id: "combo-toc",
    title: "生成文档目录",
    category: "综合",
    prompt: "在 doc.md 的最顶部（# 文档 标题之前不需要保留，插到文件最上面即可）插入目录，用「- 」列表列出三个小节名：背景、方案、风险（保持原内容不丢）。",
    files: {
      "doc.md": "# 文档\n\n## 背景\n背景内容。\n\n## 方案\n方案内容。\n\n## 风险\n风险内容。\n",
    },
    checks: [
      {
        type: "file_contains",
        path: "doc.md",
        must_all: ["- 背景", "- 方案", "- 风险", "## 背景", "背景内容", "风险内容"],
      },
    ],
  },
  {
    id: "combo-triple-edit",
    title: "三项组合修改",
    category: "综合",
    prompt: "完成三处修改：① app.js 中 doWork 重命名为 performWork（定义与调用都要改）；② config.json 的 version 改为 1.1.0；③ notes.txt 中把 teh 修正为 the。",
    files: {
      "app.js": "export function doWork() {\n  return 'working';\n}\n\nexport const run = () => doWork();\n",
      "config.json": '{\n  "version": "1.0.0"\n}\n',
      "notes.txt": "teh quick fix\n",
    },
    checks: [
      { type: "file_contains", path: "app.js", must_all: ["performWork"], must_none: ["doWork"] },
      { type: "json_equals", path: "config.json", field: "version", value: "1.1.0" },
      { type: "file_contains", path: "notes.txt", must_all: ["the quick"], must_none: ["teh"] },
    ],
  },
];
