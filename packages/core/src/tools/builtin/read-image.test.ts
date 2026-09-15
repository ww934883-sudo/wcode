import { describe, expect, it } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readTool } from "./read";
import { makeToolContext, makeSession } from "../../testing/fixtures";

describe("read 读图（多模态）", () => {
  it("png 文件返回 base64 图像块", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wcode-img-"));
    try {
      const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01, 0x02]);
      const path = join(dir, "pic.png");
      await writeFile(path, bytes);
      const out = await readTool.execute({ file_path: path }, makeToolContext(makeSession(dir)));
      expect(out.images).toHaveLength(1);
      const img = out.images?.[0];
      expect(img?.mediaType).toBe("image/png");
      expect(Buffer.from(img?.data ?? "", "base64").toString("hex")).toBe(bytes.toString("hex"));
      expect(out.content).toContain("已作为图像内容返回");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("jpg 扩展名映射为 image/jpeg", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wcode-img-"));
    try {
      const path = join(dir, "photo.jpg");
      await writeFile(path, Buffer.from([0xff, 0xd8, 0xff, 0xe0]));
      const out = await readTool.execute({ file_path: path }, makeToolContext(makeSession(dir)));
      expect(out.images?.[0]?.mediaType).toBe("image/jpeg");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("过大图片拒绝读取", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wcode-img-"));
    try {
      const path = join(dir, "huge.png");
      await writeFile(path, Buffer.alloc(6 * 1024 * 1024));
      const out = await readTool.execute({ file_path: path }, makeToolContext(makeSession(dir)));
      expect(out.content).toContain("图片过大");
      expect(out.images).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
