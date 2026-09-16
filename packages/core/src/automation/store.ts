import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { Cron } from "croner";
import { errorMessage } from "../errors";
import type { Logger } from "../logging/port";
import { closeSqliteDb, openSqliteDb } from "../session/sqlite-store";
import { projectDirHash } from "../session/store";

/**
 * 自动化调度存储（W-c，设计 §8，参考 ZCode tasks-index 的状态机）。
 * 与会话记录同库（~/.wcode/wcode.db），daemon 与 schedule CLI 共用一套存储；
 * 认领互斥（claim）保证 daemon 与手动 run 并发时一个任务只被一个执行方拿走。
 */

export type AutomationOutcome =
  | "success"
  | "max_turns"
  | "failed"
  | "timeout"
  | "aborted";

export interface AutomationSchedule {
  kind: "cron" | "once";
  /** kind=cron：5 段 cron 表达式（本地时区） */
  expr?: string;
  /** kind=once：epoch 毫秒 */
  runAt?: number;
}

export interface AutomationSpec {
  title: string;
  prompt: string;
  /** 任务执行目录（持久化；与 daemon 启动位置无关） */
  cwd: string;
  provider?: string;
  model?: string;
  /** 权限模式（无人值守默认 default=自动拒绝变更；bypass 慎用） */
  mode?: string;
  schedule: AutomationSchedule;
  timeoutMs?: number;
  maxRuns?: number;
}

export interface AutomationRecord {
  id: string;
  title: string;
  prompt: string;
  cwd: string;
  projectHash: string;
  provider: string | null;
  model: string | null;
  mode: string;
  scheduleKind: "cron" | "once";
  cronExpr: string | null;
  runAt: number | null;
  timeoutMs: number | null;
  maxRuns: number | null;
  runCount: number;
  enabled: boolean;
  nextRunAt: number | null;
  lastRunAt: number | null;
  running: boolean;
  claimedAt: number | null;
  dispatchAttempts: number;
  retryAt: number | null;
  lastError: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface AutomationRunRecord {
  id: string;
  automationId: string;
  trigger: "schedule" | "manual";
  startedAt: number;
  finishedAt: number | null;
  outcome: AutomationOutcome | null;
  exitCode: number | null;
  sessionId: string | null;
  error: string | null;
}

/** 派发失败退避：60s × 2^n，封顶 1 小时（retry_at 写回后 due 查询跳过） */
export function dispatchBackoffMs(attempts: number): number {
  return Math.min(60_000 * 2 ** Math.max(0, attempts - 1), 3_600_000);
}

/** 认领过期阈值：daemon 崩溃留下的 running=1 行在此时长后可被重新认领 */
export const STALE_CLAIM_MS = 2 * 60 * 60 * 1000;

/** 校验并解析 cron 表达式（本地时区），返回下一次触发时间 */
export function nextCronRun(expr: string, from: Date): Date | null {
  let job: Cron;
  try {
    job = new Cron(expr);
  } catch (err) {
    throw new Error(
      `非法 cron 表达式 "${expr}"（5 段：分 时 日 月 周，如 "0 9 * * 1-5"）: ${errorMessage(err)}`,
    );
  }
  return job.nextRun(from);
}

interface AutomationRow {
  id: string;
  title: string;
  prompt: string;
  cwd: string;
  project_hash: string;
  provider: string | null;
  model: string | null;
  mode: string;
  schedule_kind: string;
  cron_expr: string | null;
  run_at: number | null;
  timeout_ms: number | null;
  max_runs: number | null;
  run_count: number;
  enabled: number;
  next_run_at: number | null;
  last_run_at: number | null;
  running: number;
  claimed_at: number | null;
  dispatch_attempts: number;
  retry_at: number | null;
  last_error: string | null;
  created_at: number;
  updated_at: number;
}

interface RunRow {
  id: string;
  automation_id: string;
  trigger: string;
  started_at: number;
  finished_at: number | null;
  outcome: string | null;
  exit_code: number | null;
  session_id: string | null;
  error: string | null;
}

function runRowToRecord(r: RunRow): AutomationRunRecord {
  return {
    id: r.id,
    automationId: r.automation_id,
    trigger: r.trigger as "schedule" | "manual",
    startedAt: Number(r.started_at),
    finishedAt: r.finished_at === null ? null : Number(r.finished_at),
    outcome: (r.outcome as AutomationRunRecord["outcome"]) ?? null,
    exitCode: r.exit_code === null ? null : Number(r.exit_code),
    sessionId: r.session_id,
    error: r.error,
  };
}

function rowToRecord(r: AutomationRow): AutomationRecord {  return {
    id: r.id,
    title: r.title,
    prompt: r.prompt,
    cwd: r.cwd,
    projectHash: r.project_hash,
    provider: r.provider,
    model: r.model,
    mode: r.mode,
    scheduleKind: r.schedule_kind as "cron" | "once",
    cronExpr: r.cron_expr,
    runAt: r.run_at === null ? null : Number(r.run_at),
    timeoutMs: r.timeout_ms === null ? null : Number(r.timeout_ms),
    maxRuns: r.max_runs === null ? null : Number(r.max_runs),
    runCount: Number(r.run_count),
    enabled: Number(r.enabled) === 1,
    nextRunAt: r.next_run_at === null ? null : Number(r.next_run_at),
    lastRunAt: r.last_run_at === null ? null : Number(r.last_run_at),
    running: Number(r.running) === 1,
    claimedAt: r.claimed_at === null ? null : Number(r.claimed_at),
    dispatchAttempts: Number(r.dispatch_attempts),
    retryAt: r.retry_at === null ? null : Number(r.retry_at),
    lastError: r.last_error,
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
  };
}

export class AutomationStore {
  private constructor(
    private readonly db: DatabaseSync,
    private readonly dbPath: string,
  ) {}

