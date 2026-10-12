import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixedClock, systemClock } from '../../src/lib/clock.ts';

test('systemClock 返回接近当前的时刻', () => {
  const before = Date.now();
  const now = systemClock.now().getTime();
  const after = Date.now();
  assert.ok(now >= before && now <= after);
});

test('fixedClock 停在指定时刻且不受系统时间影响', () => {
  const clock = fixedClock('2026-10-12T08:00:00Z');
  assert.equal(clock.now().toISOString(), '2026-10-12T08:00:00.000Z');
  assert.equal(clock.now().toISOString(), '2026-10-12T08:00:00.000Z');
});

test('fake 时钟可推进、可重设，且 now() 返回副本', () => {
  const clock = fixedClock('2026-10-12T00:00:00Z');
  clock.advance(90_000);
  assert.equal(clock.now().toISOString(), '2026-10-12T00:01:30.000Z');
  clock.set('2026-10-11T23:59:00Z');
  assert.equal(clock.now().toISOString(), '2026-10-11T23:59:00.000Z');
  const snapshot = clock.now();
  snapshot.setTime(0);
  assert.equal(clock.now().toISOString(), '2026-10-11T23:59:00.000Z');
});
