/**
 * 轮询（#13）：每 pollIntervalSec 一轮，对白名单里每个仓库 listOpenPrs，
 * 按 #12 的 decide 判定入队 / 跳过 / 忽略，并处理 PR 评论里的 /glm-review 手动重审。
 *
 * - 新 head 到来时先 supersede 旧 sha 上未开始的任务（queued / deferred）；
 * - 仓库配置（默认分支的 .glm-review.yml）每仓库缓存 10 分钟；
 * - 高峰期发现的新任务照常入队，但状态是 deferred、not_before = 本段高峰结束；
 * - 单个仓库出错（404、网络……）只记日志、不影响其他仓库；命中限流时按建议等待
 *   秒数暂停本轮剩余轮询（返回 rateLimitUntil，由 daemon 决定下一轮时刻）；
 * - 每轮结束写一条心跳到状态库 meta（时间、上轮耗时、各仓库开放 PR 数，供 #14 显示）；
 * - 已处理评论 id 与评论时间水位线持久化在 meta 表（键名见 TRIGGER_META_*，
 *   见 #12 PR 给 #13 的组装说明）。
 */
import { loadRepoConfig, type RepoConfig, type RepoConfigResult } from '../config/repo.ts';
import type { GlobalConfig } from '../config/global.ts';
import { getPrComments, listOpenPrs, RateLimitError, type GithubDeps } from '../github/index.ts';
import type { Logger } from '../lib/log.ts';
import type { PrInfo, RepoSlug } from '../lib/types.ts';
import { deferUntil } from '../peak/peak.ts';
import { META_DAEMON_HEARTBEAT_AT, META_DAEMON_LAST_POLL_MS, META_DAEMON_OPEN_PRS } from '../status/collect.ts';
import { enqueue, markSkipped, supersede } from '../state/jobs.ts';
import type { StateDb } from '../state/db.ts';
import { decide } from '../triggers/decide.ts';
import { parseReviewCommands } from '../triggers/commands.ts';
import { getMeta, setMeta } from './meta.ts';
import { findJobByKey, resetJobForRun } from './queue.ts';

/** 仓库配置缓存时长（10 分钟）。 */
export const REPO_CONFIG_TTL_MS = 10 * 60 * 1000;

/** /glm-review 已处理评论 id 的 meta 键（每个 PR 一键，值为 JSON 数组）。 */
export function processedCommentsKey(repo: RepoSlug, pr: number): string {
  return `trigger:processed-comments:${repo}#${pr}`;
}

/** 评论时间水位线的 meta 键（每个 PR 一键，值为 ISO 时刻）。 */
export function commentsWatermarkKey(repo: RepoSlug, pr: number): string {
  return `trigger:comments-watermark:${repo}#${pr}`;
}

export interface PollerDeps extends GithubDeps {
  log: Logger;
  state: StateDb;
  config: GlobalConfig;
}

/**
 * 仓库配置缓存：loadRepoConfig 每仓库最多每 ttlMs 重新拉一次（gh api 调用），
 * 404 = 缺省配置由 loadRepoConfig 内部处理；其他错误原样抛给调用方。
 * deps 用 getter 形式，取用时再解析（测试 rebuild 换 fakebin 后 env 已更新）。
 */
export interface RepoConfigCache {
  get(repo: RepoSlug): Promise<RepoConfigResult>;
}

export function createRepoConfigCache(
  deps: () => { exec: GithubDeps['exec']; env?: GithubDeps['env']; now: () => Date },
  ttlMs: number = REPO_CONFIG_TTL_MS,
): RepoConfigCache {
  const cache = new Map<RepoSlug, { atMs: number; result: RepoConfigResult }>();
  return {
    async get(repo: RepoSlug): Promise<RepoConfigResult> {
      const resolved = deps();
      const hit = cache.get(repo);
      if (hit !== undefined && resolved.now().getTime() - hit.atMs < ttlMs) return hit.result;
      const result = await loadRepoConfig(repo, { exec: resolved.exec, env: resolved.env });
      cache.set(repo, { atMs: resolved.now().getTime(), result });
      return result;
    },
  };
}

