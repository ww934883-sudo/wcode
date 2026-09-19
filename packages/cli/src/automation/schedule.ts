import { errorMessage, permissionModeSchema, type PermissionMode } from "@wcode/core";
import { AutomationStore, projectDirHash, type AutomationRecord } from "@wcode/core";
import {
  createDefaultRunner,
  type AutomationDispatchResult,
  type AutomationRunner,
} from "./runner";

/**
 * `wcode schedule` 子命令（W-c 设计 §8.3）：
 *   add <任务描述> --cron="0 9 * * 1-5" | --at="2026-09-17T09:00" | --at="+10m"
 *       [--title=...] [--cwd=path] [--mode=default] [--timeout-ms=...] [--max-runs=...]
 *   list / run <id> / pause <id> / resume <id> / remove <id> / log [id]
 * 退出码：0 成功，2 用法/配置错误。
 */
export interface ScheduleIo {
  out: (line: string) => void;
  err: (line: string) => void;
  runner?: AutomationRunner;
  homeDir?: string;
}

export async function handleScheduleCommand(
  argv: string[],
  io: ScheduleIo = { out: (l) => console.log(l), err: (l) => console.error(l) },
): Promise<number> {
  const sub = argv[0];
  if (!sub) {
    io.err(SCHEDULE_USAGE);
    return 2;
  }
  const store = await AutomationStore.open({ homeDir: io.homeDir });
  try {
    switch (sub) {
      case "add":
        return scheduleAdd(store, argv.slice(1), io);
      case "list":
        return scheduleList(store, argv.slice(1), io);
      case "run":
        return await scheduleRun(store, argv.slice(1), io);
      case "pause":
        return scheduleToggle(store, argv.slice(1), io, false);
      case "resume":
        return scheduleToggle(store, argv.slice(1), io, true);
      case "remove":
        return scheduleRemove(store, argv.slice(1), io);
      case "log":
        return scheduleLog(store, argv.slice(1), io);
      default:
        io.err(`未知子命令 "schedule ${sub}"。\n${SCHEDULE_USAGE}`);
        return 2;
    }
  } catch (err) {
    io.err(`出错: ${errorMessage(err)}`);
    return 2;
  } finally {
    store.close();
  }
}

const SCHEDULE_USAGE = [
  "用法:",
  '  wcode schedule add "任务描述" --cron="0 9 * * 1-5" [--title=名称] [--cwd=path] [--mode=default] [--timeout-ms=600000] [--max-runs=10]',
  '  wcode schedule add "任务描述" --at="2026-09-17T09:00" 或 --at="+10m"   # 一次性任务',
  "  wcode schedule list [--project=path]                 # 全部自动化（--project 只看指定目录）",
  "  wcode schedule run <id>                              # 手动立即执行一次（前台）",
  "  wcode schedule pause <id> / resume <id>              # 停用/恢复（恢复重算 cron 下一轮）",
  "  wcode schedule remove <id>                           # 删除（连同运行历史）",
  "  wcode schedule log [id]                              # 运行历史",
  "  wcode daemon [--tick]                                # 常驻守护（--tick 只跑一轮，测试/外部 cron 用）",
].join("\n");

function parseFlags(args: string[]): { flags: Record<string, string>; positional: string[] } {
  const flags: Record<string, string> = {};
  const positional: string[] = [];
  for (const a of args) {
    const m = /^--([\w-]+)=(.*)$/.exec(a);
    if (m) flags[(m[1] ?? "").toLowerCase()] = m[2] ?? "";
    else positional.push(a);
  }
  return { flags, positional };
}

/** --at：支持 ISO 时间（无 Z 按本地时区）与 +10m/+2h/+1d 相对量 */
export function parseAt(spec: string, now: number): number {
  const rel = /^\+(\d+)([smhd])$/.exec(spec.trim());
  if (rel) {
    const unitMs = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[
      rel[2] as "s" | "m" | "h" | "d"
    ];
    return now + Number(rel[1]) * unitMs;
  }
  const t = Date.parse(spec);
  if (Number.isNaN(t)) {
    throw new Error(
      `无法解析时间 "${spec}"：请用 ISO 形式（2026-09-17T09:00，本地时区）或相对量（+10m / +2h / +1d）`,
    );
  }
  return t;
}

