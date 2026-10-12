/**
 * 套餐倍率表测试（#15 验收）：倍率数值与 glm-peak-clock src/plans.js 的 PLANS
 * 一致；V2 套餐按调用模型选对应套餐行、未知模型回退到所选行。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  callMultiplier,
  DEFAULT_PLAN,
  DEFAULT_PLAN_ID,
  getPlan,
  PLANS,
  planRowForCall,
  type Plan,
} from '../../src/usage/plans.ts';

/** glm-peak-clock src/plans.js（commit e84e2a2）的 PLANS 原文数值。 */
const UPSTREAM_PLANS: ReadonlyArray<{
  id: string;
  name: string;
  offPeak: number;
  peak: number;
}> = [
  { id: 'new', name: '新版积分套餐', offPeak: 0.5, peak: 1 },
  { id: 'v2-glm-5.3', name: '历史 V2 · GLM-5.3', offPeak: 1, peak: 3 },
  { id: 'v2-glm-5.3-flash', name: '历史 V2 · GLM-5.3-Flash', offPeak: 0.4, peak: 1.2 },
];

function plan(id: string): Plan {
  const found = getPlan(id);
  assert.ok(found !== undefined, `套餐应存在：${id}`);
  return found;
}

test('PLANS 与 glm-peak-clock 逐项一致（id、名称、倍率、顺序）', () => {
  assert.deepEqual(
    PLANS.map(({ id, name, offPeak, peak }) => ({ id, name, offPeak, peak })),
    UPSTREAM_PLANS,
  );
  assert.equal(DEFAULT_PLAN_ID, 'new');
  assert.equal(DEFAULT_PLAN.id, 'new');
  assert.deepEqual(DEFAULT_PLAN, UPSTREAM_PLANS[0]);
});

test('getPlan：已知 id 命中，未知 / 空值返回 undefined', () => {
  assert.equal(getPlan('new')?.peak, 1);
  assert.equal(getPlan('v2-glm-5.3')?.offPeak, 1);
  assert.equal(getPlan('v2-glm-5.3-flash')?.peak, 1.2);
  assert.equal(getPlan('v3'), undefined);
  assert.equal(getPlan(''), undefined);
  assert.equal(getPlan(undefined), undefined);
});

test('planRowForCall：V2 套餐按调用模型选对应套餐行', () => {
  const v2 = plan('v2-glm-5.3');
  const v2Flash = plan('v2-glm-5.3-flash');
  // glm-5.3 → v2-glm-5.3 行（1 / 3），与所选的是哪个 V2 套餐无关。
  assert.deepEqual(planRowForCall(v2, 'glm-5.3'), plan('v2-glm-5.3'));
  assert.deepEqual(planRowForCall(v2Flash, 'glm-5.3'), plan('v2-glm-5.3'));
  // glm-5.3-flash（大小写不敏感）→ v2-glm-5.3-flash 行（0.4 / 1.2）。
  assert.deepEqual(planRowForCall(v2, 'glm-5.3-flash'), plan('v2-glm-5.3-flash'));
  assert.deepEqual(planRowForCall(v2Flash, 'GLM-5.3-Flash'), plan('v2-glm-5.3-flash'));
  // 其他模型回退到所选套餐行：两个 V2 套餐在此分歧。
  assert.deepEqual(planRowForCall(v2, 'glm-4.7'), v2);
  assert.deepEqual(planRowForCall(v2Flash, 'glm-4.7'), v2Flash);
});

test('planRowForCall：new 套餐恒为自身一行', () => {
  const neu = plan('new');
  for (const model of ['glm-5.3', 'glm-5.3-flash', 'glm-4.7', '']) {
    assert.deepEqual(planRowForCall(neu, model), neu);
  }
});

test('callMultiplier：高峰 / 非高峰各套餐倍率', () => {
  assert.equal(callMultiplier(plan('new'), 'glm-5.3', false), 0.5);
  assert.equal(callMultiplier(plan('new'), 'glm-5.3', true), 1);
  assert.equal(callMultiplier(plan('v2-glm-5.3'), 'glm-5.3', false), 1);
  assert.equal(callMultiplier(plan('v2-glm-5.3'), 'glm-5.3', true), 3);
  assert.equal(callMultiplier(plan('v2-glm-5.3-flash'), 'glm-5.3-flash', false), 0.4);
  assert.equal(callMultiplier(plan('v2-glm-5.3-flash'), 'glm-5.3-flash', true), 1.2);
  // V2 套餐下按模型选行：flash 模型不会按 glm-5.3 行计价。
  assert.equal(callMultiplier(plan('v2-glm-5.3'), 'glm-5.3-flash', true), 1.2);
});
