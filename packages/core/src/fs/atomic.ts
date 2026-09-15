import { mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

const EPERM_RETRY_DELAYS_MS = [50, 200, 500] as const;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 原子写（架构文档 §3.3）：先写同目录临时文件再 rename 覆盖，
 * kill -9 不留半截文件。Windows 下杀软/索引器短暂持锁会报 EPERM/EACCES，
 * 按 50/200/500ms 重试三次后放弃，临时文件总是被清理。
 */
export async function writeFileAtomic(
  filePath: string,
  data: string,
): Promise<void> {
  const dir = dirname(filePath);
  await mkdir(dir, { recursive: true });
  const tmp = join(
    dir,
    `.${basename(filePath)}.${process.pid}.${Date.now()}.tmp`,
  );
  await writeFile(tmp, data, "utf8");
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(tmp, filePath);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      const retryable = code === "EPERM" || code === "EACCES";
      const delay = EPERM_RETRY_DELAYS_MS[attempt];
      if (retryable && delay !== undefined) {
        await sleep(delay);
        continue;
      }
      await unlink(tmp).catch(() => {});
      throw err;
    }
  }
}
