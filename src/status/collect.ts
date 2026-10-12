/**
 * 状态采集（#14）：把状态库 + 高峰规则 + 暂停文件汇成一份纯数据快照，
 * 供终端渲染（render-text.ts）、`--json` 输出与状态网页（server.ts）共用。
 *
 * 约定：
 * - 快照是可直接 `JSON.stringify` 的普通对象：时间一律 ISO 字符串，时长/间隔用毫秒数；
 * - 守护进程心跳由 #13 每轮写进 `meta` 表（键名见 `META_DAEMON_*` 常量）。本模块只读，
 *   且容忍缺失 / 损坏（显示「守护进程未运行或无心跳」）。#14 先于 #13 合并，键名以此为准；
 * - 心跳过期 = 距上次心跳超过 3 个轮询间隔（pollIntervalSec 来自全局配置，默认 120 秒）；
 * - 「今天」按北京时间（Asia/Shanghai）的日历日计算，与高峰规则同时区；
 * - 任务与调用一律经 jobs.ts / calls.ts 读取；meta 表没有读接口，这里只做只读 SELECT。
 */
import { existsSync } from 'node:fs';
import type { JobStatus } from '../lib/types.ts';
import { isPeak, nextSwitch } from '../peak/peak.ts';
import { listCalls } from '../state/calls.ts';
import type { StateDb } from '../state/db.ts';
import { listJobs, stats, type Job } from '../state/jobs.ts';

/** #13 写入的心跳时刻（ISO 字符串）。 */
export const META_DAEMON_HEARTBEAT_AT = 'daemon.heartbeat_at';
/** #13 写入的上一轮轮询耗时（毫秒，十进制字符串）。 */
export const META_DAEMON_LAST_POLL_MS = 'daemon.last_poll_ms';
/** #13 写入的各仓库开放 PR 数（JSON 对象 `{"owner/name": 数量}`）。 */
export const META_DAEMON_OPEN_PRS = 'daemon.open_prs';

/** 心跳过期阈值 = 3 × 轮询间隔。 */
export const HEARTBEAT_STALE_INTERVALS = 3;

/** 状态页双写的展示时区：北京时间（规则时区）与美东。 */
export const STATUS_DISPLAY_ZONES = { beijing: 'Asia/Shanghai', newYork: 'America/New_York' } as const;

/** 守护进程心跳信息（缺心跳时 present=false，其余字段为 null / false）。 */
export interface DaemonHeartbeat {
  present: boolean;
  /** 最后一次心跳（ISO）；无心跳或取值损坏为 null。 */
  lastAt: string | null;
  /** 距最后一次心跳的毫秒数。 */
  ageMs: number | null;
  /** 是否已过期（超过 3 个轮询间隔未更新）。 */
  stale: boolean;
  /** 过期判定阈值（毫秒）= 3 × pollIntervalSec。 */
  staleAfterMs: number;
  /** 上一轮轮询耗时（毫秒），#13 写入，缺省 null。 */
  lastPollMs: number | null;
  /** 各仓库开放 PR 数，#13 写入，缺省 null。 */
  openPrs: Record<string, number> | null;
}

/** 等待中的队列条目（queued / deferred / running，按可执行时间升序）。 */
export interface QueueEntry {
  id: number;
  repo: string;
  pr: number;
  headSha: string;
  /** 7 位短 sha。 */
  shortSha: string;
  status: JobStatus;
  reason: string | null;
  /** 最早可执行时刻（ISO）。 */
  notBefore: string;
  /** 距可执行还要等多久（毫秒；≤ 0 = 已可执行）。 */
  waitMs: number;
  attempts: number;
}

