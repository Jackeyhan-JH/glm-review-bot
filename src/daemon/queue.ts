/**
 * 守护进程侧的任务队列补齐操作（#13）。`src/state/jobs.ts`（#5）没有提供：
 * - 按 (repo, pr, head_sha) 精确查找既有任务（listJobs 只按仓库 / PR 过滤）；
 * - 把既有行重置回队列——`enqueue` 是 ON CONFLICT DO NOTHING，decide 判定
 *   enqueue（`manual` 手动重审 / `ready` 草稿转正）但同键行已存在时唤不醒它，
 *   见 #12 PR 给 #13 的组装说明；
 * - 优雅退出等待超时后把 running 任务放回队列（recoverStale 只在启动时按时间清理）。
 *
 * 这里用同语义 SQL 在 daemon 目录补齐，WHERE 守卫保证与 claimNext / markFailed 的
 * 并发安全；后续宜开小 issue 挪进 src/state/jobs.ts（#1：不在功能 PR 里顺手改共享模块）。
 */
import type { JobStatus } from '../lib/types.ts';
import { toIso, type StateDb } from '../state/db.ts';
import { getJob, type Job } from '../state/jobs.ts';

const JOB_COLUMNS = `
  id, repo, pr, head_sha, status, reason, attempts, not_before,
  created_at, updated_at, started_at, finished_at,
  review_url, findings_count, model`;

/** 按 (repo, pr, head_sha) 查找任务；没有则 undefined。 */
export function findJobByKey(
  state: StateDb,
  repo: string,
  pr: number,
  headSha: string,
): Job | undefined {
  const row = state.sqlite
    .prepare(`SELECT ${JOB_COLUMNS} FROM jobs WHERE repo = ? AND pr = ? AND head_sha = ?`)
    .get(repo, pr, headSha) as
    | {
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
      }
    | undefined;
  if (row === undefined) return undefined;
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

export interface ResetJobOptions {
  now: Date;
  /** 重置原因短码（decide 的 reason：manual / ready）；高峰延后时固定为 peak。 */
  reason: string;
  /** 高峰延后时刻（deferUntil 的返回值）；null = 立即可执行（queued）。 */
  peakUntil: Date | null;
}

/**
 * 把既有任务行重置为一轮全新审查：高峰期 → deferred（not_before = 峰后，reason = peak），
 * 否则 queued（reason 保留 decision 短码；`manual` 需要留存，worker 据此向流水线传
 * force 跳过去重）。attempts / started_at / finished_at 与上一轮审查结果字段一并清空。
 * 正在 running 的行不动（不打扰 worker），返回原样任务。
 */
export function resetJobForRun(state: StateDb, id: number, options: ResetJobOptions): Job {
  const nowIso = toIso(options.now);
  state.sqlite
    .prepare(
      `UPDATE jobs SET
         status = ?, reason = ?, attempts = 0, not_before = ?,
         started_at = NULL, finished_at = NULL,
         review_url = NULL, findings_count = NULL, model = NULL, updated_at = ?
       WHERE id = ? AND status <> 'running'`,
    )
    .run(
      options.peakUntil === null ? 'queued' : 'deferred',
      options.peakUntil === null ? options.reason : 'peak',
      toIso(options.peakUntil ?? options.now),
      nowIso,
      id,
    );
  return getJob(state, id);
}

/**
 * 优雅退出等待超时后中断：把仍在 running 的任务放回 queued（保留已消耗的 attempts，
 * not_before = now，下次启动立即重试）。只影响 running 行，返回是否生效。
 */
export function requeueRunningJob(state: StateDb, id: number, now: Date): boolean {
  const result = state.sqlite
    .prepare(
      `UPDATE jobs SET status = 'queued', started_at = NULL, not_before = ?, updated_at = ?
       WHERE id = ? AND status = 'running'`,
    )
    .run(toIso(now), toIso(now), id);
  return Number(result.changes) === 1;
}

/**
 * 把退回领取的任务延后再试：本轮已审过、结算时被 refundClaim 放回 queued 的任务
 * （dry-run 预览 / waiting），not_before 还停在领取前，claimNext 会立刻再领到它，
 * 同一轮反复空转；延后一个闸门周期（30s）让本轮自然排干。
 */
export function deferNotBefore(state: StateDb, id: number, notBefore: Date): void {
  state.sqlite
    .prepare(
      `UPDATE jobs SET not_before = ?, updated_at = ?
       WHERE id = ? AND status IN ('queued', 'deferred')`,
    )
    .run(toIso(notBefore), toIso(notBefore), id);
}

/** 队列（queued / deferred）里最早的 not_before；队列空返回 null。 */
export function earliestNotBefore(state: StateDb): string | null {
  const row = state.sqlite
    .prepare(
      `SELECT MIN(not_before) AS earliest FROM jobs WHERE status IN ('queued', 'deferred')`,
    )
    .get() as { earliest: string | null } | undefined;
  return row?.earliest ?? null;
}
