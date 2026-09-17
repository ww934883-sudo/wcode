import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { writeFileAtomic } from "@wcode/core";

type SettingsObject = Record<string, unknown>;

/** 用户级 ~/.wcode/settings.json 读取（主进程专属，渲染层永不接触 key） */
export function readUserSettings(homeDir = homedir()): SettingsObject {
  try {
    return JSON.parse(readFileSync(join(homeDir, ".wcode", "settings.json"), "utf8")) as SettingsObject;
  } catch {
    return {};
  }
}

/** 读改写三段式补丁：只改给定键，其余字段原样保留，原子落盘 */
export async function patchUserSettings(
  patch: (obj: SettingsObject) => void,
  homeDir = homedir(),
): Promise<void> {
  const obj = readUserSettings(homeDir);
  patch(obj);
  await writeFileAtomic(join(homeDir, ".wcode", "settings.json"), JSON.stringify(obj, null, 2));
}