function scheduleAdd(store: AutomationStore, args: string[], io: ScheduleIo): number {
  const { flags, positional } = parseFlags(args);
  const prompt = positional.join(" ").trim();
  if (!prompt) {
    io.err('缺少任务描述。例: wcode schedule add "运行 pnpm test 并修复" --cron="0 9 * * *"');
    return 2;
  }
  const hasCron = flags["cron"] !== undefined;
  const hasAt = flags["at"] !== undefined;
  if (hasCron === hasAt) {
    io.err("需要 --cron 或 --at 之一（且只能一个）。\n" + SCHEDULE_USAGE);
    return 2;
  }
  // 入口即校验：非法 mode 存进库要到派发时才报「配置不合法」，错误信息指不到 mode
  const mode = flags["mode"];
  if (mode !== undefined && !permissionModeSchema.options.includes(mode as PermissionMode)) {
    io.err(`非法权限模式 "${mode}"。可选: ${permissionModeSchema.options.join(" | ")}`);
    return 2;
  }
  const rec = store.add({
    title: flags["title"] ?? prompt.slice(0, 30),
    prompt,
    cwd: flags["cwd"] ?? process.cwd(),
    mode: flags["mode"],
    schedule: hasCron
      ? { kind: "cron", expr: flags["cron"] }
      : { kind: "once", runAt: parseAt(flags["at"] ?? "", Date.now()) },
    timeoutMs: flags["timeout-ms"] ? Number(flags["timeout-ms"]) : undefined,
    maxRuns: flags["max-runs"] ? Number(flags["max-runs"]) : undefined,
  });
  io.out(
    `已创建自动化 ${rec.id.slice(0, 8)}「${rec.title}」\n` +
      `  调度: ${describeSchedule(rec)}\n` +
      `  下一次: ${fmtTime(rec.nextRunAt) || "（停用）"}\n` +
      `  目录: ${rec.cwd} · 权限模式: ${rec.mode}\n` +
      `启动 wcode daemon 后自动执行；wcode schedule run ${rec.id.slice(0, 8)} 可手动触发。`,
  );
  return 0;
}

function scheduleList(store: AutomationStore, args: string[], io: ScheduleIo): number {
  const { flags } = parseFlags(args);
  let all = store.list();
  if (flags["project"] !== undefined) {
    const hash = projectDirHash(flags["project"] || process.cwd());
    all = all.filter((a) => a.projectHash === hash);
  }
  if (all.length === 0) {
    io.out("还没有自动化。用 wcode schedule add 创建。");
    return 0;
  }
  const blocks = all.map((a) => {
    const state = !a.enabled
      ? "已停用"
      : a.running
        ? "运行中"
        : a.dispatchAttempts > 0
          ? `退避中（${a.dispatchAttempts} 次失败）`
          : "待调度";
    // bypass = 无人值守全放行，列表强制警示（设计 §8.4）
    const warn = a.mode === "bypass" ? "⚠bypass " : "";
    return [
      `${a.id.slice(0, 8)}  ${warn}${a.enabled ? "" : "✗ "}${a.title}  [${state}]`,
      `    调度: ${describeSchedule(a)} · 上次: ${fmtTime(a.lastRunAt) || "—"} · 下次: ${fmtTime(a.nextRunAt) || "—"}`,
      `    cwd: ${a.cwd} · 已运行 ${a.runCount}${a.maxRuns ? `/${a.maxRuns}` : ""} 次 · 提示词: ${a.prompt.slice(0, 50)}${a.prompt.length > 50 ? "…" : ""}`,
      a.lastError ? `    最近错误: ${a.lastError.slice(0, 80)}` : "",
    ]
      .filter(Boolean)
      .join("\n");
  });
  io.out(`自动化（${all.length} 个）：\n\n${blocks.join("\n\n")}`);
  return 0;
}