/** 一条已结束的审查记录。 */
export interface RecentReview {
  id: number;
  repo: string;
  pr: number;
  shortSha: string;
  /** 结果：done=成功、failed=失败、skipped=跳过。 */
  outcome: 'done' | 'failed' | 'skipped';
  /** 失败 / 跳过原因。 */
  reason: string | null;
  findingsCount: number | null;
  model: string | null;
  /** started_at → finished_at 的耗时（毫秒），缺起止时间为 null。 */
  durationMs: number | null;
  reviewUrl: string | null;
  /** 结束时刻（ISO），按它倒序取最近 N 条。 */
  finishedAt: string | null;
}

/** 一个时间窗内的 claude 用量汇总（token 为非空值之和）。 */
export interface UsageSummary {
  calls: number;
  okCalls: number;
  inputTokens: number;
  outputTokens: number;
}

export interface UsageWindows {
  /** 北京时间今天（自当日 00:00 起）。 */
  today: UsageSummary;
  /** 最近 7 天（滚动窗口）。 */
  last7d: UsageSummary;
}

/** 高峰状态 + 下一次切换（北京时间与美东双写）。 */
export interface PeakStatus {
  isPeak: boolean;
  nextSwitchAt: string;
  /** true = 切换后进入高峰，false = 切换后离开高峰。 */
  nextToPeak: boolean;
  msUntilSwitch: number;
  /** 下一次切换的北京时间墙上时间。 */
  nextSwitchBeijing: string;
  /** 下一次切换的美东时间墙上时间。 */
  nextSwitchNewYork: string;
}

/** 状态快照：collectStatus 的输出，纯数据、可 JSON 序列化。 */
export interface StatusSnapshot {
  generatedAt: string;
  /** 生成时刻的北京时间墙上时间。 */
  generatedAtBeijing: string;
  /** 生成时刻的美东墙上时间。 */
  generatedAtNewYork: string;
  heartbeat: DaemonHeartbeat;
  jobs: Record<JobStatus, number>;
  queue: QueueEntry[];
  recentReviews: RecentReview[];
  usage: UsageWindows;
  peak: PeakStatus;
  /** 额度暂停文件是否存在。 */
  paused: boolean;
  pauseFile: string;
}

export interface CollectOptions {
  /** 轮询间隔（秒），用于心跳过期阈值；默认 120（与全局配置默认值一致）。 */
  pollIntervalSec?: number;
  /** 额度暂停文件路径；默认 /workspace/GLM_PAUSE。 */
  pauseFile?: string;
  /** 队列最多多少条，默认 20。 */
  queueLimit?: number;
  /** 最近审查最多多少条，默认 20。 */
  reviewLimit?: number;
}

const MS_PER_DAY = 86_400_000;
/** 每个状态最多回看多少条任务（再合并排序），远超展示条数即可。 */
const LOOKBACK_PER_STATUS = 100;

/** 读 meta 表的一个键；meta 由 openState 的迁移保证存在。 */
function readMeta(db: StateDb, key: string): string | undefined {
  const row = db.sqlite.prepare('SELECT value FROM meta WHERE key = ?').get(key) as
    | { value: string }
    | undefined;
  return row?.value;
}

/** 解析心跳：任何一步取值损坏都当作缺失，不抛错。 */
function readHeartbeat(db: StateDb, now: Date, staleAfterMs: number): DaemonHeartbeat {
  const heartbeat: DaemonHeartbeat = {
    present: false,
    lastAt: null,
    ageMs: null,
    stale: false,
    staleAfterMs,
    lastPollMs: null,
    openPrs: null,
  };

  const rawAt = readMeta(db, META_DAEMON_HEARTBEAT_AT);
  if (rawAt !== undefined) {
    const ts = Date.parse(rawAt);
    if (!Number.isNaN(ts)) {
      heartbeat.present = true;
      heartbeat.lastAt = new Date(ts).toISOString();
      heartbeat.ageMs = Math.max(0, now.getTime() - ts);
      heartbeat.stale = heartbeat.ageMs > staleAfterMs;
    }
  }

  const rawPollMs = readMeta(db, META_DAEMON_LAST_POLL_MS);
  if (rawPollMs !== undefined) {
    const pollMs = Number(rawPollMs);
    if (Number.isFinite(pollMs) && pollMs >= 0) heartbeat.lastPollMs = Math.floor(pollMs);
  }

  const rawOpenPrs = readMeta(db, META_DAEMON_OPEN_PRS);
  if (rawOpenPrs !== undefined) {
    try {
      const parsed: unknown = JSON.parse(rawOpenPrs);
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const openPrs: Record<string, number> = {};
        for (const [repo, count] of Object.entries(parsed as Record<string, unknown>)) {
          if (typeof count === 'number' && Number.isFinite(count) && count >= 0) {
            openPrs[repo] = Math.floor(count);
          }
        }
        heartbeat.openPrs = openPrs;
      }
    } catch {
      // 损坏的 JSON 当作缺失。
    }
  }

  return heartbeat;
}

