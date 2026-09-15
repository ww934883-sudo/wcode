import { describe, expect, it } from "vitest";
import { mapSlashCommand } from "./slash";

const skills = [{ name: "commit" }, { name: "review-code" }];

describe("mapSlashCommand", () => {
  it("命中技能时转换为 skill 工具调用指令", () => {
    expect(mapSlashCommand("/commit", skills)).toBe(
      '请使用 skill 工具加载技能 "commit"，然后严格按技能指令执行。',
    );
  });

  it("附加参数透传", () => {
    const out = mapSlashCommand("/review-code src/core 重点关注类型", skills);
    expect(out).toContain('"review-code"');
    expect(out).toContain("src/core 重点关注类型");
  });

  it("未命中技能原样透传", () => {
    expect(mapSlashCommand("/nope", skills)).toBe("/nope");
    expect(mapSlashCommand("/quit", skills)).toBe("/quit");
  });

  it("非斜杠输入原样透传", () => {
    expect(mapSlashCommand("普通消息", skills)).toBe("普通消息");
  });

  it("允许大小写字母数字连字符下划线的技能名", () => {
    expect(mapSlashCommand("/review-code", skills)).toContain("review-code");
  });
});