async function scheduleRun(
  store: AutomationStore,
  args: string[],
  io: ScheduleIo,
): Promise<number> {
  const id = args[0];
  if (!id) {
    io.err("用法: wcode schedule run <id|前缀>");
    return 2;
  }
  const automation = store.get(id);
  io.out(`手动执行「${automation.title}」…`);
  const runner = io.runner ?? createDefaultRunner({ write: (l) => io.out(l) });
  try {
    const result = await runAutomationManually(store, automation.id, runner);
    io.out(
      `完成: ${result.outcome}` +
        (result.reply ? `\n${result.reply}` : "") +
        (result.sessionId ? `\n（会话 ${result.sessionId}）` : ""),
    );
    return 0;
  } catch (err) {
    io.err(`执行失败: ${errorMessage(err)}`);
    return 1;
  }
}

/**
 * 手动执行一次（schedule run）：认领 → startRun(manual) → 派发 → finishRun。
 * 与 daemon 共用认领互斥；基础设施失败只记运行行，不影响调度与退避。
 */
export async function runAutomationManually(
  store: AutomationStore,
  idOrPrefix: string,
  runner: AutomationRunner,
): Promise<AutomationDispatchResult> {
  const automation = store.get(idOrPrefix);
  if (!store.claim(automation.id)) {
    throw new Error(`「${automation.title}」正在运行（daemon 持有），稍后再试`);
  }
  const { run } = store.startRun(automation.id, "manual");
  try {
    const result = await runner(automation);
    store.finishRun(run.id, {
      outcome: result.outcome,
      exitCode: result.exitCode,
      sessionId: result.sessionId,
      error: result.error,
    });
    return result;
  } catch (err) {
    store.failRun(run.id, errorMessage(err));
    throw err;
  }
}

function scheduleToggle(
  store: AutomationStore,
  args: string[],
  io: ScheduleIo,
  enable: boolean,
): number {
  const id = args[0];
  if (!id) {
    io.err(`用法: wcode schedule ${enable ? "resume" : "pause"} <id|前缀>`);
    return 2;
  }
  const rec = store.setEnabled(id, enable);
  io.out(
    `${enable ? "已恢复" : "已停用"}「${rec.title}」` +
      (enable ? `，下一次: ${fmtTime(rec.nextRunAt) || "（无调度）"}` : ""),
  );
  return 0;
}

function scheduleRemove(store: AutomationStore, args: string[], io: ScheduleIo): number {
  const id = args[0];
  if (!id) {
    io.err("用法: wcode schedule remove <id|前缀>");
    return 2;
  }
  const rec = store.get(id);
  store.remove(rec.id);
  io.out(`已删除「${rec.title}」（${rec.id.slice(0, 8)}）及其运行历史。`);
  return 0;
}

function scheduleLog(store: AutomationStore, args: string[], io: ScheduleIo): number {
  if (args[0]) {
    const rec = store.get(args[0]);
    const runs = store.runs(rec.id);
    if (runs.length === 0) {
      io.out(`「${rec.title}」还没有运行记录。`);
      return 0;
    }
    io.out(`「${rec.title}」的运行历史：\n${runs.map(formatRun).join("\n")}`);
    return 0;
  }
  const runs = store.recentRuns();
  if (runs.length === 0) {
    io.out("还没有任何运行记录。");
    return 0;
  }
  io.out(`最近运行（${runs.length} 条）：\n${runs.map((r) => `${formatRun(r)} · ${r.title}`).join("\n")}`);
  return 0;
}

function formatRun(r: {
  startedAt: number;
  trigger: string;
  outcome: string | null;
  finishedAt: number | null;
  exitCode: number | null;
  sessionId: string | null;
  error: string | null;
}): string {
  const duration =
    r.finishedAt === null ? "进行中" : `${((r.finishedAt - r.startedAt) / 1000).toFixed(1)}s`;
  const extra =
    r.outcome && r.outcome !== "success"
      ? r.error
        ? ` · ${r.error.slice(0, 60)}`
        : ""
      : "";
  return [
    fmtTime(r.startedAt),
    r.trigger === "manual" ? "手动" : "调度",
    r.outcome ?? "运行中",
    duration,
    r.sessionId ? `会话 ${r.sessionId.slice(0, 12)}` : "",
  ]
    .filter(Boolean)
    .join(" · ") + extra;
}

function describeSchedule(a: AutomationRecord): string {
  return a.scheduleKind === "cron" ? `cron "${a.cronExpr}"` : `一次性 @ ${fmtTime(a.runAt)}`;
}

function fmtTime(ms: number | null | undefined): string {
  if (!ms) return "";
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
