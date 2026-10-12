/**
 * findings 模块的共享类型与常量（#9）。严重度的权威定义在 src/lib/types.ts
 * （blocker > major > minor > nit），这里只放本模块需要的枚举值与归一化结果类型。
 */
import type { Finding, Severity } from '../lib/types.ts';

/** 严重度规范值枚举（模型输出的别名归一化见 validate.ts）。 */
export const SEVERITY_ENUM: readonly Severity[] = ['blocker', 'major', 'minor', 'nit'];

export type { Finding, Severity };

/** 归一化后的发现：能挂到 diff 行上的（inline=true）发行内评论，否则并入总评。 */
export interface NormalizedFinding extends Finding {
  inline: boolean;
}

/** 被丢弃的模型输出与原因（原因用于日志与排查）。 */
export interface DroppedFinding {
  reason: string;
  raw: unknown;
}
