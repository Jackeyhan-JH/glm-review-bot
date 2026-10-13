/**
 * 守护进程编排（#13）：单实例锁 → 启动恢复 → 「轮询 → 领取执行 → 等待」循环 → 优雅退出。
 *
 * - 单实例：paths.lockFile 写 pid；锁被活着的进程占用则拒绝启动（退出码 4），
 *   过期锁（进程已死 / 内容损坏）接管；
 * - 启动时 recoverStale：上次实例崩溃滞留在 running 的任务放回队列；
 * - SIGINT / SIGTERM：停止轮询与领取新任务，等待正在运行的审查最多
 *   claude.timeoutSec，超时则中断并把任务放回队列，最后释放锁；
 * - --once：只做一轮轮询 + 处理所有当前可执行任务后退出（不等待高峰 / 闸门 / 退避），
 *   便于测试与 cron；
 * - 持续模式每轮之间睡到「下一轮轮询 / 队列最早可执行 / 闸门重试 / 限流恢复」中
 *   最早的时刻（上限 pollIntervalSec），退出信号随时打断睡眠，并取消在途的睡眠
 *   计时器（#39）：race 先行返回后未清理的 setTimeout 会把进程占住到睡满为止。
 */
import type { GlobalConfig } from '../config/global.ts';
import type { GithubDeps } from '../github/index.ts';
import type { Logger } from '../lib/log.ts';
import { ensureDirs } from '../lib/paths.ts';
import { recoverStale } from '../state/jobs.ts';
import type { StateDb } from '../state/db.ts';
import type { ReviewOutcome, ReviewPipelineDeps, ReviewPrInput } from '../pipeline/review.ts';
import { acquireLock, releaseLock } from './lock.ts';
import { createRepoConfigCache, pollOnce, type PollSummary } from './poller.ts';
import { createWorker, type GraceWaiter } from './worker.ts';

/** 持续模式两轮之间睡眠的下限，避免时钟不前进时的忙转。 */
const MIN_SLEEP_MS = 250;

export interface DaemonOptions {
  /** 只做一轮轮询 + 处理所有当前可执行任务后退出。 */
  once?: boolean;
  /** 透传给流水线：只预览不发送。 */
  dryRun?: boolean;
}

export interface DaemonDeps extends GithubDeps {
  log: Logger;
  state: StateDb;
  config: GlobalConfig;
  /** 中文进度输出（--once / 前台运行接 stdout）；缺省不输出。 */
  out?: (text: string) => void;
  /** 睡眠函数（默认真实 setTimeout；测试注入）。 */
  sleep?: (ms: number) => Promise<void>;
  /** 限时等待器（默认真实 setTimeout；测试注入）。 */
  waitAll?: GraceWaiter;
  /** 可注入的流水线入口（测试用）。 */
  review?: (input: ReviewPrInput, deps: ReviewPipelineDeps) => Promise<ReviewOutcome>;
  /** 信号注册（默认 process 的 SIGINT / SIGTERM）；返回注销函数，测试注入空实现。 */
  installSignals?: (onSignal: (name: string) => void) => () => void;
}

export interface DaemonRunResult {
  /** 进程退出码：0 正常（含优雅退出），4 已有实例在运行。 */
  code: number;
  /** 拒绝启动时占用锁的进程 pid。 */
  holderPid?: number;
  /** 优雅退出等待超时、被放回队列的任务数。 */
  abandoned: number;
  /** 执行的轮询轮数。 */
  rounds: number;
}

/** 默认信号注册：挂 SIGINT / SIGTERM，返回注销函数。 */
function defaultInstallSignals(onSignal: (name: string) => void): () => void {
  const onSigint = (): void => onSignal('SIGINT');
  const onSigterm = (): void => onSignal('SIGTERM');
  process.on('SIGINT', onSigint);
  process.on('SIGTERM', onSigterm);
  return () => {
    process.removeListener('SIGINT', onSigint);
    process.removeListener('SIGTERM', onSigterm);
  };
}

/** 领取暂停原因的中文说明（一行）。 */
function blockedLabel(blocked: { reason: string; retryAt?: Date; detail?: string }): string {
  const at = blocked.retryAt === undefined ? '' : `，最早 ${blocked.retryAt.toISOString()} 再试`;
  switch (blocked.reason) {
    case 'peak':
      return `处于 GLM 高峰期（任务保持 deferred 到峰后）${at}`;
    case 'work-window':
      return `${blocked.detail ?? '预计会跨进高峰'}${at}`;
    case 'gate':
      return `启动闸门未通过（${blocked.detail ?? ''}），30 秒后重试`;
    case 'shutdown':
      return '收到退出信号';
    default:
      return `队列暂无可执行任务${at}`;
  }
}

