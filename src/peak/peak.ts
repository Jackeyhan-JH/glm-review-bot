/**
 * 高峰期核心逻辑：纯函数、只依赖 PEAK_RULES，语义与 glm-peak-clock 的
 * src/peak.js（commit 6b2b937）逐条对应：
 *
 * - `isPeak`      ≙ isPeak      是否处于高峰（区间左闭右开）；
 * - `currentWindow`              正处于高峰时返回本段区间；
 * - `nextSwitch`  ≙ getStatus    下一次高峰/非高峰翻转（含 `toPeak` 方向）；
 * - `deferUntil`                高峰中返回本段结束时刻（排队到峰后），否则 null；
 * - `canStartWork`              预计耗时若会跨进高峰则推迟（避免长任务跑进高峰）；
 * - `peakWindows` ≙ peakWindows  列出与时间段重叠的所有高峰区间。
 *
 * 一律在 PEAK_RULES.timeZone（北京时间）下计算，不受本机 TZ 影响：
 * 所有 Intl.DateTimeFormat 都显式传 timeZone，换算用的是墙上时间而非本地时间。
 */
import { PEAK_RULES } from './rules.ts';

const MS_PER_MINUTE = 60_000;

/**
 * 「下一次切换」的默认展示时区：美东（Jackey 的本地时区），与 glm-peak-clock
 * CLI 的用户习惯一致。只影响展示，不影响高峰计算（计算恒用北京时间）。
 */
export const PEAK_DEFAULT_DISPLAY_TZ = 'America/New_York';

/** 一段高峰区间，左闭右开 [start, end)。 */
export interface PeakWindow {
  start: Date;
  end: Date;
}

/** 一次状态翻转：at 时刻起进入（toPeak=true）或离开（toPeak=false）高峰。 */
export interface PeakSwitch {
  at: Date;
  toPeak: boolean;
}

/** canStartWork 的结论：ok=false 时 waitUntil 是需要等到的高峰结束时刻。 */
export interface WorkDecision {
  ok: boolean;
  waitUntil?: Date;
}

/** 规则日历日的墙上时间各部分；month 与 weekday 取值同 Date 的 UTC 系列（0 起）。 */
interface WallParts {
  year: number;
  month: number;
  day: number;
  weekday: number;
  msOfDay: number;
}

/** Intl.DateTimeFormat 构造较贵，按时区缓存偏移换算用的 formatter。 */
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

/** 某时刻在指定时区的偏移毫秒数：把该时刻按目标时区拆成 Y/M/D H:M:S 再当作 UTC 求差。 */
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
  // 对齐到秒再作差，消掉 ts 的毫秒部分；现实中的时区偏移都是整分钟。
  return asUtc - Math.floor(ts / 1000) * 1000;
}

/** 把时刻拆成「规则时区日历日 + 当天已过的毫秒数 + 墙上星期」。 */
function wallParts(ts: number): WallParts {
  // 加上偏移后按 UTC 读，即得到墙上时间（含毫秒——偏移是整分钟，毫秒原样保留）。
  const shifted = new Date(ts + zoneOffsetMs(ts, PEAK_RULES.timeZone));
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth(),
    day: shifted.getUTCDate(),
    weekday: shifted.getUTCDay(),
    msOfDay:
      (shifted.getUTCHours() * 60 + shifted.getUTCMinutes()) * MS_PER_MINUTE +
      shifted.getUTCSeconds() * 1000 +
      shifted.getUTCMilliseconds(),
  };
}

/** 规则时区某墙上年月日的 00:00 对应的绝对时间戳（毫秒）。 */
function wallDayStart(year: number, month: number, day: number): number {
  // 墙上日期当作 UTC 得到初猜，再迭代校正到不动点；Asia/Shanghai 固定 UTC+8，
  // 一轮即收敛，写循环只是让算法对有夏令时的时区也成立（同 glm-peak-clock）。
  const asUtc = Date.UTC(year, month, day);
  let ts = asUtc - zoneOffsetMs(asUtc, PEAK_RULES.timeZone);
  for (let round = 0; round < 4; round++) {
    const next = asUtc - zoneOffsetMs(ts, PEAK_RULES.timeZone);
    if (next === ts) break;
    ts = next;
  }
  return ts;
}

/** 规则时区某个高峰日的高峰区间，返回绝对时间戳（毫秒）。 */
function windowOfWallDay(year: number, month: number, day: number): { startTs: number; endTs: number } {
  const dayStart = wallDayStart(year, month, day);
  return {
    startTs: dayStart + PEAK_RULES.peakStartMinutes * MS_PER_MINUTE,
    endTs: dayStart + PEAK_RULES.peakEndMinutes * MS_PER_MINUTE,
  };
}

function isPeakWeekday(weekday: number): boolean {
  return PEAK_RULES.peakDays.includes(weekday);
}

/**
 * 判断某时刻是否处于高峰期。区间左闭右开：14:00:00 算高峰，18:00:00 不算。
 */
export function isPeak(date: Date): boolean {
  const { weekday, msOfDay } = wallParts(date.getTime());
  return (
    isPeakWeekday(weekday) &&
    msOfDay >= PEAK_RULES.peakStartMinutes * MS_PER_MINUTE &&
    msOfDay < PEAK_RULES.peakEndMinutes * MS_PER_MINUTE
  );
}