function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

/** 等待中的任务 → 队列条目（按 not_before 升序、再按 id）。 */
function collectQueue(db: StateDb, now: Date, limit: number): QueueEntry[] {
  const waiting: Job[] = [];
  for (const status of ['queued', 'deferred', 'running'] as const) {
    waiting.push(...listJobs(db, { status, limit: LOOKBACK_PER_STATUS }));
  }
  return waiting
    .sort((a, b) => (a.notBefore === b.notBefore ? a.id - b.id : a.notBefore < b.notBefore ? -1 : 1))
    .slice(0, limit)
    .map((job) => ({
      id: job.id,
      repo: job.repo,
      pr: job.pr,
      headSha: job.headSha,
      shortSha: shortSha(job.headSha),
      status: job.status,
      reason: job.reason,
      notBefore: job.notBefore,
      waitMs: Date.parse(job.notBefore) - now.getTime(),
      attempts: job.attempts,
    }));
}

/** 已结束的任务 → 最近审查（按 finished_at 倒序；缺 finished_at 的排最后）。 */
function collectRecentReviews(db: StateDb, limit: number): RecentReview[] {
  const finished: Job[] = [];
  for (const status of ['done', 'failed', 'skipped'] as const) {
    finished.push(...listJobs(db, { status, limit: LOOKBACK_PER_STATUS }));
  }
  return finished
    .sort((a, b) => {
      const at = a.finishedAt === null ? '' : a.finishedAt;
      const bt = b.finishedAt === null ? '' : b.finishedAt;
      if (at === bt) return b.id - a.id;
      return at < bt ? 1 : -1;
    })
    .slice(0, limit)
    .map((job) => ({
      id: job.id,
      repo: job.repo,
      pr: job.pr,
      shortSha: shortSha(job.headSha),
      outcome: job.status as RecentReview['outcome'],
      reason: job.reason,
      findingsCount: job.findingsCount,
      model: job.model,
      durationMs:
        job.startedAt !== null && job.finishedAt !== null
          ? Math.max(0, Date.parse(job.finishedAt) - Date.parse(job.startedAt))
          : null,
      reviewUrl: job.reviewUrl,
      finishedAt: job.finishedAt,
    }));
}

function summarizeCalls(db: StateDb, since: Date, until: Date): UsageSummary {
  const calls = listCalls(db, { since, until, limit: 100_000 });
  const summary: UsageSummary = { calls: 0, okCalls: 0, inputTokens: 0, outputTokens: 0 };
  for (const call of calls) {
    summary.calls += 1;
    if (call.ok) summary.okCalls += 1;
    summary.inputTokens += call.inputTokens ?? 0;
    summary.outputTokens += call.outputTokens ?? 0;
  }
  return summary;
}

/* ---- 时区换算（与 peak.ts 同一套墙上时间算法，这里只做展示用） ---- */

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function offsetFormatter(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatterCache.get(timeZone);
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatterCache.set(timeZone, formatter);
  }
  return formatter;
}

