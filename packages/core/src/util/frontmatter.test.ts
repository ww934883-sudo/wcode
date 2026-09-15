import { describe, expect, it } from "vitest";
import { parseFrontmatter } from "./frontmatter";

describe("parseFrontmatter", () => {
  it("基本解析：键值对 + 正文", () => {
    const r = parseFrontmatter(
      "---\nname: commit-helper\ndescription: 提交辅助\n---\n\n正文第一行\n正文第二行",
    );
    expect(r.data).toEqual({
      name: "commit-helper",
      description: "提交辅助",
    });
    expect(r.body).toBe("正文第一行\n正文第二行");
  });

  it("值中包含冒号时只按第一个冒号切分", () => {
    const r = parseFrontmatter("---\ndescription: 用法: 先读后写\n---\nbody");
    expect(r.data.description).toBe("用法: 先读后写");
  });

  it("无 frontmatter（开头不是 ---）时全文作为正文", () => {
    const r = parseFrontmatter("直接就是正文内容");
    expect(r.data).toEqual({});
    expect(r.body).toBe("直接就是正文内容");
  });

  it("只有 --- 没有闭合时视为无 frontmatter", () => {
    const r = parseFrontmatter("---\nname: broken\n正文也算正文");
    expect(r.data).toEqual({});
    expect(r.body).toContain("name: broken");
  });

  it("CRLF 行尾正常解析", () => {
    const r = parseFrontmatter("---\r\nname: win\r\n---\r\nbody\r\nline2");
    expect(r.data.name).toBe("win");
    expect(r.body).toBe("body\nline2");
  });

  it("frontmatter 中间无冒号的行被跳过", () => {
    const r = parseFrontmatter("---\nname: ok\n这行没有冒号\n---\nbody");
    expect(r.data).toEqual({ name: "ok" });
  });
});
