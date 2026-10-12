/**
 * 用量报表核心（#15）：把调用账本（#5 的 calls 记录）汇总成按天 / 仓库 / 模型
 * 分组的用量统计，并给出「近 5 小时」「近 7 天」两个滚动窗口汇总，便于对照
 * GLM 套餐的 5 小时 / 每周额度。
 *
 * 纯函数：不读库、不取当前时间——calls 与 now 都由调用方传入（命令层从
 * state.listCalls 与注入 Clock 取，测试直接构造）。
 *
 * 约定：
 * - 折合 prompt 数 = Σ 每次调用的套餐倍率；是否高峰按调用开始时刻用 isPeak
 *   计算（#4），V2 套餐先按调用模型选对应套餐行（plans.ts）；
 * - 「高峰调用」计数取账本记账时写入的 peak 标记（#5）——它理应为 0，
 *   非 0 说明高峰闸门有漏洞，报表以 warnings 标红提示；
 * - 主表 since/until 过滤为闭区间 [since, until]（与 listCalls 的 >= / <= 一致）；
 * - 滚动窗口为左闭右开 [now-窗口, now)：恰好窗口时长之前的调用计入，
 *   恰好在 now 时刻的不计入（与 #1 高峰区间 14:00–18:00 的左闭右开一致）；
 * - 「按天」的日期边界按北京时间（PEAK_RULES.timeZone）计算，不受本机时区影响；
 * - 滚动窗口不受 since/until 影响：它们始终以完整 calls 列表为输入。
 */
import { isPeak } from '../peak/peak.ts';
import { PEAK_RULES } from '../peak/rules.ts';
import type { CallRecord } from '../state/calls.ts';
import { callMultiplier, DEFAULT_PLAN, type Plan } from './plans.ts';

/** 分组维度。 */
export type UsageGroupBy = 'day' | 'repo' | 'model';

/** 一组（或全部 / 一个窗口内）调用的用量统计。 */
export interface UsageStats {
  /** 调用总次数。 */
  calls: number;
  okCalls: number;
  failedCalls: number;
  /** 成功率 0～1（保留 4 位小数），无调用时为 0。 */
  successRate: number;
  /** 平均耗时毫秒（四舍五入取整），无调用时为 0。 */
  avgDurationMs: number;
  /** 总耗时毫秒。 */
  totalDurationMs: number;
  inputTokens: number;
  outputTokens: number;
  /** 报告的 cost_usd 合计（美元，保留 6 位小数；缺失按 0 计）。 */
  costUsd: number;
  /** 折合 prompt 数（按所选套餐逐次累计，保留 4 位小数）。 */
  prompts: number;
  /** 账本标记为高峰期的调用次数，理应为 0。 */
  peakCalls: number;
}

/** 一个分组：分组键 + 统计。键按 day 是北京时间日期、repo/model 是原文。 */
export interface UsageGroup extends UsageStats {
  key: string;
}

/** 一个滚动窗口的汇总：[from, to) 左闭右开。 */
export interface UsageWindow extends UsageStats {
  from: string;
  to: string;
}

export interface UsageReportOptions {
  /** 报表「当前时刻」，滚动窗口以此为新端点；由调用方从注入 Clock 取。 */
  now: Date;
  /** 主表过滤：只统计 started_at >= since 的调用（含）。 */
  since?: Date;
  /** 主表过滤：只统计 started_at <= until 的调用（含）。 */
  until?: Date;
  /** 分组维度，默认 day。 */
  groupBy?: UsageGroupBy;
  /** 计价套餐，默认 new。 */
  plan?: Plan;
}

export interface UsageReport {
  /** 报表生成时刻（= options.now）。 */
  generatedAt: string;
  /** 生效的主表范围（ISO），未限制时为 null。 */
  since: string | null;
  until: string | null;
  groupBy: UsageGroupBy;
  planId: string;
  planName: string;
  /** 分组明细，按键升序。 */
  groups: UsageGroup[];
  /** 主表范围内全部调用的合计。 */
  totals: UsageStats;
  /** 近 5 小时滚动窗口 [now-5h, now)。 */
  window5h: UsageWindow;
  /** 近 7 天滚动窗口 [now-7d, now)。 */
  window7d: UsageWindow;
  /** 中文警告（如高峰期调用非 0），空数组表示无异常。 */
  warnings: string[];
}

/** 5 小时窗口时长（毫秒）。 */
export const WINDOW_5H_MS = 5 * 3_600_000;
/** 7 天窗口时长（毫秒）。 */
export const WINDOW_7D_MS = 7 * 24 * 3_600_000;

/** 分组键的显示名（表头用）。 */
export const GROUP_LABEL: Record<UsageGroupBy, string> = {
  day: '日期',
  repo: '仓库',
  model: '模型',
};

/** 「按天」分组的日期键按北京墙上时间取 YYYY-MM-DD（en-CA 即该格式）。 */
const dayKeyFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: PEAK_RULES.timeZone,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