/** 某时刻在指定时区的偏移毫秒数（墙上时间 = 时刻 + 偏移，再按 UTC 读）。 */
function zoneOffsetMs(ts: number, timeZone: string): number {
  const byType: Record<string, string> = {};
  for (const part of offsetFormatter(timeZone).formatToParts(new Date(ts))) {
    byType[part.type] = part.value;
  }
  const asUtc = Date.UTC(
    Number(byType.year),
    Number(byType.month) - 1,
    Number(byType.day),
    Number(byType.hour),
    Number(byType.minute),
    Number(byType.second),
  );
  return asUtc - Math.floor(ts / 1000) * 1000;
}

/** 某时刻在指定时区所处日历日的 00:00（墙上时间）对应的绝对时刻。 */
export function startOfDayInZone(date: Date, timeZone: string): Date {
  const shifted = new Date(date.getTime() + zoneOffsetMs(date.getTime(), timeZone));
  const wallMidnightAsUtc = Date.UTC(
    shifted.getUTCFullYear(),
    shifted.getUTCMonth(),
    shifted.getUTCDate(),
  );
  let ts = wallMidnightAsUtc - zoneOffsetMs(wallMidnightAsUtc, timeZone);
  for (let round = 0; round < 4; round++) {
    const next = wallMidnightAsUtc - zoneOffsetMs(ts, timeZone);
    if (next === ts) break;
    ts = next;
  }
  return new Date(ts);
}

/** 墙上时间文案，如「10月13日 周二 14:00」（供各渲染端共用，注意 HTML 需转义）。 */
export function formatWallTime(date: Date, timeZone: string): string {
  const byType: Record<string, string> = {};
  for (const part of new Intl.DateTimeFormat('zh-CN', {
    timeZone,
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date)) {
    byType[part.type] = part.value;
  }
  return `${byType.month}月${byType.day}日 ${byType.weekday} ${byType.hour}:${byType.minute}`;
}

/**
 * 采集状态快照。`now` 由调用方注入（命令层取 clock，网页每个请求取一次）。
 * 读操作失败不在这里兜底：库损坏属于应当暴露的错误。
 */
export function collectStatus(db: StateDb, now: Date, options: CollectOptions = {}): StatusSnapshot {
  const pollIntervalSec = options.pollIntervalSec ?? 120;
  const staleAfterMs = HEARTBEAT_STALE_INTERVALS * pollIntervalSec * 1000;
  const nowMs = now.getTime();

  const switchInfo = nextSwitch(now);
  const peak: PeakStatus = {
    isPeak: isPeak(now),
    nextSwitchAt: switchInfo.at.toISOString(),
    nextToPeak: switchInfo.toPeak,
    msUntilSwitch: switchInfo.at.getTime() - nowMs,
    nextSwitchBeijing: formatWallTime(switchInfo.at, STATUS_DISPLAY_ZONES.beijing),
    nextSwitchNewYork: formatWallTime(switchInfo.at, STATUS_DISPLAY_ZONES.newYork),
  };

  return {
    generatedAt: now.toISOString(),
    generatedAtBeijing: formatWallTime(now, STATUS_DISPLAY_ZONES.beijing),
    generatedAtNewYork: formatWallTime(now, STATUS_DISPLAY_ZONES.newYork),
    heartbeat: readHeartbeat(db, now, staleAfterMs),
    jobs: stats(db),
    queue: collectQueue(db, now, options.queueLimit ?? 20),
    recentReviews: collectRecentReviews(db, options.reviewLimit ?? 20),
    usage: {
      today: summarizeCalls(db, startOfDayInZone(now, STATUS_DISPLAY_ZONES.beijing), now),
      last7d: summarizeCalls(db, new Date(nowMs - 7 * MS_PER_DAY), now),
    },
    peak,
    paused: existsSync(options.pauseFile ?? '/workspace/GLM_PAUSE'),
    pauseFile: options.pauseFile ?? '/workspace/GLM_PAUSE',
  };
}
