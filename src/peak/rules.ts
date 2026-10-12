/**
 * GLM 高峰期规则——本项目唯一的事实来源，所有高峰判断的数值都从这里取（见 #1 运行规则 1）。
 *
 * 与 [glm-peak-clock](https://github.com/Jackeyhan-JH/glm-peak-clock) 完全一致：
 * 来源 commit 6b2b937d786339a626e6cc3967369ba8db7459b0（2026-10-08，v0.1.0，
 * `src/peak.js` 的 `RULES`）。高峰 = 北京时间周一至周五 14:00–18:00（左闭右开），
 * 周末全天非高峰。
 *
 * 该实现用固定偏移 `tzOffsetMinutes: 480` 换算；本项目改按 IANA 名 `Asia/Shanghai`
 * 用 Intl 取墙上时间——该时区自 1991 年起固定 UTC+8、无夏令时，两种算法在 1991 年
 * 之后任意时刻结果相同（test/peak 里有与固定偏移算法逐点对照的测试）。
 */

/** 高峰规则集合。分钟数按 `timeZone` 的日历日内计算。 */
export interface PeakRules {
  /** 计算所用 IANA 时区名（Asia/Shanghai，固定 UTC+8）。 */
  timeZone: string;
  /** 高峰的星期几，取值同 `Date#getDay`（周日为 0），升序。 */
  peakDays: number[];
  /** 高峰开始（当日分钟数，含），14:00 = 840。 */
  peakStartMinutes: number;
  /** 高峰结束（当日分钟数，不含），18:00 = 1080。 */
  peakEndMinutes: number;
}

export const PEAK_RULES: PeakRules = {
  timeZone: 'Asia/Shanghai',
  peakDays: [1, 2, 3, 4, 5],
  peakStartMinutes: 840, // 14:00
  peakEndMinutes: 1080, // 18:00
};
