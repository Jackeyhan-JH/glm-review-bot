/**
 * 用量报表核心测试（#15 验收）：
 * - 固定调用记录在按天 / 仓库 / 模型三种分组下的数值逐项核对；
 * - 折合 prompt 数在三种套餐下的断言（含 V2 未知模型回退）；
 * - 5 小时 / 7 天滚动窗口的左闭右开边界；
 * - since/until 闭区间过滤不影响滚动窗口。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CallRecord } from '../../src/state/calls.ts';
import { getPlan } from '../../src/usage/plans.ts';
import { buildUsageReport, WINDOW_5H_MS } from '../../src/usage/report.ts';
import { FIXED_CALL_RECORDS, toCallRecord, type FixtureCall } from './helpers.ts';

const NOW = new Date('2026-10-13T06:00:00.000Z');

function planOf(id: string) {
  const found = getPlan(id);
  assert.ok(found !== undefined);
  return found;
}

/** 断言一个 UsageStats（或其超集）里列出的字段。 */
function assertStats(
  actual: object,
  expected: Readonly<Record<string, unknown>>,
  label: string,
): void {
  const record = actual as Record<string, unknown>;
  for (const [key, value] of Object.entries(expected)) {
    assert.deepEqual(record[key], value, `${label}.${key}`);
  }
}

test('按天分组：固定记录的数值逐项核对（默认 new 套餐）', () => {
  const report = buildUsageReport([...FIXED_CALL_RECORDS], { now: NOW, groupBy: 'day' });
  assert.deepEqual(
    report.groups.map((group) => group.key),
    ['2026-10-12', '2026-10-13'],
    '日期键按北京时间，升序',
  );

  const [mon, tue] = report.groups;
  assertStats(
    mon,
    {
      calls: 3,
      okCalls: 2,
      failedCalls: 1,
      successRate: 0.6667,
      avgDurationMs: 45_000,
      totalDurationMs: 135_000,
      inputTokens: 2500,
      outputTokens: 400,
      costUsd: 0.016,
      prompts: 2, // 0.5 + 高峰 1 + 0.5
      peakCalls: 1,
    },
    '2026-10-12',
  );
  assertStats(
    tue,
    {
      calls: 2,
      okCalls: 1,
      failedCalls: 1,
      successRate: 0.5,
      avgDurationMs: 55_000,
      totalDurationMs: 110_000,
      inputTokens: 2300,
      outputTokens: 800,
      costUsd: 0.02,
      prompts: 1, // 0.5 + 0.5
      peakCalls: 0,
    },
    '2026-10-13',
  );

  assertStats(
    report.totals,
    {
      calls: 5,
      okCalls: 3,
      failedCalls: 2,
      successRate: 0.6,
      avgDurationMs: 49_000,
      totalDurationMs: 245_000,
      inputTokens: 4800,
      outputTokens: 1200,
      costUsd: 0.036,
      prompts: 3, // 4 次非高峰 ×0.5 + 1 次高峰 ×1
      peakCalls: 1,
    },
    '总计',
  );
  assert.equal(report.planId, 'new');
  assert.equal(report.groupBy, 'day');
  assert.equal(report.since, null);
  assert.equal(report.until, null);
});

test('按仓库分组：固定记录的数值逐项核对', () => {
  const report = buildUsageReport([...FIXED_CALL_RECORDS], { now: NOW, groupBy: 'repo' });
  assert.deepEqual(
    report.groups.map((group) => group.key),
    ['Jackeyhan-JH/glm-toolbox', 'Jackeyhan-JH/split-bill'],
  );

  const [toolbox, splitBill] = report.groups;
  assertStats(
    toolbox,
    {
      calls: 3,
      okCalls: 1,
      failedCalls: 2,
      successRate: 0.3333,
      avgDurationMs: Math.round(155_000 / 3),
      totalDurationMs: 155_000,
      inputTokens: 2800,
      outputTokens: 800,
      costUsd: 0.02,
      prompts: 1.5,
      peakCalls: 0,
    },
    'glm-toolbox',
  );
  assertStats(
    splitBill,
    {
      calls: 2,
      okCalls: 2,
      failedCalls: 0,
      successRate: 1,
      avgDurationMs: 45_000,
      totalDurationMs: 90_000,
      inputTokens: 2000,
      outputTokens: 400,
      costUsd: 0.016,
      prompts: 1.5, // 0.5 + 高峰 1
      peakCalls: 1,
    },
    'split-bill',
  );
});

