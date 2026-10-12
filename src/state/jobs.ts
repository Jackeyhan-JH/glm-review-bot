/**
 * 任务队列（#5）：入队 / 去重 / 认领 / 重试 / 跳过 / 高峰延后等操作。
 *
 * 约定：
 * - 时间一律是调用方传入的 ISO 字符串或 Date（测试用假时钟），入库转成等长 ISO 串；
 * - `attempts` 在 claimNext 认领时 +1，markFailed 按它判断是否还有重试名额；
 * - 同一 `(repo, pr, head_sha)` 只允许一行（唯一约束 + 入队去重），审过（done / skipped）
 *   的任务不再重复审。
 */
import type { JobStatus } from '../lib/types.ts';
import { toIso, type StateDb } from './db.ts';

/** 重试策略：失败后按 backoffSeconds[attempts-1] 秒退避，尝试满 maxAttempts 次为终态 failed。 */
export interface RetryPolicy {
  maxAttempts: number;
  backoffSeconds: number[];
}

/** 默认重试策略：最多尝试 3 次，退避 60s / 300s / 1800s。 */
export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 3,
  backoffSeconds: [60, 300, 1800],
};

/** 队列里的一条审查任务。 */
export interface Job {
  id: number;
  repo: string;
  pr: number;
  headSha: string;
  status: JobStatus;
  reason: string | null;
  attempts: number;
  /** 最早可执行时刻（ISO）。 */
  notBefore: string;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  reviewUrl: string | null;
  findingsCount: number | null;
  model: string | null;
}

export interface EnqueueInput {
  repo: string;
  pr: number;
  headSha: string;
  /** 入队时刻（created_at / updated_at，也是 not_before 的默认值）。 */
  now: string | Date;
  /** 最早可执行时刻；不传等于 now。 */
  notBefore?: string | Date;
  /** 初始状态，默认 queued；高峰期发现的任务用 deferred。 */
  status?: 'queued' | 'deferred';
  /** 原因说明（如 peak、paused、draft）。 */
  reason?: string;
}

export interface MarkDoneOptions {
  now: string | Date;
  reviewUrl?: string;
  findingsCount?: number;
  model?: string;
}

export interface MarkFailedOptions {
  now: string | Date;
  /** 重试策略，默认 DEFAULT_RETRY_POLICY。 */
  retry?: RetryPolicy;
  /** 显式指定重试时刻（优先于按退避计算）。 */
  retryAt?: string | Date;
}

export interface ListJobsOptions {
  status?: JobStatus;
  repo?: string;
  pr?: number;
  /** 最多返回多少条，默认 100。 */
  limit?: number;
}

/** 各状态任务计数。 */
export type JobStats = Record<JobStatus, number>;

type JobRow = {
  id: number;
  repo: string;
  pr: number;
  head_sha: string;
  status: string;
  reason: string | null;
  attempts: number;
  not_before: string;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  finished_at: string | null;
  review_url: string | null;
  findings_count: number | null;
  model: string | null;
};

const JOB_COLUMNS = `
  id, repo, pr, head_sha, status, reason, attempts, not_before,
  created_at, updated_at, started_at, finished_at,
  review_url, findings_count, model`;

function toJob(row: JobRow): Job {
  return {
    id: row.id,
    repo: row.repo,
    pr: row.pr,
    headSha: row.head_sha,
    status: row.status as JobStatus,
    reason: row.reason,
    attempts: row.attempts,
    notBefore: row.not_before,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    reviewUrl: row.review_url,
    findingsCount: row.findings_count,
    model: row.model,
  };
}

function selectJob(state: StateDb, id: number): Job {
  const row = state.sqlite
    .prepare(`SELECT ${JOB_COLUMNS} FROM jobs WHERE id = ?`)
    .get(id) as JobRow | undefined;
  if (row === undefined) throw new Error(`任务不存在：id=${id}`);
  return toJob(row);
}

function updateJob(
  state: StateDb,
  id: number,
  sql: string,
  params: Array<string | number | null>,
): Job {
  const result = state.sqlite.prepare(sql).run(...params);
  if (Number(result.changes) === 0) throw new Error(`任务不存在：id=${id}`);
  return selectJob(state, id);
}

/** 按 id 取任务；不存在时抛错。 */
export function getJob(state: StateDb, id: number): Job {
  return selectJob(state, id);
}

/**
 * 入队：同键（repo, pr, head_sha）已存在时不重复插入（去重），返回库里的那条任务。
 */
