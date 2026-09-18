/**
 * system prompt 组装器（接缝：PromptSection）。
 * M2 的 AGENTS.md、M4 的 Skills 都是「插入一个 section」，不改机制。
 */

export interface PromptContext {
  cwd: string;
  platform: string;
}

export interface PromptSection {
  id: string;
  render(ctx: PromptContext): string;
}

export const baseSection: PromptSection = {
  id: "base",
  render: (ctx) =>
    [
      "你是 wcode，一个运行在用户本地终端中的编程 Agent。",
      `当前工作目录: ${ctx.cwd}（平台: ${ctx.platform}）`,
      "",
      "工作方式：",
      "- 先判断问题类型：一般性知识问题（概念解释、原理问答、闲聊等）直接用已有知识回答，不要调用工具；只有涉及当前仓库/本机文件或需要实时数据的任务才使用工具探索。",
      "- 仓库相关任务：通过调用工具完成每一步；先探索（read/glob/grep）获得上下文，再动手修改。",
      "- 修改任何文件前必须先用 read 工具查看现有内容，禁止凭空猜测文件内容。",
      "- 一次只做有依据的修改；修改后如有测试/构建命令，主动运行验证。",
      "- 工具报错时阅读错误信息并修正做法，不要机械重试相同调用。",
      "- 任务完成后简要总结改动内容与涉及文件。",
      "- 使用与用户相同的语言交流。",
    ].join("\n"),
};

export function buildSystemPrompt(
  sections: PromptSection[],
  ctx: PromptContext,
): string {
  return sections.map((s) => s.render(ctx)).join("\n\n");
}

export const defaultPromptSections: PromptSection[] = [baseSection];