function emptyStats(): UsageStats {
  return {
    calls: 0,
    okCalls: 0,
    failedCalls: 0,
    successRate: 0,
    avgDurationMs: 0,
    totalDurationMs: 0,
    inputTokens: 0,
    outputTokens: 0,
    costUsd: 0,
    prompts: 0,
    peakCalls: 0,
  };
}

function roundTo(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

/** 累加一条调用（prompts 按调用时刻是否高峰乘以套餐倍率）。 */
function accumulate(stats: UsageStats, call: CallRecord, plan: Plan): void {
  stats.calls += 1;
  if (call.ok) stats.okCalls += 1;
  else stats.failedCalls += 1;
  stats.totalDurationMs += call.durationMs;
  stats.inputTokens += call.inputTokens ?? 0;
  stats.outputTokens += call.outputTokens ?? 0;
  stats.costUsd += call.costUsd ?? 0;
  if (call.peak) stats.peakCalls += 1;
  const startedAt = new Date(call.startedAt);
  stats.prompts += callMultiplier(plan, call.model, isPeak(startedAt));
}

/** 结束累计：补上比率 / 均值，并把浮点和钳到固定小数位。 */
function finalizeStats(stats: UsageStats): UsageStats {
  stats.successRate = stats.calls === 0 ? 0 : roundTo(stats.okCalls / stats.calls, 4);
  stats.avgDurationMs =
    stats.calls === 0 ? 0 : Math.round(stats.totalDurationMs / stats.calls);
  stats.costUsd = roundTo(stats.costUsd, 6);
  stats.prompts = roundTo(stats.prompts, 4);
  return stats;
}

function groupKey(call: CallRecord, groupBy: UsageGroupBy): string {
  if (groupBy === 'repo') return call.repo ?? '（未知仓库）';
  if (groupBy === 'model') return call.model;
  return dayKeyFormatter.format(new Date(call.startedAt));
}

/** 汇总落在 [from, to) 内的调用（左闭右开）。 */
function summarizeWindow(
  calls: readonly CallRecord[],
  fromTs: number,
  toTs: number,
  plan: Plan,
): UsageStats {
  const stats = emptyStats();
  for (const call of calls) {
    const ts = new Date(call.startedAt).getTime();
    if (Number.isNaN(ts)) continue;
    if (ts >= fromTs && ts < toTs) accumulate(stats, call, plan);
  }
  return finalizeStats(stats);
}

/**
 * 构建用量报表：主表按 since/until（闭区间）过滤后分组统计；两个滚动窗口
 * 独立于 since/until，始终统计完整列表里 [now-窗口, now) 的调用。
 */
export function buildUsageReport(
  calls: readonly CallRecord[],
  options: UsageReportOptions,
): UsageReport {
  const groupBy = options.groupBy ?? 'day';
  const plan = options.plan ?? DEFAULT_PLAN;
  const nowTs = options.now.getTime();
  const sinceTs = options.since === undefined ? undefined : options.since.getTime();
  const untilTs = options.until === undefined ? undefined : options.until.getTime();

  const buckets = new Map<string, UsageStats>();
  const totals = emptyStats();
  for (const call of calls) {
    const ts = new Date(call.startedAt).getTime();
    if (Number.isNaN(ts)) continue; // 脏数据不参与统计
    if (sinceTs !== undefined && ts < sinceTs) continue;
    if (untilTs !== undefined && ts > untilTs) continue;
    const key = groupKey(call, groupBy);
    let bucket = buckets.get(key);
    if (bucket === undefined) {
      bucket = emptyStats();
      buckets.set(key, bucket);
    }
    accumulate(bucket, call, plan);
    accumulate(totals, call, plan);
  }

  const groups: UsageGroup[] = [...buckets.entries()]
    .map(([key, stats]) => ({ key, ...finalizeStats(stats) }))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));

  const warnings: string[] = [];
  if (totals.peakCalls > 0) {
    warnings.push(
      `高峰期调用 ${totals.peakCalls} 次（理应为 0），高峰闸门可能存在漏洞`,
    );
  }

  const window5hStats = summarizeWindow(calls, nowTs - WINDOW_5H_MS, nowTs, plan);
  const window7dStats = summarizeWindow(calls, nowTs - WINDOW_7D_MS, nowTs, plan);

  return {
    generatedAt: options.now.toISOString(),
    since: options.since === undefined ? null : options.since.toISOString(),
    until: options.until === undefined ? null : options.until.toISOString(),
    groupBy,
    planId: plan.id,
    planName: plan.name,
    groups,
    totals: finalizeStats(totals),
    window5h: {
      from: new Date(nowTs - WINDOW_5H_MS).toISOString(),
      to: options.now.toISOString(),
      ...window5hStats,
    },
    window7d: {
      from: new Date(nowTs - WINDOW_7D_MS).toISOString(),
      to: options.now.toISOString(),
      ...window7dStats,
    },
    warnings,
  };
}
