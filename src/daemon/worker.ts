/**
 * 审查执行器（#13）：循环 claimNext(now) 领取任务并调用 #11 的 reviewPr，
 * 领取与失败记录都归本模块（#33 约定：reviewPr 不再自己 markFailed）：
 *
 * - 高峰期内不 claim（任务保持 deferred 到峰后）；canStartWork 防止审查跑进高峰；
 * - checkGate（暂停文件 / 本机进程数 / 自身并发）不通过时不领取，
 *   持续模式由外层按 30 秒后重试（DrainResult.blocked.retryAt）；
 * - 结算走 #35 的 settleClaimedReview：failed → markFailed（按 attempts 退避）；
 *   deferred / waiting / superseded / dry-run 预览 → refundClaim 退回领取，
 *   「没真正审查的运行不占失败次数」；reviewPr 抛异常 → 本模块 markFailed，
 *   任务绝不卡在 running；
 * - 同时运行的审查数 ≤ config.maxConcurrent（领取前闸门也带上自身占位）。
 */
import type { GlobalConfig } from '../config/global.ts';
import { checkGate } from '../llm/gate.ts';
import type { ExecFn } from '../lib/exec.ts';
import type { Logger } from '../lib/log.ts';
import type { Paths } from '../lib/paths.ts';
import { canStartWork, deferUntil, isPeak } from '../peak/peak.ts';
import { reviewPr, type ReviewOutcome, type ReviewPipelineDeps } from '../pipeline/review.ts';
import { settleClaimedReview, refundClaim } from '../pipeline/claim.ts';
import type { GithubDeps } from '../github/index.ts';
import { claimNext, markFailed, type Job } from '../state/jobs.ts';
import type { StateDb } from '../state/db.ts';
import { deferNotBefore, earliestNotBefore, requeueRunningJob } from './queue.ts';

/** 闸门未通过时的重试间隔（见 #13：等待 30 秒再试）。 */
export const GATE_RETRY_MS = 30_000;

export interface WorkerDeps extends GithubDeps {
  log: Logger;
  state: StateDb;
  config: GlobalConfig;
  /** 中文进度输出（--once / 前台运行时接 stdout）；缺省不输出。 */
  out?: (text: string) => void;
  /** 可注入的流水线入口（测试并发上限等场景用）；缺省 reviewPr。 */
  review?: typeof reviewPr;
  /** 可注入的限时等待器（测试优雅退出超时路径用）；缺省真实 setTimeout。 */
  waitAll?: GraceWaiter;
}

export interface WorkerOptions {
  /** 透传给流水线：只预览不发送，也不标记 done。 */
  dryRun: boolean;
  /** 是否已收到退出信号（SIGINT / SIGTERM）；true 时不再领取新任务。 */
  shuttingDown: () => boolean;
}

/** 一轮执行（runRound）的收尾状态。 */
export interface DrainResult {
  /** 本轮完成收尾的审查次数（成功 / 跳过 / 失败都算）。 */
  processed: number;
  /** 无法继续领取的原因与最早可重试时刻。 */
  blocked: {
    reason: 'peak' | 'work-window' | 'gate' | 'idle' | 'shutdown';
    retryAt?: Date;
    detail?: string;
  };
}

/** 带时限地等一组 promise：全部完成 → 'done'；到时 → 'timeout'。 */
export type GraceWaiter = (promises: Promise<void>[], graceMs: number) => Promise<'done' | 'timeout'>;

export const defaultGraceWaiter: GraceWaiter = (promises, graceMs) =>
  Promise.race([
    Promise.all(promises).then(() => 'done' as const),
    new Promise<'timeout'>((resolve) => {
      setTimeout(() => resolve('timeout'), graceMs);
    }),
  ]);

/** awaitSettle 的结果。 */
export interface SettleResult {
  /** 等待超时被放回队列的任务数。 */
  abandoned: number;
}

/**
 * 审查执行器。runRound 领取并启动所有当前可执行的任务（受并发上限约束，腾不出
 * 名额时会等待在跑审查结束）；awaitSettle 等待收尾，优雅退出时带宽限，超时的
 * running 任务放回队列（requeueRunningJob）。
 */
export interface ReviewWorker {
  /** 领取并执行直到无法继续（不等待全部在跑审查收尾，除非并发名额阻塞）。 */
  runRound(): Promise<DrainResult>;
  /** 当前在跑的审查数。 */
  inFlightCount(): number;
  /** 等待在跑审查结束；graceMs 到时后把仍在 running 的任务放回队列并返回。 */
  awaitSettle(graceMs?: number): Promise<SettleResult>;
}

