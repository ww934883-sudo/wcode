import type { SkillDefinition } from "@wcode/core";

/**
 * /技能名 [args] → skill 工具调用指令；未命中技能时原样透传
 * （/quit、/exit 在 App 层已拦截，不会走到这里）
 */
export function mapSlashCommand(
  text: string,
  skills: Pick<SkillDefinition, "name">[],
): string {
  const m = /^\/([a-z0-9][a-z0-9_-]*)(?:\s+([\s\S]+))?$/.exec(text.trim());
  if (!m) return text;
  const [, name, args] = m;
  if (!skills.some((s) => s.name === name)) return text;
  return (
    `请使用 skill 工具加载技能 "${name}"${args ? `，附加参数：${args}` : ""}，` +
    "然后严格按技能指令执行。"
  );
}
