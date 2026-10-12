import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PEAK_RULES } from '../../src/peak/rules.ts';

test('PEAK_RULES 与 glm-peak-clock 的规则一致：北京时间工作日 14:00–18:00', () => {
  assert.equal(PEAK_RULES.timeZone, 'Asia/Shanghai');
  assert.deepEqual(PEAK_RULES.peakDays, [1, 2, 3, 4, 5]); // 周一至周五（周日为 0）
  assert.equal(PEAK_RULES.peakStartMinutes, 840); // 14:00
  assert.equal(PEAK_RULES.peakEndMinutes, 1080); // 18:00
});

test('PEAK_RULES 自身满足基本约束（升序、区间合法、在一天之内）', () => {
  const days = PEAK_RULES.peakDays;
  assert.deepEqual([...days].sort((a, b) => a - b), days, 'peakDays 应升序');
  assert.equal(new Set(days).size, days.length, 'peakDays 不应有重复');
  assert.ok(0 <= PEAK_RULES.peakStartMinutes && PEAK_RULES.peakStartMinutes < PEAK_RULES.peakEndMinutes);
  assert.ok(PEAK_RULES.peakEndMinutes <= 24 * 60);
});
