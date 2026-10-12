/**
 * 套餐倍率表（#15）：折合 prompt 数的计价依据。
 *
 * `PLANS` 照抄 [glm-peak-clock](https://github.com/Jackeyhan-JH/glm-peak-clock)
 * `src/plans.js` 的同名导出（来源 commit e84e2a25db6d8f52320f9c3786c9e22f1306e6a4，
 * 2026-10-07，main 分支）：`new` 非高峰 0.5 / 高峰 1；`v2-glm-5.3` 1 / 3；
 * `v2-glm-5.3-flash` 0.4 / 1.2。倍率数字只在本文件出现一处，页面与命令行
 * 均从此处取值（test/usage/plans.test.ts 逐项断言与上游一致）。
 */

/** 一个套餐（一条倍率行）：offPeak / peak 分别是非高峰与高峰的折算倍率。 */
export interface Plan {
  /** 套餐 id，同时是 `--plan` 的取值，不可改动。 */
  id: string;
  /** 中文显示名。 */
  name: string;
  /** 非高峰倍率。 */
  offPeak: number;
  /** 高峰倍率。 */
  peak: number;
}

const PLAN_NEW: Plan = Object.freeze({ id: 'new', name: '新版积分套餐', offPeak: 0.5, peak: 1 });
const PLAN_V2_GLM_53: Plan = Object.freeze({
  id: 'v2-glm-5.3',
  name: '历史 V2 · GLM-5.3',
  offPeak: 1,
  peak: 3,
});
const PLAN_V2_GLM_53_FLASH: Plan = Object.freeze({
  id: 'v2-glm-5.3-flash',
  name: '历史 V2 · GLM-5.3-Flash',
  offPeak: 0.4,
  peak: 1.2,
});

/** 套餐列表：顺序即优先展示顺序，第一项是默认套餐。 */
export const PLANS: readonly Plan[] = Object.freeze([
  PLAN_NEW,
  PLAN_V2_GLM_53,
  PLAN_V2_GLM_53_FLASH,
]);

export const DEFAULT_PLAN_ID = 'new';

/** 默认套餐（`--plan` 省略时用它计价）。 */
export const DEFAULT_PLAN: Plan = PLAN_NEW;

/** 按 id 查套餐；查不到（含空值 / 未知 id）返回 undefined。 */
export function getPlan(id: string | undefined): Plan | undefined {
  return PLANS.find((plan) => plan.id === id);
}

/** 判断是否 V2 套餐（倍率按调用模型分行的两套历史套餐）。 */
function isV2Plan(plan: Plan): boolean {
  return plan.id === PLAN_V2_GLM_53.id || plan.id === PLAN_V2_GLM_53_FLASH.id;
}

/**
 * 一次调用适用的套餐行：V2 套餐按调用的模型选对应套餐行（#15）——
 * 模型名含「glm-5.3」且含「flash」用 v2-glm-5.3-flash 行，只含「glm-5.3」
 * 用 v2-glm-5.3 行，其他模型回退到所选套餐行；`new` 等单行套餐恒为该行。
 */
export function planRowForCall(plan: Plan, model: string): Plan {
  if (!isV2Plan(plan)) return plan;
  const name = model.toLowerCase();
  if (name.includes('glm-5.3') && name.includes('flash')) return PLAN_V2_GLM_53_FLASH;
  if (name.includes('glm-5.3')) return PLAN_V2_GLM_53;
  return plan;
}

/** 某次调用的折算倍率：按调用时刻是否高峰取套餐行的 peak / offPeak。 */
export function callMultiplier(plan: Plan, model: string, peak: boolean): number {
  const row = planRowForCall(plan, model);
  return peak ? row.peak : row.offPeak;
}