export function createWorker(deps: WorkerDeps, options: WorkerOptions): ReviewWorker {
  const { state, config, log } = deps;
  const review = deps.review ?? reviewPr;
  const running = new Map<number, Promise<void>>();
  // 本轮已审过、结算时被退回领取（queued）的任务：再领到时延后一个闸门周期，
  // 避免 dry-run / waiting 在同一轮里反复领取同一任务空转。每轮 runRound 开始清空。
  const refundedThisRound = new Set<number>();
  let processed = 0;

  const pipelineDeps: ReviewPipelineDeps = {
    exec: deps.exec,
    clock: deps.clock,
    paths: deps.paths,
    ...(deps.env === undefined ? {} : { env: deps.env }),
    log,
    state,
    config,
    ...(deps.out === undefined ? {} : { out: deps.out }),
    ...(deps.out === undefined ? {} : { progress: (text: string) => deps.out?.(`→ ${text}`) }),
  };

  const retry = {
    maxAttempts: config.retry.maxAttempts,
    backoffSeconds: config.retry.backoffSec,
  };

  /** 执行一个已领取的任务并结算（绝不 reject：异常也走 markFailed）。 */
  const runJob = async (job: Job): Promise<void> => {
    const label = `${job.repo}#${job.pr}（${job.headSha.slice(0, 7)}）`;
    deps.out?.(`▶ 开始审查 ${label}（第 ${job.attempts} 次尝试${options.dryRun ? '，dry-run' : ''}）`);
    let outcome: ReviewOutcome;
    try {
      outcome = await review(
        {
          repo: job.repo,
          pr: job.pr,
          headSha: job.headSha,
          dryRun: options.dryRun,
          // manual（/glm-review 手动重审）跳过状态库与 PR 标记的去重检查。
          force: job.reason === 'manual',
        },
        pipelineDeps,
      );
    } catch (err) {
      // reviewPr 抛出（gh / git / 配置等基础设施错误）：记一次失败，任务不卡 running。
      const error = err instanceof Error ? err : new Error(String(err));
      const failed = markFailed(state, job.id, error, { now: deps.clock.now(), retry });
      log.error('审查异常，按重试策略处理', {
        jobId: job.id,
        repo: job.repo,
        pr: job.pr,
        err: error.message,
        status: failed.status,
      });
      deps.out?.(
        failed.status === 'queued'
          ? `✗ ${label} 审查异常：${error.message}（已按退避重新排队）`
          : `✗ ${label} 审查异常：${error.message}（已达重试上限，标记 failed）`,
      );
      processed += 1;
      return;
    }
    const settled = settleClaimedReview(state, job, outcome, { now: deps.clock.now(), retry });
    const refundedBack =
      outcome.status === 'waiting' ||
      outcome.status === 'superseded' ||
      (outcome.status === 'reviewed' && outcome.dryRun);
    if (refundedBack && settled !== undefined && settled.status === 'queued') {
      refundedThisRound.add(job.id);
    }
    log.info('审查收尾', {
      jobId: job.id,
      repo: job.repo,
      pr: job.pr,
      outcome: outcome.status,
      ...(settled === undefined ? {} : { jobStatus: settled.status }),
    });
    deps.out?.(renderOutcomeLine(label, outcome, settled));
    processed += 1;
  };

  const runRound = async (): Promise<DrainResult> => {
    refundedThisRound.clear();
    // 单次 claude 调用的超时作为审查预计耗时（canStartWork 按分钟粒度防跑进高峰；
    // 多块审查超出预计时由块内的峰期记账兜底，不再额外放大预估）。
    const estMinutes = Math.max(1, Math.ceil(config.claude.timeoutSec / 60));
    // pgrep 不接受 env 注入，包一层让测试的 fakebin PATH 生效（生产行为不变）。
    const gateExec: ExecFn = (cmd, args, execOptions = {}) =>
      deps.exec(cmd, args, { ...execOptions, env: deps.env });

    for (;;) {
      if (options.shuttingDown()) return { processed, blocked: { reason: 'shutdown' } };
      if (running.size >= config.maxConcurrent) {
        await Promise.race(running.values());
        continue;
      }
      const now = deps.clock.now();
      if (config.peak.enabled) {
        if (isPeak(now)) {
          const until = deferUntil(now);
          return {
            processed,
            blocked: { reason: 'peak', ...(until === null ? {} : { retryAt: until }) },
          };
        }
        const window = canStartWork(now, estMinutes);
        if (!window.ok) {
          return {
            processed,
            blocked: {
              reason: 'work-window',
              ...(window.waitUntil === undefined ? {} : { retryAt: window.waitUntil }),
              detail: `预计耗时 ${estMinutes} 分钟会跨进高峰`,
            },
          };
        }
      }
      const gate = await checkGate(
        {
          pauseFile: config.pauseFile,
          boxClaudeLimit: config.boxClaudeLimit,
          maxConcurrent: config.maxConcurrent,
          mineRunning: running.size,
        },
        { exec: gateExec },
      );
      if (!gate.ok) {
        return {
          processed,
          blocked: {
            reason: 'gate',
            retryAt: new Date(now.getTime() + GATE_RETRY_MS),
            detail: gate.detail,
          },
        };
      }
      const job = claimNext(state, deps.clock.now());
      if (job === undefined) {
        const earliest = earliestNotBefore(state);
        return {
          processed,
          blocked: {
            reason: 'idle',
            ...(earliest === null ? {} : { retryAt: new Date(earliest) }),
          },
        };
      }
      if (refundedThisRound.has(job.id)) {
        // 刚被退回的任务又被领到（not_before 还停在领取前）：退回领取并延后 30 秒。
        refundClaim(state, job.id, deps.clock.now(), 'queued');
        const retryAt = new Date(deps.clock.now().getTime() + GATE_RETRY_MS);
        deferNotBefore(state, job.id, retryAt);
        refundedThisRound.delete(job.id);
        log.info('本轮已审过且被退回的任务，延后再试', { jobId: job.id, retryAt: retryAt.toISOString() });
        continue;
      }
      log.info('领取任务', { jobId: job.id, repo: job.repo, pr: job.pr, attempts: job.attempts });
      const task = runJob(job).finally(() => {
        running.delete(job.id);
      });
      running.set(job.id, task);
    }
  };

  const awaitSettle = async (graceMs?: number): Promise<SettleResult> => {
    const snapshot = [...running.values()];
    if (snapshot.length === 0) return { abandoned: 0 };
    if (graceMs === undefined) {
      await Promise.all(snapshot);
      return { abandoned: 0 };
    }
    const outcome = await (deps.waitAll ?? defaultGraceWaiter)(snapshot, graceMs);
    if (outcome === 'done') return { abandoned: 0 };
    // 超时：仍在 running 的任务（settled 的已自行从 map 移除）放回队列，等下一次启动重试。
    const now = deps.clock.now();
    for (const jobId of [...running.keys()]) {
      if (requeueRunningJob(state, jobId, now)) {
        log.warn('优雅退出等待超时，任务放回队列', { jobId });
      }
    }
    const abandoned = running.size;
    // 被放弃的审查随后台 promise 自行结束；防御性兜住 rejection，不影响进程退出。
    for (const promise of running.values()) void promise.catch(() => {});
    return { abandoned };
  };

  return {
    runRound,
    inFlightCount: () => running.size,
    awaitSettle,
  };
}