test('按模型分组：固定记录的数值逐项核对', () => {
  const report = buildUsageReport([...FIXED_CALL_RECORDS], { now: NOW, groupBy: 'model' });
  assert.deepEqual(
    report.groups.map((group) => group.key),
    ['glm-5.3', 'glm-5.3-flash'],
  );

  const [large, small] = report.groups;
  assertStats(
    large,
    {
      calls: 3,
      okCalls: 2,
      failedCalls: 1,
      successRate: 0.6667,
      avgDurationMs: 65_000,
      totalDurationMs: 195_000,
      inputTokens: 3700,
      outputTokens: 1100,
      costUsd: 0.032,
      prompts: 1.5,
      peakCalls: 0,
    },
    'glm-5.3',
  );
  assertStats(
    small,
    {
      calls: 2,
      okCalls: 1,
      failedCalls: 1,
      successRate: 0.5,
      avgDurationMs: 25_000,
      totalDurationMs: 50_000,
      inputTokens: 1100,
      outputTokens: 100,
      costUsd: 0.004,
      prompts: 1.5, // 高峰 1 + 非高峰 0.5
      peakCalls: 1,
    },
    'glm-5.3-flash',
  );
});

test('折合 prompt 数：三种套餐各有断言', () => {
  // new：非高峰 0.5 / 高峰 1（所有模型同价）→ 4×0.5 + 1×1 = 3。
  const neu = buildUsageReport([...FIXED_CALL_RECORDS], {
    now: NOW,
    groupBy: 'day',
    plan: planOf('new'),
  });
  assert.equal(neu.totals.prompts, 3);

  // V2 套餐按调用模型选行：glm-5.3 三次非高峰 ×1；flash 高峰 ×1.2、非高峰 ×0.4
  // → 3 + 1.2 + 0.4 = 4.6。选哪个 V2 套餐不影响已知模型的计价。
  const v2 = buildUsageReport([...FIXED_CALL_RECORDS], {
    now: NOW,
    groupBy: 'day',
    plan: planOf('v2-glm-5.3'),
  });
  assert.equal(v2.totals.prompts, 4.6);
  assert.equal(v2.groups[0].prompts, 3.2); // 1 + 1.2 + 1
  assert.equal(v2.groups[1].prompts, 1.4); // 0.4 + 1

  const v2Flash = buildUsageReport([...FIXED_CALL_RECORDS], {
    now: NOW,
    groupBy: 'model',
    plan: planOf('v2-glm-5.3-flash'),
  });
  assert.equal(v2Flash.totals.prompts, 4.6);
  assert.equal(v2Flash.groups[0].prompts, 3); // glm-5.3 三次 ×1
  assert.equal(v2Flash.groups[1].prompts, 1.6); // 1.2 + 0.4
});

test('折合 prompt 数：V2 套餐下未知模型回退到所选套餐行', () => {
  const call: FixtureCall = {
    repo: 'Jackeyhan-JH/glm-night-shift',
    pr: 3,
    model: 'glm-4.7',
    startedAt: '2026-10-12T02:00:00.000Z', // 北京周一 10:00，非高峰
    durationMs: 1000,
    ok: true,
    inputTokens: 10,
    outputTokens: 5,
    costUsd: 0.001,
    peak: false,
  };
  const records: CallRecord[] = [toCallRecord(call, 1)];
  assert.equal(
    buildUsageReport(records, { now: NOW, plan: planOf('v2-glm-5.3') }).totals.prompts,
    1,
  );
  assert.equal(
    buildUsageReport(records, { now: NOW, plan: planOf('v2-glm-5.3-flash') }).totals.prompts,
    0.4,
  );
  assert.equal(
    buildUsageReport(records, { now: NOW, plan: planOf('new') }).totals.prompts,
    0.5,
  );
});

test('高峰期调用非 0 时给出警告，为 0 时无警告', () => {
  const report = buildUsageReport([...FIXED_CALL_RECORDS], { now: NOW, groupBy: 'day' });
  assert.equal(report.totals.peakCalls, 1);
  assert.equal(report.warnings.length, 1);
  assert.match(report.warnings[0] as string, /高峰期调用 1 次/);
  assert.match(report.warnings[0] as string, /理应为 0/);

  const clean = buildUsageReport(FIXED_CALL_RECORDS.slice(0, 1), { now: NOW, groupBy: 'day' });
  assert.deepEqual(clean.warnings, []);
  assert.equal(clean.totals.peakCalls, 0);
});

test('5 小时滚动窗口：左闭右开——恰好 5 小时前的调用计入，恰在 now 的不计入', () => {
  const now = new Date('2026-10-13T12:00:00.000Z');
  const at = (iso: string): CallRecord =>
    toCallRecord(
      {
        repo: 'a/b',
        pr: 1,
        model: 'glm-5.3',
        startedAt: iso,
        durationMs: 1000,
        ok: true,
        inputTokens: 1,
        outputTokens: 1,
        costUsd: null,
        peak: false,
      },
      1,
    );

  // 恰好 5 小时前（窗口左端，闭）：计入。
  const boundary = buildUsageReport([at('2026-10-13T07:00:00.000Z')], { now });
  assert.equal(boundary.window5h.calls, 1, '恰好 5 小时前应计入（左闭）');
  assert.equal(boundary.window5h.from, '2026-10-13T07:00:00.000Z');
  assert.equal(boundary.window5h.to, '2026-10-13T12:00:00.000Z');

  // 比 5 小时前早 1 毫秒：不计入。
  const before = buildUsageReport([at('2026-10-13T06:59:59.999Z')], { now });
  assert.equal(before.window5h.calls, 0);

  // 恰好在 now 时刻（窗口右端，开）：不计入，7 天窗口同理右开。
  const rightNow = buildUsageReport([at('2026-10-13T12:00:00.000Z')], { now });
  assert.equal(rightNow.window5h.calls, 0, '恰在 now 的调用不计入（右开）');
  assert.equal(rightNow.window7d.calls, 0, '7 天窗口同样右开');
  // 但它仍在主表里。
  assert.equal(rightNow.totals.calls, 1);

  assert.equal(WINDOW_5H_MS, 5 * 3_600_000);
});