/** 多个候选时刻里最早的那个（忽略 undefined）。 */
function earliestOf(candidates: Array<Date | undefined>): Date | undefined {
  return candidates.reduce<Date | undefined>(
    (min, at) => (at === undefined ? min : min === undefined || at < min ? at : min),
    undefined,
  );
}

/** 在途的默认睡眠计时器：退出信号唤醒睡眠时统一取消（见 wake），进程不被滞留的计时器占住事件循环。 */
const sleepTimers = new Set<ReturnType<typeof setTimeout>>();

/** 默认睡眠：登记计时器，睡满时自摘；被退出信号取消时不再结算（race 已由唤醒方胜出）。 */
const defaultSleep = (ms: number): Promise<void> =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      sleepTimers.delete(timer);
      resolve();
    }, ms);
    sleepTimers.add(timer);
  });

export async function runDaemon(
  options: DaemonOptions,
  deps: DaemonDeps,
): Promise<DaemonRunResult> {
  const { config, log, state } = deps;
  ensureDirs(deps.paths);

  // 1. 单实例锁：被活着的进程占用 → 拒绝启动（退出码 4）。中文提示由命令层输出。
  const lock = acquireLock(deps.paths.lockFile);
  if (!lock.ok) {
    log.error('已有守护进程实例在运行，拒绝启动', { holderPid: lock.holderPid });
    return { code: 4, holderPid: lock.holderPid, abandoned: 0, rounds: 0 };
  }
  if (lock.tookOver) {
    log.warn('接管过期的守护进程锁', { lockFile: deps.paths.lockFile });
  }

  // 2. 退出信号：置 shutdown 并唤醒所有等待（睡眠 / 收尾等待）。
  let shutdown = false;
  const wakeFns = new Set<() => void>();
  const wake = (): void => {
    // 先取消在途的睡眠计时器再唤醒等待者：优雅退出不等剩余的睡眠窗口（#39）。
    for (const timer of [...sleepTimers]) clearTimeout(timer);
    sleepTimers.clear();
    for (const fn of [...wakeFns]) fn();
  };
  const onSignal = (name: string): void => {
    if (shutdown) return;
    shutdown = true;
    log.info('收到退出信号，开始优雅退出', { signal: name });
    deps.out?.(`收到 ${name}，优雅退出：停止轮询与领取，等待正在运行的审查（最多 ${config.claude.timeoutSec} 秒）…`);
    wake();
  };
  const removeSignals = (deps.installSignals ?? defaultInstallSignals)(onSignal);

  // 3. 启动恢复：滞留 running 的任务（上次实例崩溃遗留）放回队列。
  const staleMinutes = Math.max(10, Math.ceil(config.claude.timeoutSec / 60) + 5);
  const recovered = recoverStale(state, deps.clock.now(), staleMinutes);
  if (recovered > 0) {
    log.warn('启动恢复：把滞留 running 的任务放回队列', { recovered, staleMinutes });
  }

  const repoConfigs = createRepoConfigCache(() => ({
    exec: deps.exec,
    ...(deps.env === undefined ? {} : { env: deps.env }),
    now: () => deps.clock.now(),
  }));
  const worker = createWorker(
    {
      exec: deps.exec,
      clock: deps.clock,
      paths: deps.paths,
      ...(deps.env === undefined ? {} : { env: deps.env }),
      log,
      state,
      config,
      ...(deps.out === undefined ? {} : { out: deps.out }),
      ...(deps.review === undefined ? {} : { review: deps.review }),
      ...(deps.waitAll === undefined ? {} : { waitAll: deps.waitAll }),
    },
    { dryRun: options.dryRun === true, shuttingDown: () => shutdown },
  );
  const sleep = deps.sleep ?? defaultSleep;
  const pollIntervalMs = config.pollIntervalSec * 1000;
  const graceMs = config.claude.timeoutSec * 1000;

  /** 可被退出信号打断的等待：信号先到 → 'woken'。 */
  const interruptible = async (p: Promise<unknown>): Promise<'woken' | 'awaited'> => {
    let wakeFn: (() => void) | undefined;
    try {
      return await Promise.race([
        p.then(() => 'awaited' as const),
        new Promise<'woken'>((resolve) => {
          wakeFn = (): void => resolve('woken');
          wakeFns.add(wakeFn);
        }),
      ]);
    } finally {
      if (wakeFn !== undefined) wakeFns.delete(wakeFn);
    }
  };

  let rounds = 0;
  let abandoned = 0;
  let rateLimitUntil: Date | undefined;
  try {
    for (;;) {
      if (shutdown) break;

      // 一轮：轮询（含心跳）→ 领取并执行当前可执行的任务。
      const summary = await pollOnce(deps, repoConfigs);
      rounds += 1;
      rateLimitUntil = summary.rateLimitUntil;
      for (const line of renderPollLines(summary)) deps.out?.(line);
      const drained = await worker.runRound();
      if (drained.blocked.reason !== 'idle') {
        log.info('本轮执行暂停领取', { blocked: drained.blocked });
        deps.out?.(`○ 本轮不再领取新任务：${blockedLabel(drained.blocked)}`);
      }
      if (worker.inFlightCount() > 0) {
        // 等在跑的审查收尾；退出信号随时打断（打断后走收尾分支的宽限等待）。
        await interruptible(worker.awaitSettle());
      }
      if (options.once) break;
      if (shutdown) break;

      // 睡到最早的「有事可做」时刻：下一轮轮询 / 限流恢复 / 队列可执行 / 闸门重试。
      const nextPollAt = rateLimitUntil ?? new Date(deps.clock.now().getTime() + pollIntervalMs);
      const wakeAt = earliestOf([nextPollAt, drained.blocked.retryAt]);
      let sleepMs = pollIntervalMs;
      if (wakeAt !== undefined) sleepMs = wakeAt.getTime() - deps.clock.now().getTime();
      sleepMs = Math.min(Math.max(Math.ceil(sleepMs), MIN_SLEEP_MS), pollIntervalMs);
      log.debug('等待下一轮', { sleepMs, blocked: drained.blocked.reason, ...(wakeAt === undefined ? {} : { wakeAt: wakeAt.toISOString() }) });
      await interruptible(sleep(sleepMs));
    }

    // 4. 优雅退出收尾：等待在跑审查最多 claude.timeoutSec，超时放回队列。
    if (worker.inFlightCount() > 0) {
      const settled = await worker.awaitSettle(shutdown ? graceMs : undefined);
      abandoned += settled.abandoned;
    }
    if (abandoned > 0) {
      log.warn('退出时仍有审查未完成，已放回队列', { abandoned });
      deps.out?.(`⚠ ${abandoned} 个审查等待超时，已放回队列（下次启动重试）。`);
    }
    return { code: 0, abandoned, rounds };
  } finally {
    // 任何路径（含异常）都释放单实例锁、摘掉信号监听。
    if (!releaseLock(deps.paths.lockFile)) {
      log.warn('锁文件已不含本进程 pid，未删除（可能已被后继实例接管）', {
        lockFile: deps.paths.lockFile,
      });
    }
    removeSignals();
  }
}

/** 一轮轮询的中文输出（每仓库一行，只在有情况时；外加一行汇总）。 */
function renderPollLines(summary: PollSummary): string[] {
  const lines: string[] = [];
  for (const repo of summary.repos) {
    if (repo.error !== undefined) {
      lines.push(`⚠ 仓库 ${repo.repo} 轮询失败：${repo.error}`);
    }
  }
  if (summary.rateLimitUntil !== undefined) {
    lines.push(`⚠ GitHub API 限流，轮询暂停到 ${summary.rateLimitUntil.toISOString()}`);
  }
  const enqueued = summary.repos.reduce((sum, repo) => sum + repo.enqueued, 0);
  const skipped = summary.repos.reduce((sum, repo) => sum + repo.skipped, 0);
  const superseded = summary.repos.reduce((sum, repo) => sum + repo.superseded, 0);
  const parts = [
    `开放 PR ${Object.values(summary.openPrs).reduce((a, b) => a + b, 0)}`,
    `入队 ${enqueued}`,
    `跳过 ${skipped}`,
    `被新 commit 取代 ${superseded}`,
  ];
  lines.push(`○ 轮询完成（${summary.durationMs}ms）：${parts.join('，')}。`);
  return lines;
}
