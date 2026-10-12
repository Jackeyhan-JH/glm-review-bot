/**
 * 模型选择（#1 运行规则 6）：按过滤后的改动行数选模型——
 * ≤ smallDiffLines（默认 300）用小模型（默认 glm-5.3-flash），否则用大模型（默认 glm-5.3）。
 * 具体取值来自全局配置（#3 负责加载与校验），这里只做纯函数判断。
 */

/** 全局配置的 models 段：三项都可省略，省略时用默认值。 */
export interface ModelsConfig {
  /** 小改动用的模型，默认 glm-5.3-flash。 */
  small?: string;
  /** 大改动用的模型，默认 glm-5.3。 */
  large?: string;
  /** 小模型阈值（过滤后的改动行数），默认 300。 */
  smallDiffLines?: number;
}

export const DEFAULT_SMALL_MODEL = 'glm-5.3-flash';
export const DEFAULT_LARGE_MODEL = 'glm-5.3';
export const DEFAULT_SMALL_DIFF_LINES = 300;

/**
 * 按改动行数选择模型：changedLines ≤ smallDiffLines → small，否则 large。
 * 边界归属「小于等于」：恰好 300 行仍算小改动。
 */
export function pickModel(changedLines: number, models: ModelsConfig = {}): string {
  const threshold = models.smallDiffLines ?? DEFAULT_SMALL_DIFF_LINES;
  const small = models.small ?? DEFAULT_SMALL_MODEL;
  const large = models.large ?? DEFAULT_LARGE_MODEL;
  return changedLines <= threshold ? small : large;
}