test('近 7 天滚动窗口：恰好 7 天前的调用计入，更早的不计入', () => {
  const now = new Date('2026-10-13T12:00:00.000Z');
  const at = (iso: string): CallRecord =>
    toCallRecord(
      {
        repo: 'a/b',
        pr: 1,
        model: 'glm-5.3-flash',
        startedAt: iso,
        durationMs: 1000,
        ok: true,
        inputTokens: 1,
        outputTokens: 1,
        costUsd: null,
        peak: false,
      },
      1,
    );
  const boundary = buildUsageReport([at('2026-10-06T12:00:00.000Z')], { now });
  assert.equal(boundary.window7d.calls, 1, '恰好 7 天前应计入（左闭）');
  assert.equal(boundary.window7d.prompts, 0.5, '非高峰按 new 套餐 0.5 计');

  const tooOld = buildUsageReport([at('2026-10-06T11:59:59.999Z')], { now });
  assert.equal(tooOld.window7d.calls, 0);
  assert.equal(tooOld.window5h.calls, 0);
  assert.equal(tooOld.totals.calls, 1, '主表不受窗口限制');
});

test('固定记录在默认时钟下的两个窗口汇总', () => {
  const report = buildUsageReport([...FIXED_CALL_RECORDS], { now: NOW, groupBy: 'day' });
  // NOW = 2026-10-13T06:00Z → 5 小时窗口 [01:00, 06:00)：恰好含 01:00 与 03:30 两条。
  assertStats(
    report.window5h,
    {
      calls: 2,
      okCalls: 1,
      failedCalls: 1,
      inputTokens: 2300,
      outputTokens: 800,
      costUsd: 0.02,
      prompts: 1,
      peakCalls: 0,
    },
    '近 5 小时',
  );
  assert.equal(report.window5h.from, '2026-10-13T01:00:00.000Z');
  // 7 天窗口覆盖全部 5 条。
  assertStats(report.window7d, { calls: 5, prompts: 3, costUsd: 0.036 }, '近 7 天');
});

test('since/until 是闭区间过滤，且不影响滚动窗口', () => {
  const since = new Date('2026-10-13T00:00:00.000Z');
  const until = new Date('2026-10-13T03:30:00.000Z');
  const report = buildUsageReport([...FIXED_CALL_RECORDS], {
    now: NOW,
    groupBy: 'day',
    since,
    until,
  });
  // 恰好落在 since / until 边界上的两条（01:00 与 03:30）都计入（闭区间）。
  assert.equal(report.totals.calls, 2);
  assert.deepEqual(
    report.groups.map((group) => group.key),
    ['2026-10-13'],
  );
  assert.equal(report.since, '2026-10-13T00:00:00.000Z');
  assert.equal(report.until, '2026-10-13T03:30:00.000Z');
  // 滚动窗口仍统计完整列表：5 小时窗口只含 01:00 与 03:30 两条。
  assert.equal(report.window7d.calls, 5, '窗口不受 since/until 影响');
  assert.equal(report.window5h.calls, 2);
});

test('空记录：全 0、无分组、无警告', () => {
  const report = buildUsageReport([], { now: NOW, groupBy: 'repo' });
  assert.deepEqual(report.groups, []);
  assertStats(
    report.totals,
    {
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
    },
    '空报表',
  );
  assert.deepEqual(report.warnings, []);
  assert.equal(report.window5h.calls, 0);
  assert.equal(report.window7d.calls, 0);
  assert.equal(report.generatedAt, NOW.toISOString());
});

test('repo 为空的调用归入「未知仓库」组；cost 缺失按 0 计', () => {
  const base = FIXED_CALL_RECORDS[0];
  assert.ok(base !== undefined);
  const orphan: CallRecord = { ...base, id: 9, repo: null, costUsd: null };
  const report = buildUsageReport([orphan], { now: NOW, groupBy: 'repo' });
  assert.deepEqual(
    report.groups.map((group) => group.key),
    ['（未知仓库）'],
  );
  assertStats(report.totals, { calls: 1, costUsd: 0, inputTokens: 1200 }, '孤儿调用');
});
