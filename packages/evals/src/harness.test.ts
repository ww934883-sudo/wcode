import { describe, expect, it } from "vitest";
import { runEvalTask, compareReports, SUITE_NAME } from "./harness";
import { FakeProvider, endTurn, toolUseTurn } from "@wcode/core/testing";
import { evalTasks } from "./tasks";
import type { SuiteReport } from "./types";

describe("评测 harness（离线，FakeProvider）", () => {
  it("任务通过：模型按预期写文件，确定性 grader 给 PASS", async () => {
    const result = await runEvalTask(
      {
        id: "t-ok",
        title: "写文件",
        category: "测试",
        prompt: "创建 out.txt 内容 done-42",
        checks: [{ type: "file_contains", path: "out.txt", must_all: ["done-42"] }],
      },
      {
        provider: new FakeProvider([
          {
            response: toolUseTurn([
              { id: "c1", name: "write", input: { file_path: "out.txt", content: "done-42\n" } },
            ]),
          },
          { response: endTurn("完成") },
        ]),
        taskTimeoutMs: 5000,
      },
    );
    expect(result.status).toBe("passed");
    expect(result.pass).toBe(true);
    expect(result.failedChecks).toHaveLength(0);
  });

  it("任务失败：写错内容 → failedChecks 指出差异，工作区保留", async () => {
    const result = await runEvalTask(
      {
        id: "t-bad",
        title: "写错文件",
        category: "测试",
        prompt: "创建 out.txt 内容 done-42",
        checks: [{ type: "file_contains", path: "out.txt", must_all: ["done-42"] }],
      },
      {
        provider: new FakeProvider([
          {
            response: toolUseTurn([
              { id: "c1", name: "write", input: { file_path: "out.txt", content: "wrong" } },
            ]),
          },
          { response: endTurn("完成") },
        ]),
        taskTimeoutMs: 5000,
      },
    );
    expect(result.status).toBe("failed");
    expect(result.failedChecks[0]).toContain("缺少内容");
    expect(result.workspace).toBeTruthy(); // 失败保留工作区
  });

  it("grader 能力：json_equals / file_absent / file_exists / file_regex / command", async () => {
    const result = await runEvalTask(
      {
        id: "t-graders",
        title: "grader 自检",
        category: "测试",
        prompt: "什么都不用做",
        files: {
          "pkg.json": '{"version":"1.0.0"}',
          "keep.txt": "x",
          "reg.txt": "color: #d33;",
        },
        checks: [
          { type: "json_equals", path: "pkg.json", field: "version", value: "1.0.0" },
          { type: "file_absent", path: "not-there.txt" },
          { type: "file_exists", path: "keep.txt" },
          { type: "file_regex", path: "reg.txt", pattern: "#d33" },
          { type: "command", command: "node --version", expect_exit: 0 },
        ],
      },
      {
        provider: new FakeProvider([{ response: endTurn("ok") }]),
        taskTimeoutMs: 15000,
      },
    );
    expect(result.status).toBe("passed");
  });

  it("超时：挂起的模型流触发 abort → timeout 状态", async () => {
    const result = await runEvalTask(
      {
        id: "t-hang",
        title: "挂起",
        category: "测试",
        prompt: "x",
        checks: [{ type: "file_exists", path: "nope.txt" }],
      },
      {
        provider: new FakeProvider([{ hang: true }]),
        taskTimeoutMs: 150,
      },
    );
    expect(result.status).toBe("timeout");
    expect(result.pass).toBe(false);
  });

  it("runSuite 产出报告；compareReports 找回退与修复", () => {
    const mk = (id: string, pass: boolean): SuiteReport => ({
      suite: SUITE_NAME,
      startedAt: "t0",
      finishedAt: "t1",
      model: "m",
      provider: "p",
      results: [
        { id, title: id, category: "c", pass, status: pass ? "passed" : "failed", durationMs: 1, tokensIn: 0, tokensOut: 0, turns: 1, failedChecks: [] },
      ],
      passed: pass ? 1 : 0,
      total: 1,
    });
    const cmp = compareReports(mk("a", true), mk("a", false));
    expect(cmp.regressions).toEqual(["a"]);
    const cmp2 = compareReports(mk("a", false), mk("a", true));
    expect(cmp2.fixed).toEqual(["a"]);
  });

  it("任务套件结构完整：20 个任务、id 唯一、每题至少一个检查", () => {
    expect(evalTasks).toHaveLength(20);
    const ids = new Set(evalTasks.map((t) => t.id));
    expect(ids.size).toBe(20);
    for (const t of evalTasks) {
      expect(t.checks.length).toBeGreaterThan(0);
      expect(t.prompt.length).toBeGreaterThan(5);
    }
  });
});