export function enqueue(state: StateDb, input: EnqueueInput): { job: Job; created: boolean } {
  const now = toIso(input.now);
  const notBefore = toIso(input.notBefore ?? input.now);
  const inserted = state.sqlite
    .prepare(
      `INSERT INTO jobs (repo, pr, head_sha, status, reason, attempts, not_before, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?)
       ON CONFLICT (repo, pr, head_sha) DO NOTHING`,
    )
    .run(
      input.repo,
      input.pr,
      input.headSha,
      input.status ?? 'queued',
      input.reason ?? null,
      notBefore,
      now,
      now,
    );
  const row = state.sqlite
    .prepare(
      `SELECT ${JOB_COLUMNS} FROM jobs WHERE repo = ? AND pr = ? AND head_sha = ?`,
    )
    .get(input.repo, input.pr, input.headSha) as JobRow | undefined;
  if (row === undefined) throw new Error('入队后读不到任务行');
  return { job: toJob(row), created: Number(inserted.changes) === 1 };
}

/**
 * 原子认领：取 `queued` / `deferred` 且 `not_before <= now` 的最早任务，
 * 置为 `running`、attempts +1、记 started_at。取不到返回 undefined。
 * 认领在 BEGIN IMMEDIATE 事务内完成，两个进程同时认领不会拿到同一任务。
 */