  /** 与会话存储同库（~/.wcode/wcode.db）；测试用 homeDir 隔离 */
  static async open(
    opts: { homeDir?: string; log?: Logger } = {},
  ): Promise<AutomationStore> {
    const dbPath = join(opts.homeDir ?? homedir(), ".wcode", "wcode.db");
    const db = await openSqliteDb(dbPath, opts.log);
    return new AutomationStore(db, dbPath);
  }

  /** 释放连接（WAL 检查点）；测试清理临时目录前必须调用 */
  close(): void {
    closeSqliteDb(this.dbPath);
  }

  /** 新建自动化；once 的 next_run_at=run_at，cron 立即算出下一轮 */
  add(spec: AutomationSpec, now = Date.now()): AutomationRecord {
    let nextRunAt: number;
    let cronExpr: string | null = null;
    let runAt: number | null = null;
    if (spec.schedule.kind === "cron") {
      const expr = spec.schedule.expr?.trim();
      if (!expr) throw new Error("cron 调度需要 --cron 表达式");
      const next = nextCronRun(expr, new Date(now));
      if (!next) throw new Error(`cron 表达式 "${expr}" 没有下一次触发时间`);
      cronExpr = expr;
      nextRunAt = next.getTime();
    } else {
      if (!spec.schedule.runAt || spec.schedule.runAt <= now) {
        throw new Error("once 调度需要未来的时间（--at）");
      }
      runAt = spec.schedule.runAt;
      nextRunAt = runAt;
    }
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO automations
           (id, title, prompt, cwd, project_hash, provider, model, mode,
            schedule_kind, cron_expr, run_at, timeout_ms, max_runs,
            next_run_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        spec.title,
        spec.prompt,
        spec.cwd,
        projectDirHash(spec.cwd),
        spec.provider ?? null,
        spec.model ?? null,
        spec.mode ?? "default",
        spec.schedule.kind,
        cronExpr,
        runAt,
        spec.timeoutMs ?? null,
        spec.maxRuns ?? null,
        nextRunAt,
        now,
        now,
      );
    const rec = this.get(id);
    if (!rec) throw new Error("自动化创建失败");
    return rec;
  }

  /** 全量列表（新→旧）；daemon 需要跨项目视图 */
  list(): AutomationRecord[] {
    return (
      this.db.prepare("SELECT * FROM automations ORDER BY created_at DESC").all() as unknown as AutomationRow[]
    ).map(rowToRecord);
  }

