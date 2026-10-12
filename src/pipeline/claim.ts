/**
 * 领取审查任务（#33）：reviewPr 不再领取任务、也不再自己 markFailed（否则未领取的任务
 * attempts 恒为 0，永远进不了终态 failed）。领取与失败记录归调用方：
 *
 * - CLI `review` 路径（本文件）：getPr 拿 head SHA → enqueue 建任务行 → claimJob 领取
 *   （置 running、attempts+1）→ reviewPr → settleClaimedReview 收尾（失败 markFailed；
 *   没真正审查的运行 refundClaim 退回领取，不占失败次数）；
 * - #13 的 worker：自己的 claimNext（按队列顺序领取）→ reviewPr → 自己的 markFailed。
 *
 * jobs.ts（#5）只提供按队列顺序的 claimNext，没有按 id 领取；本文件用同样的语义在
 * pipeline 侧补齐（UPDATE 的 WHERE 守卫保证原子性，两处并发领取同一行只会成功一次）。
 * 后续宜作为小 issue 挪进 src/state/jobs.ts（#1：共享代码不在功能 PR 里顺手改）。
 */
import { toIso, type StateDb } from '../state/db.ts';
import { getJob, markFailed, type Job, type RetryPolicy } from '../state/jobs.ts';
import type { ReviewOutcome } from './review.ts';

/**
 * 按 id 领取任务：置 running、attempts +1、记 started_at（与 claimNext 同语义）。
 * 只认领 queued / deferred 的行；已是 running 或终态（done / failed / skipped）时不
 * 重复计 attempts，原样返回当前任务。与 claimNext 不同，这里**不看 not_before**——
 * 手动 `glm-review review` 是用户显式要求立刻执行（高峰闸门仍由 reviewPr 内部把关），
 * 退避中的任务也允许手动提前重试，本次照常计一次 attempts。
 */
export function claimJob(state: StateDb, id: number, now: Date): Job {
  const nowIso = toIso(now);
  state.sqlite
    .prepare(
      `UPDATE jobs SET status = 'running', attempts = attempts + 1, started_at = ?, updated_at = ?
       WHERE id = ? AND status IN ('queued', 'deferred')`,
    )
    .run(nowIso, nowIso, id);
  return getJob(state, id);
}

/**
 * 退回一次领取（#35 复审 A：没真正审查的运行不占失败次数）：attempts -1（不低于 0）、
 * 清 started_at。after 决定任务回到哪里：
 * - 'queued'：waiting / superseded / dry-run 预览——闸门没过或只是预览，放回队列；
 * - 'deferred'：高峰延后——reviewPr 已把行置为 deferred 并设好 not_before，这里只退
 *   领取（status 与 not_before 原样保留）。
 * 只影响 running / deferred 的行，其余不动。
 */
export function refundClaim(state: StateDb, id: number, now: Date, after: 'queued' | 'deferred'): Job {
  state.sqlite
    .prepare(
      `UPDATE jobs SET status = ?, attempts = MAX(0, attempts - 1), started_at = NULL, updated_at = ?
       WHERE id = ? AND status IN ('running', 'deferred')`,
    )
    .run(after, toIso(now), id);
  return getJob(state, id);
}

export interface SettleOptions {
  now: Date;
  /** 失败记录用的重试策略（传给 markFailed；缺省 DEFAULT_RETRY_POLICY）。 */
  retry?: RetryPolicy;
}

/**
 * 领取后的一次收尾（调用方契约，#33 / #35 复审 A）：
 * - failed：调用方记一次失败（markFailed）——按领取时累计的 attempts 决定回队列退避
 *   还是终态 failed；真实审查（含 dry-run 里 claude 真失败了）才占失败次数；
 * - deferred / waiting / superseded / dry-run 预览：没真正审查，refundClaim 退回领取
 *   （attempts -1、清 started_at），任务回到排队状态；
 * - 其余（reviewed / skipped / already-reviewed）：reviewPr 内部已落库，不用动，
 *   返回 undefined。
 *
 * 返回收尾后的任务；没有任何动作时返回 undefined。失败是否回队列看返回值的
 * status（queued = 已回队列重试，failed = 已达上限的终态）。
 */
export function settleClaimedReview(
  state: StateDb,
  job: Job,
  outcome: ReviewOutcome,
  options: SettleOptions,
): Job | undefined {
  switch (outcome.status) {
    case 'failed':
      return markFailed(state, job.id, outcome.error, { now: options.now, retry: options.retry });
    case 'deferred':
      return refundClaim(state, job.id, options.now, 'deferred');
    case 'waiting':
    case 'superseded':
      return refundClaim(state, job.id, options.now, 'queued');
    case 'reviewed':
      // dry-run 预览不标记 done（不占「审过」去重键），也不占失败次数，退回领取。
      return outcome.dryRun ? refundClaim(state, job.id, options.now, 'queued') : undefined;
    default:
      return undefined;
  }
}