/** 一个仓库一轮轮询的结果。 */
export interface RepoPollOutcome {
  repo: string;
  openPrs: number;
  enqueued: number;
  skipped: number;
  superseded: number;
  /** 本仓库轮询失败的错误信息（单仓失败不影响其他仓库）。 */
  error?: string;
}

/** 一轮轮询的汇总（也用于日志与心跳）。 */
export interface PollSummary {
  /** 本轮开始的时刻。 */
  startedAt: Date;
  /** 本轮耗时（毫秒）。 */
  durationMs: number;
  repos: RepoPollOutcome[];
  /** 各仓库开放 PR 数（心跳 meta 同值）。 */
  openPrs: Record<string, number>;
  /** 命中限流时：建议恢复轮询的时刻（本轮剩余仓库已跳过）。 */
  rateLimitUntil?: Date;
}

/**
 * 执行一轮轮询。所有时间取自 deps.clock（测试用假时钟）；除标注外任何单仓库 /
 * 单 PR 的错误都不中断整轮。
 */
export async function pollOnce(
  deps: PollerDeps,
  repoConfigs: RepoConfigCache,
): Promise<PollSummary> {
  const { state, log, config } = deps;
  const startedAt = deps.clock.now();
  const repos: RepoPollOutcome[] = [];
  const openPrs: Record<string, number> = {};
  let rateLimitUntil: Date | undefined;

  for (const repo of config.repos) {
    const outcome: RepoPollOutcome = { repo, openPrs: 0, enqueued: 0, skipped: 0, superseded: 0 };
    const now = deps.clock.now();

    let prs: PrInfo[];
    try {
      prs = await listOpenPrs(deps, repo);
    } catch (err) {
      if (err instanceof RateLimitError) {
        rateLimitUntil = new Date(now.getTime() + err.retryAfterSeconds * 1000);
        outcome.error = `GitHub API 限流，暂停轮询到 ${rateLimitUntil.toISOString()}`;
        log.warn('GitHub API 限流，本轮轮询暂停', {
          repo,
          retryAfterSeconds: err.retryAfterSeconds,
          until: rateLimitUntil.toISOString(),
          err: String(err),
        });
        repos.push(outcome);
        break;
      }
      outcome.error = err instanceof Error ? err.message : String(err);
      log.warn('轮询仓库失败，跳过该仓库', { repo, err: outcome.error });
      repos.push(outcome);
      continue;
    }
    outcome.openPrs = prs.length;
    openPrs[repo] = prs.length;

    let repoConfig: RepoConfig;
    try {
      repoConfig = (await repoConfigs.get(repo)).config;
    } catch (err) {
      outcome.error = err instanceof Error ? err.message : String(err);
      log.warn('读取仓库配置失败，跳过该仓库本轮', { repo, err: outcome.error });
      repos.push(outcome);
      continue;
    }

    for (const pr of prs) {
      try {
        outcome.superseded += supersede(state, repo, pr.number, pr.headSha, deps.clock.now());
        const force = await checkManualCommands(deps, repo, pr);
        const existing = findJobByKey(state, repo, pr.number, pr.headSha);
        const decision = decide(
          pr,
          repoConfig,
          existing === undefined
            ? { force }
            : { existingJob: { status: existing.status, reason: existing.reason }, force },
        );
        if (decision.action === 'ignore') {
          log.debug('PR 无需处理', { repo, pr: pr.number, reason: decision.reason });
        } else if (decision.action === 'skip') {
          let target = existing;
          if (target === undefined) {
            target = enqueue(state, {
              repo,
              pr: pr.number,
              headSha: pr.headSha,
              now: deps.clock.now(),
            }).job;
          }
          // 终态（done / failed / skipped）与 running 的行不改写：running 归 worker，
          // 终态是历史记录；只有排队中的任务会被新的跳过规则拦下。
          if (target.status === 'queued' || target.status === 'deferred') {
            markSkipped(state, target.id, decision.reason, deps.clock.now());
            outcome.skipped += 1;
            log.info('PR 命中跳过规则', { repo, pr: pr.number, reason: decision.reason });
          }
        } else {
          const now2 = deps.clock.now();
          const peakUntil = config.peak.enabled ? deferUntil(now2) : null;
          if (existing === undefined) {
            enqueue(state, {
              repo,
              pr: pr.number,
              headSha: pr.headSha,
              now: now2,
              ...(peakUntil === null ? {} : { status: 'deferred' as const, notBefore: peakUntil, reason: 'peak' }),
            });
          } else if (existing.status === 'running') {
            log.info('任务正在审查中，不重置', { repo, pr: pr.number, jobId: existing.id });
          } else {
            resetJobForRun(state, existing.id, { now: now2, reason: decision.reason, peakUntil });
          }
          outcome.enqueued += 1;
          log.info('PR 入队审查', {
            repo,
            pr: pr.number,
            sha: pr.headSha.slice(0, 7),
            reason: decision.reason,
            ...(peakUntil === null ? {} : { notBefore: peakUntil.toISOString() }),
          });
        }
      } catch (err) {
        log.warn('处理 PR 失败，跳过该 PR', {
          repo,
          pr: pr.number,
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }
    repos.push(outcome);
  }

  const endedAt = deps.clock.now();
  const durationMs = endedAt.getTime() - startedAt.getTime();
  setMeta(state, META_DAEMON_HEARTBEAT_AT, endedAt.toISOString());
  setMeta(state, META_DAEMON_LAST_POLL_MS, String(durationMs));
  setMeta(state, META_DAEMON_OPEN_PRS, JSON.stringify(openPrs));
  log.info('一轮轮询完成', {
    at: endedAt.toISOString(),
    ms: durationMs,
    repos: repos.map((r) => ({ repo: r.repo, openPrs: r.openPrs, enqueued: r.enqueued })),
    ...(rateLimitUntil === undefined ? {} : { rateLimitUntil: rateLimitUntil.toISOString() }),
  });
  return { startedAt, durationMs, repos, openPrs, ...(rateLimitUntil === undefined ? {} : { rateLimitUntil }) };
}

/**
 * 读取 PR 会话评论，解析 /glm-review 手动重审命令。返回是否命中（force）；
 * 命中后把重置 reason 定为 manual（force 已在 decide 里忽略去重与跳过规则）。
 * 已处理评论 id 与时间水位线经 meta 表持久化（见模块注释）。评论读取失败只告警，
 * 不影响该 PR 的常规判定。
 */
async function checkManualCommands(deps: PollerDeps, repo: RepoSlug, pr: PrInfo): Promise<boolean> {
  const { state, log } = deps;
  let comments;
  try {
    comments = await getPrComments(deps, repo, pr.number);
  } catch (err) {
    log.warn('读取 PR 评论失败，本轮不处理重审命令', {
      repo,
      pr: pr.number,
      err: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
  const watermark = getMeta(state, commentsWatermarkKey(repo, pr.number));
  const processedRaw = getMeta(state, processedCommentsKey(repo, pr.number));
  let processedIds: readonly number[] = [];
  try {
    const parsedIds = processedRaw === null ? [] : (JSON.parse(processedRaw) as unknown);
    if (Array.isArray(parsedIds) && parsedIds.every((id) => typeof id === 'number')) {
      processedIds = parsedIds as number[];
    }
  } catch {
    processedIds = [];
  }
  const owner = repo.split('/')[0] ?? 'Jackeyhan-JH';
  const parsed = parseReviewCommands(comments, watermark ?? undefined, {
    owners: [owner],
    processedCommentIds: processedIds,
  });
  // 水位线推进到本轮见过的最新评论时刻（无论是否命中命令），下轮少扫旧评论。
  const latest = comments.reduce<string | null>((max, comment) => {
    if (max === null || comment.createdAt > max) return comment.createdAt;
    return max;
  }, null);
  if (latest !== null && (watermark === null || latest > watermark)) {
    setMeta(state, commentsWatermarkKey(repo, pr.number), latest);
  }
  if (parsed.commands.length === 0) return false;
  setMeta(state, processedCommentsKey(repo, pr.number), JSON.stringify(parsed.processedCommentIds));
  for (const command of parsed.commands) {
    log.info('收到手动重审命令', {
      repo,
      pr: pr.number,
      commentId: command.commentId,
      author: command.author,
      full: command.full,
    });
  }
  return true;
}