  /** id 或唯一前缀匹配；无命中/歧义给出可读错误 */
  get(idOrPrefix: string): AutomationRecord {
    const rec = this.tryGet(idOrPrefix);
    if (!rec) {
      throw new Error(`没有找到自动化 "${idOrPrefix}"（wcode schedule list 查看列表）`);
    }
    return rec;
  }

  tryGet(idOrPrefix: string): AutomationRecord | undefined {
    const exact = this.db
      .prepare("SELECT * FROM automations WHERE id = ?")
      .get(idOrPrefix) as AutomationRow | undefined;
    if (exact) return rowToRecord(exact);
    const matches = (
      this.db.prepare("SELECT * FROM automations WHERE id LIKE ?").all(`${idOrPrefix}%`) as unknown as AutomationRow[]
    ).map(rowToRecord);
    if (matches.length === 1) return matches[0];
    if (matches.length > 1) {
      throw new Error(`前缀 "${idOrPrefix}" 命中 ${matches.length} 个自动化，请用更长的 id`);
    }
    return undefined;
  }

  remove(idOrPrefix: string): void {
    const rec = this.get(idOrPrefix);
    this.db.prepare("DELETE FROM automations WHERE id = ?").run(rec.id);
  }

  setEnabled(idOrPrefix: string, enabled: boolean, now = Date.now()): AutomationRecord {
    const rec = this.get(idOrPrefix);
    // 恢复 cron 任务时重算下一轮，避免追跑停用期间错过的时点
    let nextRunAt = rec.nextRunAt;
    if (enabled && rec.scheduleKind === "cron") {
      const next = nextCronRun(rec.cronExpr ?? "", new Date(now));
      nextRunAt = next?.getTime() ?? null;
    }
    this.db
      .prepare(
        "UPDATE automations SET enabled = ?, next_run_at = ?, retry_at = NULL, dispatch_attempts = 0, updated_at = ? WHERE id = ?",
      )
      .run(enabled ? 1 : 0, nextRunAt, now, rec.id);
    return this.get(rec.id);
  }

  /** 到期待派发：启用、未在跑、next_run_at 已到、不在退避期 */
  due(now = Date.now()): AutomationRecord[] {
    return (
      this.db
        .prepare(
          `SELECT * FROM automations
           WHERE enabled = 1 AND running = 0
             AND next_run_at IS NOT NULL AND next_run_at <= ?
             AND (retry_at IS NULL OR retry_at <= ?)
           ORDER BY next_run_at ASC`,
        )
        .all(now, now) as unknown as AutomationRow[]
    ).map(rowToRecord);
  }

  /**
   * 认领（互斥）：仅当未在跑（或认领已过期）时置 running=1。
   * 返回 false = 被其他执行方持有。
   */
  claim(idOrPrefix: string, now = Date.now()): boolean {
    const rec = this.get(idOrPrefix);
    const res = this.db
      .prepare(
        `UPDATE automations SET running = 1, claimed_at = ?, updated_at = ?
         WHERE id = ? AND (running = 0 OR claimed_at IS NULL OR claimed_at < ?)`,
      )
      .run(now, now, rec.id, now - STALE_CLAIM_MS);
    return Number(res.changes) === 1;
  }

  /** 开始一次运行（daemon 派发或手动 run），返回 run 记录（finished_at 为空=进行中） */
  startRun(
    idOrPrefix: string,
    trigger: "schedule" | "manual",
    now = Date.now(),
  ): { run: AutomationRunRecord; automation: AutomationRecord } {
    const automation = this.get(idOrPrefix);
    const run: AutomationRunRecord = {
      id: randomUUID(),
      automationId: automation.id,
      trigger,
      startedAt: now,
      finishedAt: null,
      outcome: null,
      exitCode: null,
      sessionId: null,
      error: null,
    };
    this.db
      .prepare(
        "INSERT INTO automation_runs (id, automation_id, trigger, started_at) VALUES (?, ?, ?, ?)",
      )
      .run(run.id, run.automationId, run.trigger, run.startedAt);
    return { run, automation };
  }