export function claimNext(state: StateDb, now: string | Date): Job | undefined {
  const nowIso = toIso(now);
  const sqlite = state.sqlite;
  sqlite.exec('BEGIN IMMEDIATE');
  try {
    const row = sqlite
      .prepare(
        `SELECT ${JOB_COLUMNS} FROM jobs
         WHERE status IN ('queued', 'deferred') AND not_before <= ?
         ORDER BY not_before, created_at, id
         LIMIT 1`,
      )
      .get(nowIso) as JobRow | undefined;
    if (row === undefined) {
      sqlite.exec('COMMIT');
      return undefined;
    }
    sqlite
      .prepare(
        `UPDATE jobs SET status = 'running', attempts = attempts + 1, started_at = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(nowIso, nowIso, row.id);
    const updated = sqlite
      .prepare(`SELECT ${JOB_COLUMNS} FROM jobs WHERE id = ?`)
      .get(row.id) as JobRow | undefined;
    if (updated === undefined) throw new Error(`认领后读不到任务行：id=${row.id}`);
    sqlite.exec('COMMIT');
    return toJob(updated);
  } catch (err) {
    try {
      sqlite.exec('ROLLBACK');
    } catch {
      // 事务可能已提交/回滚，忽略。
    }
    throw err;
  }
}

/** 标记完成（终态），可顺带记录 review 地址、发现数与所用模型。 */
export function markDone(state: StateDb, id: number, options: MarkDoneOptions): Job {
  const now = toIso(options.now);
  return updateJob(
    state,
    id,
    `UPDATE jobs SET status = 'done', finished_at = ?, updated_at = ?,
       review_url = COALESCE(?, review_url),
       findings_count = COALESCE(?, findings_count),
       model = COALESCE(?, model)
     WHERE id = ?`,
    [now, now, options.reviewUrl ?? null, options.findingsCount ?? null, options.model ?? null, id],
  );
}

/**
 * 标记一次失败：attempts < maxAttempts 时回到 queued 并按退避设 not_before，
 * 否则终态 failed。attempts 以认领时已累计的值为准。
 */
export function markFailed(
  state: StateDb,
  id: number,
  error: string | Error,
  options: MarkFailedOptions,
): Job {
  const job = selectJob(state, id);
  const now = toIso(options.now);
  const reason = error instanceof Error ? error.message : error;
  const policy = options.retry ?? DEFAULT_RETRY_POLICY;
  if (job.attempts < policy.maxAttempts) {
    const index = Math.max(0, Math.min(job.attempts - 1, policy.backoffSeconds.length - 1));
    const delaySeconds = policy.backoffSeconds[index] ?? 0;
    const retryAt =
      options.retryAt !== undefined
        ? toIso(options.retryAt)
        : toIso(new Date(new Date(now).getTime() + delaySeconds * 1000));
    return updateJob(
      state,
      id,
      `UPDATE jobs SET status = 'queued', reason = ?, not_before = ?, started_at = NULL, updated_at = ?
       WHERE id = ?`,
      [reason, retryAt, now, id],
    );
  }
  return updateJob(
    state,
    id,
    `UPDATE jobs SET status = 'failed', reason = ?, finished_at = ?, updated_at = ? WHERE id = ?`,
    [reason, now, now, id],
  );
}

/** 标记跳过（终态）：草稿、过滤规则命中、被新 commit 取代等。 */
export function markSkipped(state: StateDb, id: number, reason: string, now: string | Date): Job {
  const nowIso = toIso(now);
  return updateJob(
    state,
    id,
    `UPDATE jobs SET status = 'skipped', reason = ?, finished_at = ?, updated_at = ? WHERE id = ?`,
    [reason, nowIso, nowIso, id],
  );
}

/** 延后执行（如高峰期 / 额度暂停）：置为 deferred，not_before = until。 */
export function defer(
  state: StateDb,
  id: number,
  until: string | Date,
  reason: string,
  now: string | Date,
): Job {
  return updateJob(
    state,
    id,
    `UPDATE jobs SET status = 'deferred', not_before = ?, reason = ?, updated_at = ? WHERE id = ?`,
    [toIso(until), reason, toIso(now), id],
  );
}

/**
 * 守护进程崩溃恢复：把 started_at 超过 staleMinutes 仍是 running 的任务放回 queued。
 * 已消耗的尝试次数保留（崩溃的那次认领已计入 attempts）。返回恢复条数。
 */
export function recoverStale(state: StateDb, now: string | Date, staleMinutes: number): number {
  const nowIso = toIso(now);
  const cutoff = toIso(new Date(new Date(nowIso).getTime() - Math.max(0, staleMinutes) * 60_000));
  const result = state.sqlite
    .prepare(
      `UPDATE jobs SET status = 'queued', started_at = NULL, not_before = ?, updated_at = ?
       WHERE status = 'running' AND started_at IS NOT NULL AND started_at <= ?`,
    )
    .run(nowIso, nowIso, cutoff);
  return Number(result.changes);
}

/** 该 (repo, pr, head_sha) 是否已审过（done 或 skipped）——去重判断。 */
export function isReviewed(state: StateDb, repo: string, pr: number, headSha: string): boolean {
  const row = state.sqlite
    .prepare(
      `SELECT id FROM jobs
       WHERE repo = ? AND pr = ? AND head_sha = ? AND status IN ('done', 'skipped')
       LIMIT 1`,
    )
    .get(repo, pr, headSha);
  return row !== undefined;
}

/**
 * 同一 PR 来了新 commit：把旧 SHA 上尚未开始（queued / deferred）的任务标为
 * skipped（reason = superseded）。进行中或已结束的任务不动。返回受影响条数。
 */
export function supersede(
  state: StateDb,
  repo: string,
  pr: number,
  newHeadSha: string,
  now: string | Date,
): number {
  const nowIso = toIso(now);
  const result = state.sqlite
    .prepare(
      `UPDATE jobs SET status = 'skipped', reason = 'superseded', finished_at = ?, updated_at = ?
       WHERE repo = ? AND pr = ? AND head_sha <> ? AND status IN ('queued', 'deferred')`,
    )
    .run(nowIso, nowIso, repo, pr, newHeadSha);
  return Number(result.changes);
}

/** 查询任务列表，按入队时间倒序（新任务在前）。 */
export function listJobs(state: StateDb, options: ListJobsOptions = {}): Job[] {
  const conditions: string[] = [];
  const params: Array<string | number> = [];
  if (options.status !== undefined) {
    conditions.push('status = ?');
    params.push(options.status);
  }
  if (options.repo !== undefined) {
    conditions.push('repo = ?');
    params.push(options.repo);
  }
  if (options.pr !== undefined) {
    conditions.push('pr = ?');
    params.push(options.pr);
  }
  const where = conditions.length > 0 ? ` WHERE ${conditions.join(' AND ')}` : '';
  const limit = Math.max(1, Math.min(options.limit ?? 100, 10_000));
  const rows = state.sqlite
    .prepare(`SELECT ${JOB_COLUMNS} FROM jobs${where} ORDER BY created_at DESC, id DESC LIMIT ?`)
    .all(...params, limit) as unknown as JobRow[];
  return rows.map(toJob);
}

/** 各状态任务计数（没有的状态计 0）。 */
export function stats(state: StateDb): JobStats {
  const result: JobStats = {
    queued: 0,
    deferred: 0,
    running: 0,
    done: 0,
    failed: 0,
    skipped: 0,
  };
  const rows = state.sqlite
    .prepare('SELECT status, COUNT(*) AS n FROM jobs GROUP BY status')
    .all() as unknown as Array<{ status: string; n: number }>;
  for (const row of rows) {
    if (row.status in result) result[row.status as JobStatus] = row.n;
  }
  return result;
}
