/**
 * 用量命令的时间参数解析（#15）：`--since` 支持 `7d` / `24h` / `30m` 这类
 * 相对时长（整数 + 单位，不区分大小写）与 ISO 8601 时刻；`--until` 只接受
 * ISO 时刻。相对时长以传入的 now 为基准（命令层取注入 Clock），测试不依赖
 * 真实时间。非法取值抛 TimeArgError，由命令层转成中文报错与退出码 2。
 */

/** 时间参数解析失败（中文消息，命令层据此以退出码 2 退出）。 */
export class TimeArgError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TimeArgError';
  }
}

const RELATIVE = /^(\d+)([dhm])$/i;
const MS_PER_UNIT: Record<string, number> = {
  d: 24 * 3_600_000,
  h: 3_600_000,
  m: 60_000,
};

/**
 * ISO 8601 形状：日期必填，时间 / 秒 / 毫秒 / 时区可选（Z 或 ±hh:mm）。
 * V8 的 Date 解析很宽（裸数字也会被当成年份），先卡形状再用 Date 校验语义，
 * 保证「7」这类取值按非法处理而不是默默变成 2001 年。
 */
const ISO_SHAPE =
  /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})?)?$/;

const ZONE_SUFFIX = /(Z|[+-]\d{2}:\d{2})$/;

const ISO_HINT = '要 ISO 8601 时刻（如 2026-10-12T00:00:00Z）';

/**
 * 解析 ISO 8601 时刻；形状不符或语义非法（如 2026-13-01）抛 TimeArgError。
 * 带时间但没写时区的取值按 UTC 解释（补 Z），避免结果随机器时区漂移。
 */
export function parseIsoArg(value: string): Date {
  const trimmed = value.trim();
  if (trimmed === '' || !ISO_SHAPE.test(trimmed)) {
    throw new TimeArgError(`无效的时间取值：${value}（${ISO_HINT}）`);
  }
  const hasTime = /[T ]/.test(trimmed);
  const normalized = hasTime && !ZONE_SUFFIX.test(trimmed) ? `${trimmed}Z` : trimmed;
  const ts = new Date(normalized).getTime();
  if (Number.isNaN(ts)) {
    throw new TimeArgError(`无效的时间取值：${value}（${ISO_HINT}）`);
  }
  return new Date(ts);
}

/**
 * 解析 `--since` 取值：`<整数><d|h|m>`（如 7d / 24h / 30m，表示 now 往前
 * 这么久）或 ISO 8601 时刻。数值超出可表示范围同样视为非法。
 */
export function parseSinceArg(value: string, now: Date): Date {
  const relative = RELATIVE.exec(value.trim());
  if (relative !== null) {
    const count = Number(relative[1]);
    const ts = now.getTime() - count * MS_PER_UNIT[relative[2].toLowerCase()];
    if (!Number.isSafeInteger(ts) || Number.isNaN(new Date(ts).getTime())) {
      throw new TimeArgError(`相对时长超出可表示范围：${value}`);
    }
    return new Date(ts);
  }
  try {
    return parseIsoArg(value);
  } catch {
    throw new TimeArgError(
      `无效的 --since 取值：${value}（要 7d / 24h / 30m 这类相对时长，或 ISO 8601 时刻如 2026-10-12T00:00:00Z）`,
    );
  }
}
