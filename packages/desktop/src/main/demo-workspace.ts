import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const DEMO_README = `# demo-workspace

这是 wcode 桌面版**演示模式**的示例工作区（位于应用 userData 目录）。

演示脚本会真实地读取本文件、并把一份笔记写入 \`演示笔记.md\`，
中途会触发一次写权限确认——这就是 wcode 权限引擎的完整交互闭环。

配置真实 API key（~/.wcode/settings.json）后重启，即可切换到真实模型对话。
`;

const DEMO_SRC = `// 演示工程入口：一个最小的事件计数器
export function createCounter(start = 0) {
  let n = start;
  return {
    inc: () => ++n,
    get: () => n,
  };
}
`;

/** 准备演示工作区（幂等）：demo 模式的 cwd，工具在这里真实执行 */
export async function prepareDemoWorkspace(userDataDir: string): Promise<string> {
  const dir = join(userDataDir, "demo-workspace");
  await mkdir(join(dir, "src"), { recursive: true });
  await writeFile(join(dir, "README.md"), DEMO_README, "utf8").catch(() => {});
  await writeFile(
    join(dir, "package.json"),
    JSON.stringify({ name: "demo-workspace", private: true, type: "module" }, null, 2),
    "utf8",
  ).catch(() => {});
  await writeFile(join(dir, "src", "index.ts"), DEMO_SRC, "utf8").catch(() => {});
  return dir;
}