/**
 * 正处于高峰时返回本段区间，否则 null。用于「deferUntil = 本段结束」与状态展示。
 * 周末与工作日高峰时段之外都返回 null。
 */
export function currentWindow(date: Date): PeakWindow | null {
  const ts = date.getTime();
  const { year, month, day, weekday } = wallParts(ts);
  if (!isPeakWeekday(weekday)) return null;
  const window = windowOfWallDay(year, month, day);
  return ts >= window.startTs && ts < window.endTs
    ? { start: new Date(window.startTs), end: new Date(window.endTs) }
    : null;
}

/**
 * 下一次状态翻转：高峰中 → 本段结束（toPeak=false）；非高峰 → 下一个高峰开始
 * （toPeak=true），周五 18:00 之后直接跳到下周一 14:00。
 */
export function nextSwitch(date: Date): PeakSwitch {
  const ts = date.getTime();
  const { year, month, day, weekday, msOfDay } = wallParts(ts);
  const today = windowOfWallDay(year, month, day);
  const startMs = PEAK_RULES.peakStartMinutes * MS_PER_MINUTE;
  const endMs = PEAK_RULES.peakEndMinutes * MS_PER_MINUTE;

  let atTs: number;
  if (isPeakWeekday(weekday) && msOfDay < endMs) {
    // 工作日 18:00 前：还没到 14:00 → 今天开始；已在高峰 → 本段结束。
    atTs = msOfDay >= startMs ? today.endTs : today.startTs;
  } else {
    // 工作日 18:00 后或周末：找下一个高峰日的 14:00（最多隔 3 天）。
    atTs = nextPeakDayStartTs(year, month, day);
  }
  return { at: new Date(atTs), toPeak: !isPeak(date) };
}

/** 从规则时区的某个墙上年月日（不含）起，往后第一个高峰日的 14:00 时间戳。 */
function nextPeakDayStartTs(year: number, month: number, day: number): number {
  for (let offset = 1; offset <= 8; offset++) {
    const d = new Date(Date.UTC(year, month, day + offset));
    if (isPeakWeekday(d.getUTCDay())) {
      return windowOfWallDay(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()).startTs;
    }
  }
  // peakDays 非空时 7 天内必有高峰日，到不了这里。
  throw new Error('PEAK_RULES.peakDays 为空，不存在下一个高峰');
}

/**
 * 排队到峰后：高峰中返回本段结束时刻，非高峰返回 null（无需推迟）。
 */
export function deferUntil(date: Date): Date | null {
  const window = currentWindow(date);
  return window === null ? null : window.end;
}

/**
 * 现在能否启动一段预计耗时 estMinutes 分钟的工作（如一次审查）：
 * 工作窗口 [date, date+estMinutes] 与任一高峰区间有重叠就推迟，
 * waitUntil = 第一段重叠高峰的结束时刻。两个边界：
 * - 恰好在 14:00:00.000 收尾（不晚于）的任务不算跨进高峰，可以启动；
 * - 18:00:00 整点出发的任务不落在高峰里（区间左闭右开），可以启动。
 * estMinutes 按审查任务的分钟级粒度设计；远超一天的预计耗时只保证避开第一段高峰。
 */
export function canStartWork(date: Date, estMinutes: number): WorkDecision {
  const fromTs = date.getTime();
  const toTs = fromTs + Math.max(0, Math.floor(estMinutes)) * MS_PER_MINUTE;

  // 与 peakWindows 同样的逐日扫描，但重叠条件用「两端都严格」，
  // 使恰好在高峰开始时刻结束的任务不被误伤。
  const from = wallParts(fromTs);
  for (let offset = 0; ; offset++) {
    const d = new Date(Date.UTC(from.year, from.month, from.day + offset));
    const window = windowOfWallDay(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
    if (window.startTs >= toTs) break; // 后续窗口只会更晚
    if (isPeakWeekday(d.getUTCDay()) && window.endTs > fromTs && window.startTs < toTs) {
      return { ok: false, waitUntil: new Date(window.endTs) };
    }
  }
  return { ok: true };
}

/**
 * 列出与 [from, to) 有重叠的所有高峰区间，不裁剪，按开始时间升序。
 * 范围内没有高峰时为空数组。
 */
export function peakWindows(from: Date, to: Date): PeakWindow[] {
  const fromTs = from.getTime();
  const toTs = to.getTime();
  const windows: PeakWindow[] = [];
  if (!(fromTs < toTs)) return windows;

  // 最早可能重叠的窗口在 from 所在的规则时区日（窗口起点 14:00 总在当天之内或之后）。
  const fromParts = wallParts(fromTs);
  for (let offset = 0; ; offset++) {
    const d = new Date(Date.UTC(fromParts.year, fromParts.month, fromParts.day + offset));
    const window = windowOfWallDay(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
    if (window.startTs >= toTs) break;
    if (isPeakWeekday(d.getUTCDay()) && window.endTs > fromTs) {
      windows.push({ start: new Date(window.startTs), end: new Date(window.endTs) });
    }
  }
  return windows;
}
