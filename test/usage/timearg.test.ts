/**
 * 时间参数解析测试（#15 验收）：--since 解析 7d / 24h / 30m / ISO，
 * --until 只收 ISO；非法值抛 TimeArgError（命令层转中文报错 + 退出码 2）。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseIsoArg, parseSinceArg, TimeArgError } from '../../src/usage/timearg.ts';

const NOW = new Date('2026-10-13T06:00:00.000Z');

test('--since 相对时长：7d / 24h / 30m（含大小写与 0）', () => {
  assert.equal(parseSinceArg('7d', NOW).toISOString(), '2026-10-06T06:00:00.000Z');
  assert.equal(parseSinceArg('24h', NOW).toISOString(), '2026-10-12T06:00:00.000Z');
  assert.equal(parseSinceArg('30m', NOW).toISOString(), '2026-10-13T05:30:00.000Z');
  assert.equal(parseSinceArg('1d', NOW).toISOString(), '2026-10-12T06:00:00.000Z');
  assert.equal(parseSinceArg('0d', NOW).toISOString(), NOW.toISOString());
  assert.equal(parseSinceArg('24H', NOW).toISOString(), '2026-10-12T06:00:00.000Z');
});

test('--since ISO 时刻：原样接受（含仅日期、无时区按 UTC、带偏移）', () => {
  assert.equal(
    parseSinceArg('2026-10-01T00:00:00Z', NOW).toISOString(),
    '2026-10-01T00:00:00.000Z',
  );
  assert.equal(parseSinceArg('2026-10-01', NOW).toISOString(), '2026-10-01T00:00:00.000Z');
  assert.equal(
    parseSinceArg('2026-10-13T00:00:00', NOW).toISOString(),
    '2026-10-13T00:00:00.000Z',
    '无时区的日期时间按 UTC',
  );
  assert.equal(
    parseSinceArg('2026-10-13T08:00:00+08:00', NOW).toISOString(),
    '2026-10-13T00:00:00.000Z',
    '带时区偏移',
  );
});

test('--since 非法取值：中文报错并复述原取值', () => {
  for (const bad of ['abc', '7x', '7', 'd7', '-7d', '7.5h', '2026-13-01', '']) {
    assert.throws(
      () => parseSinceArg(bad, NOW),
      (err: unknown) => {
        assert.ok(err instanceof TimeArgError);
        assert.match(err.message, /无效的 --since 取值|超出可表示范围/);
        if (bad !== '') assert.ok(err.message.includes(bad), `报错应复述取值：${bad}`);
        return true;
      },
      `应拒绝：${bad}`,
    );
  }
  // 数值合法但超出 Date 可表示范围。
  assert.throws(() => parseSinceArg('999999999d', NOW), TimeArgError);
});

test('--until 只接受 ISO 时刻：相对时长被拒绝', () => {
  assert.equal(parseIsoArg('2026-10-13T00:00:00Z').toISOString(), '2026-10-13T00:00:00.000Z');
  for (const bad of ['7d', '24h', 'not-a-time', '']) {
    assert.throws(
      () => parseIsoArg(bad),
      (err: unknown) => {
        assert.ok(err instanceof TimeArgError);
        assert.match(err.message, /无效的时间取值/);
        return true;
      },
      `--until 应拒绝：${bad}`,
    );
  }
});