/** 结算结果 → 一行中文输出（ settled 是 settleClaimedReview 的返回值，可缺省）。 */
function renderOutcomeLine(
  label: string,
  outcome: ReviewOutcome,
  settled: Job | undefined,
): string {
  switch (outcome.status) {
    case 'reviewed':
      return outcome.dryRun
        ? `✔ ${label} dry-run 预览完成（${outcome.findingsCount} 条问题，模型 ${outcome.model}，未发送）`
        : `✔ ${label} 审查完成：${outcome.url}（${outcome.findingsCount} 条问题，模型 ${outcome.model}）`;
    case 'already-reviewed':
      return `• ${label} 该 commit 已审过，跳过`;
    case 'superseded':
      return `• ${label} head 已变化（${outcome.expected.slice(0, 7)} → ${outcome.current.slice(0, 7)}），本次取消`;
    case 'deferred':
      return `• ${label} 高峰期，已排队到 ${outcome.until}`;
    case 'waiting':
      return `• ${label} 闸门未通过（${outcome.detail}），保持排队`;
    case 'skipped':
      return `• ${label} 已跳过（${outcome.reason}）`;
    case 'failed': {
      const requeued = settled !== undefined && settled.status === 'queued';
      return requeued
        ? `✗ ${label} 审查失败：${outcome.error}（已按退避重新排队）`
        : `✗ ${label} 审查失败：${outcome.error}（已达重试上限，标记 failed）`;
    }
  }
}
