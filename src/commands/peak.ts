/**
 * `glm-review peak`：查看现在是不是 GLM 高峰期、下一次切换何时发生。
 *
 * glm-review peak [--now <ISO>] [--tz <IANA>] [--json]
 *
 * - `--now` 指定「现在」（默认取 ctx.deps.clock 当前时间）；
 * - `--tz` 「下一次切换」的展示时区（IANA 名，默认 America/New_York）；
 * - `--json` 只输出一行 {"peak":…,"nextSwitch":…,"msUntilSwitch":…}，
 *   与 glm-peak-clock 的 CLI 输出完全一致（便于脚本比对）。
 */
import { ArgError, parseArgs } from '../lib/args.ts';
import type { Command } from '../lib/types.ts';
import { isPeak, nextSwitch, PEAK_DEFAULT_DISPLAY_TZ } from '../peak/peak.ts';

const USAGE = `用法：glm-review peak [--now <ISO>] [--tz <IANA>] [--json]`;

/** 毫秒 → 整分钟粒度的中文时长："3 小时 12 分" / "5 分" / "不到 1 分"。 */
function formatDurationMinutes(ms: number): string {
  const totalMinutes = Math.floor(Math.max(0, ms) / 60_000);
  if (totalMinutes === 0) return '不到 1 分';
  const days = Math.floor(totalMinutes / 1_440);
  const hours = Math.floor((totalMinutes % 1_440) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return `${days} 天 ${hours} 小时 ${minutes} 分`;
  if (hours > 0) return `${hours} 小时 ${minutes} 分`;
  return `${minutes} 分`;
}

/** 某时刻在指定时区的墙上时间片段（字符串，可直接拼展示文案）。 */
function zonedParts(date: Date, timeZone: string): Record<string, string> {
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
  return byType;
}

/**
 * 「下一次切换」文案：所选时区时间（带时区名）+ 北京时间；
 * 与所选时区同一天时北京时间省略日期前缀。
 */
function formatNextSwitch(date: Date, timeZone: string): string {
  const local = zonedParts(date, timeZone);
  const beijing = zonedParts(date, 'Asia/Shanghai');
  const sameCalendarDate =
    beijing.year === local.year && beijing.month === local.month && beijing.day === local.day;
  const datePrefix = sameCalendarDate ? '' : `${beijing.month}月${beijing.day}日 `;
  return (
    `${local.month}月${local.day}日 ${local.weekday} ${local.hour}:${local.minute}（${timeZone}）` +
    `，北京时间 ${datePrefix}${beijing.weekday} ${beijing.hour}:${beijing.minute}`
  );
}

/** IANA 时区名是否合法（非空且 Intl 认识）。 */
export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
}

export const command: Command = {
  name: 'peak',
  summary: '查看现在是不是 GLM 高峰期、下一次切换何时发生',
  usage: USAGE,
  async run(argv, ctx): Promise<number> {
    let parsed: ReturnType<typeof parseArgs>;
    try {
      parsed = parseArgs(argv, { strings: ['now', 'tz'], booleans: ['json'] });
    } catch (err) {
      if (err instanceof ArgError) {
        ctx.stderr(`错误：${err.message}\n${USAGE}\n`);
        return 2;
      }
      throw err;
    }
    const nowRaw = typeof parsed.values.now === 'string' ? parsed.values.now : undefined;
    const tzRaw = typeof parsed.values.tz === 'string' ? parsed.values.tz : undefined;

    if (nowRaw !== undefined && Number.isNaN(new Date(nowRaw).getTime())) {
      ctx.stderr(`错误：无效的 --now 取值（要 ISO 8601 时刻）：${nowRaw}\n${USAGE}\n`);
      return 2;
    }
    if (tzRaw !== undefined && !isValidTimeZone(tzRaw)) {
      ctx.stderr(`错误：无效的 --tz 取值（要 IANA 时区名）：${tzRaw}\n${USAGE}\n`);
      return 2;
    }
    if (parsed.positionals.length > 0) {
      ctx.stderr(`错误：多余的参数：${parsed.positionals[0]}\n${USAGE}\n`);
      return 2;
    }

    // 当前时间只从注入的时钟取（默认 --tz 与 glm-peak-clock CLI 约定一致取美东）。
    const now = nowRaw !== undefined ? new Date(nowRaw) : ctx.deps.clock.now();
    const timeZone = tzRaw ?? PEAK_DEFAULT_DISPLAY_TZ;

    const peak = isPeak(now);
    const switchInfo = nextSwitch(now);
    const msUntilSwitch = switchInfo.at.getTime() - now.getTime();

    if (parsed.values.json) {
      ctx.stdout(
        `${JSON.stringify({
          peak,
          nextSwitch: switchInfo.at.toISOString(),
          msUntilSwitch,
        })}\n`,
      );
      return 0;
    }

    ctx.stdout(
      [
        `现在：${peak ? '高峰期' : '非高峰期'}`,
        `下一次切换：${formatNextSwitch(switchInfo.at, timeZone)}`,
        `距离切换：${formatDurationMinutes(msUntilSwitch)}`,
        '',
      ].join('\n'),
    );
    return 0;
  },
};