  /**
   * 结束一次运行并推进调度状态机：
   * run_count++ → cron 算下一轮 / once 完成 → max_runs 达标自动停用；
   * 失败不推进调度时间（由 recordDispatchFailure 走退避）。
   */
  finishRun(
    runId: string,
    outcome: {
      outcome: AutomationOutcome;
      exitCode?: number;
      sessionId?: string;
      error?: string;
    },
    now = Date.now(),
  ): void {
    const row = this.db
      .prepare("SELECT * FROM automation_runs WHERE id = ?")
      .get(runId) as (AutomationRunRecord & { automation_id: string }) | undefined;
    if (!row) throw new Error(`运行记录不存在: ${runId}`);
    const automation = this.get(row.automation_id);

    this.db
      .prepare(
        "UPDATE automation_runs SET finished_at = ?, outcome = ?, exit_code = ?, session_id = ?, error = ? WHERE id = ?",
      )
      .run(
        now,
        outcome.outcome,
        outcome.exitCode ?? null,
        outcome.sessionId ?? null,
        outcome.error ?? null,
        runId,
      );

    const runCount = automation.runCount + 1;
    const hitMax = automation.maxRuns !== null && runCount >= automation.maxRuns;
    let nextRunAt: number | null = null;
    let enabled = 0;
    if (automation.scheduleKind === "cron" && !hitMax) {
      const next = nextCronRun(automation.cronExpr ?? "", new Date(now));
      nextRunAt = next?.getTime() ?? null;
      enabled = 1;
    } // once 跑完即停用；max_runs 达标停用
    this.db
      .prepare(
        `UPDATE automations SET
           running = 0, claimed_at = NULL,
           run_count = ?, enabled = ?, next_run_at = ?, last_run_at = ?,
           dispatch_attempts = 0, retry_at = NULL, updated_at = ?
         WHERE id = ?`,
      )
      .run(runCount, enabled, nextRunAt, now, now, automation.id);
  }

  /** 派发失败（子进程起不来/基础设施错误）：指数退避后重试，不记为一次运行 */
  recordDispatchFailure(idOrPrefix: string, error: string, now = Date.now()): void {
    const automation = this.get(idOrPrefix);
    const attempts = automation.dispatchAttempts + 1;
    const retryAt = now + dispatchBackoffMs(attempts);
    this.db
      .prepare(
        `UPDATE automations SET
           running = 0, claimed_at = NULL,
           dispatch_attempts = ?, retry_at = ?, last_error = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(attempts, retryAt, error, now, automation.id);
  }

  /** 运行行的失败收尾（配 recordDispatchFailure 用；不推进调度/计数） */
  failRun(runId: string, error: string, now = Date.now()): void {
    this.db
      .prepare(
        "UPDATE automation_runs SET finished_at = ?, outcome = 'failed', error = ? WHERE id = ?",
      )
      .run(now, error, runId);
  }

  /** 运行历史（新→旧） */
  runs(automationId: string, limit = 10): AutomationRunRecord[] {
    return (
      this.db
        .prepare(
          "SELECT * FROM automation_runs WHERE automation_id = ? ORDER BY started_at DESC LIMIT ?",
        )
        .all(automationId, limit) as unknown as RunRow[]
    ).map(runRowToRecord);
  }

  /** 全库最近运行（schedule log 不带 id 时） */
  recentRuns(limit = 20): (AutomationRunRecord & { title: string })[] {
    return (
      this.db
        .prepare(
          `SELECT r.*, a.title AS title FROM automation_runs r
           JOIN automations a ON a.id = r.automation_id
           ORDER BY r.started_at DESC LIMIT ?`,
        )
        .all(limit) as unknown as (RunRow & { title: string })[]
    ).map((r) => ({ ...runRowToRecord(r), title: r.title }));
  }

  /** 测试钩子：拨动 next_run_at 绕过 add 的未来时间校验，模拟已到期 */
  patchNextRunForTest(id: string, nextRunAt: number): void {
    this.db
      .prepare("UPDATE automations SET next_run_at = ? WHERE id = ?")
      .run(nextRunAt, id);
  }
}
