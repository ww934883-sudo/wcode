import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Message } from "../types";
import { errorMessage } from "../errors";
import type { Logger } from "../logging/port";

/** 会话持久化格式 v1（架构文档 §4.3）。append-only，逐行带版本号。 */
export type SessionLine =
  | { v: 1; type: "meta"; sessionId: string; createdAt: string; cwd: string }
  | { v: 1; type: "message"; message: Message }
  | { v: 1; type: "event"; event: Record<string, unknown> };

export interface SessionStore {
  append(line: SessionLine): Promise<void>;
  /** resume 时重放；损坏行跳过并告警，不阻塞恢复 */
  load(): Promise<SessionLine[]>;
}

export class JsonlSessionStore implements SessionStore {
  private mkdirPromise?: Promise<void>;

  constructor(
    private readonly filePath: string,
    private readonly log?: Logger,
  ) {}

  async append(line: SessionLine): Promise<void> {
    await this.ensureDir();
    await appendFile(this.filePath, JSON.stringify(line) + "\n", "utf8");
  }

  async load(): Promise<SessionLine[]> {
    let raw: string;
    try {
      raw = await readFile(this.filePath, "utf8");
    } catch {
      return [];
    }
    const lines: SessionLine[] = [];
    for (const l of raw.split("\n")) {
      const trimmed = l.trim();
      if (!trimmed) continue;
      try {
        lines.push(JSON.parse(trimmed) as SessionLine);
      } catch {
        this.log?.warn("会话文件存在损坏行，已跳过", { filePath: this.filePath });
      }
    }
    return lines;
  }

  private ensureDir(): Promise<void> {
    if (!this.mkdirPromise) {
      this.mkdirPromise = mkdir(dirname(this.filePath), { recursive: true }).then(
        () => undefined,
        (err: unknown) => {
          throw new Error(`会话目录不可写: ${errorMessage(err)}`);
        },
      );
    }
    return this.mkdirPromise;
  }
}

/** 项目路径 → 存储子目录哈希（djb2），避免路径里的非法字符 */
export function projectDirHash(cwd: string): string {
  let hash = 5381;
  for (let i = 0; i < cwd.length; i++) {
    hash = ((hash << 5) + hash + cwd.charCodeAt(i)) | 0;
  }
  return (hash >>> 0).toString(36);
}
