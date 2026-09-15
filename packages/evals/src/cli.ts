#!/usr/bin/env node
/** wcode 评测套件入口：pnpm eval [--list] [--only a,b] [--out x.json] [--model m] [--compare base.json] */
import { mkdir, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AnthropicProvider } from "@wcode/provider-anthropic";
import { compareReports, runSuite, SUITE_NAME } from "./harness";
import { evalTasks } from "./tasks";
import type { SuiteReport } from "./types";

const DIM = "\x1b[2m";
const RESET = "\x1b[0m";
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const CYAN = "\x1b[36m";

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const list = args.includes("--list");
  const compareFile = args.find((a) => a.startsWith("--compare="))?.split("=").slice(1).join("=");
  const only = args.find((a) => a.startsWith("--only="))?.split("=").slice(1).join(",");
  const outArg = args.find((a) => a.startsWith("--out="))?.split("=").slice(1).join("=");
  const model = args.find((a) => a.startsWith("--model="))?.split("=").slice(1).join("=")
    ?? "claude-sonnet-4-5";

  if (list) {
    for (const t of evalTasks) {
      console.log(`${t.id.padEnd(24)} ${t.category.padEnd(6)} ${t.title}`);
    }
    console.log(`\n共 ${evalTasks.length} 个任务`);
    return 0;
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error("缺少 API key：请设置 ANTHROPIC_API_KEY 后运行。");
    return 2;
  }

  let tasks = evalTasks;
  if (only) {
    const ids = new Set(only.split(","));
    tasks = evalTasks.filter((t) => ids.has(t.id));
  }

  console.log(`${CYAN}wcode evals${RESET} ${SUITE_NAME} — ${tasks.length} 个任务，model=${model}\n`);
  const provider = new AnthropicProvider({ apiKey, model });
  const report = await runSuite(tasks, { provider, model, providerId: "anthropic" });

  // 结果表
  const idWidth = Math.max(...report.results.map((r) => r.id.length)) + 2;
  for (const r of report.results) {
    const mark = r.pass ? `${GREEN}PASS${RESET}` : `${RED}FAIL${RESET}`;
    const extra =
      r.status === "passed"
        ? `${r.durationMs}ms in/${r.tokensIn} out/${r.tokensOut}`
        : `${r.status}: ${(r.error ?? r.failedChecks[0] ?? "").slice(0, 80)}`;
    console.log(`${mark} ${r.id.padEnd(idWidth)} ${DIM}${extra}${RESET}`);
  }
  console.log(`\n${report.passed}/${report.total} 通过（${((report.passed / report.total) * 100).toFixed(0)}%）`);

  // 结果落盘（作为下次对比的基线）
  const outPath = outArg ?? join("evals-results", `${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  await mkdir(join(outPath, ".."), { recursive: true }).catch(() => {});
  await writeFile(outPath, JSON.stringify(report, null, 2), "utf8");
  console.log(`${DIM}报告已写入 ${outPath}${RESET}`);

  // 与基线对比
  if (compareFile) {
    const baseline = JSON.parse(readFileSync(compareFile, "utf8")) as SuiteReport;
    const cmp = compareReports(baseline, report);
    console.log(`\n对比基线 ${compareFile}（${cmp.baselinePassRate} → ${cmp.currentPassRate}）`);
    for (const id of cmp.regressions) console.log(`  ${RED}▼ 回退: ${id}${RESET}`);
    for (const id of cmp.fixed) console.log(`  ${GREEN}▲ 修复: ${id}${RESET}`);
    if (cmp.regressions.length === 0) console.log(`  ${DIM}无回退${RESET}`);
  }

  return report.passed === report.total ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(`致命错误: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  },
);
