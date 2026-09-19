import { describe, expect, it } from "vitest";
import { parseHooksFile, argvToShellCommand } from "./hooks-file";
import { configSchema } from "../config/schema";

describe("parseHooksFile", () => {
  it("zcode hooks.json 七事件格式 → wcode HookDef（matcher 组展开、timeout 秒转毫秒）", () => {
    const { events, problems } = parseHooksFile(
      {
        PreToolUse: [
          { matcher: "Bash|write", hooks: [{ type: "command", command: "echo hi", timeout: 5 }] },
        ],
        SessionStart: [{ hooks: [{ type: "command", command: "echo start" }] }],
        Stop: [{ hooks: [{ type: "command", command: "echo stop" }] }],
      },
      "测试插件",
    );
    expect(problems).toEqual([]);
    const merged = configSchema.parse({ hooks: events }).hooks;
    expect(merged.preToolUse).toEqual([{ matcher: "Bash|write", command: "echo hi", timeoutMs: 5000 }]);
    expect(merged.sessionStart).toEqual([{ command: "echo start" }]);
    expect(merged.stop).toEqual([{ command: "echo stop" }]);
  });

  it("process 类型（argv）拼接为 shell 串", () => {
    const { events } = parseHooksFile(
      {
        UserPromptSubmit: [
          { hooks: [{ type: "process", command: ["node", "my hook.js", "--flag=1"] }] },
        ],
      },
      "测试插件",
    );
    const merged = configSchema.parse({ hooks: events }).hooks;
    expect(merged.userPromptSubmit[0]?.command).toContain('"my hook.js"');
    expect(merged.userPromptSubmit[0]?.command).toMatch(/^node/);
  });

  it("未知事件报 problem 不阻塞其余事件", () => {
    const { events, problems } = parseHooksFile(
      {
        NotAnEvent: [{ hooks: [{ command: "x" }] }],
        PostToolUse: [{ hooks: [{ command: "y" }] }],
      },
      "测试插件",
    );
    expect(problems.join("\n")).toContain("NotAnEvent");
    expect(events.postToolUse).toHaveLength(1);
  });

  it("整个文件结构非法时报问题并返回空事件", () => {
    const { events, problems } = parseHooksFile({ PreToolUse: "oops" }, "测试插件");
    expect(events).toEqual({});
    expect(problems.join("\n")).toContain("不合法");
  });
});

describe("argvToShellCommand", () => {
  it("无空白参数直接拼接，含空白/引号的参数加引号", () => {
    expect(argvToShellCommand(["node", "server.js"])).toBe("node server.js");
    expect(argvToShellCommand(["node", "my script.js"])).toBe('node "my script.js"');
  });
});
