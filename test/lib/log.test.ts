import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import path from 'node:path';
import { createLogger, nullLogger } from '../../src/lib/log.ts';
import { fixedClock } from '../../src/lib/clock.ts';
import { createTmpEnv } from '../helpers/tmp.ts';

function readLines(file: string): Record<string, unknown>[] {
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

test('log 按行写 JSON（ts/level/msg/字段），时间来自注入时钟', () => {
  const tmp = createTmpEnv('glm-review-log-test');
  try {
    const file = path.join(tmp.baseDir, 'glm-review.log');
    const logger = createLogger({ file, clock: fixedClock('2026-10-12T01:02:03Z') });
    logger.info('任务入队', { repo: 'Jackeyhan-JH/glm-toolbox', pr: 45 });
    logger.error('调用失败', { attempt: 2 });
    const lines = readLines(file);
    assert.equal(lines.length, 2);
    assert.deepEqual(lines[0], {
      repo: 'Jackeyhan-JH/glm-toolbox',
      pr: 45,
      ts: '2026-10-12T01:02:03.000Z',
      level: 'info',
      msg: '任务入队',
    });
    assert.equal(lines[1].level, 'error');
    assert.equal(lines[1].msg, '调用失败');
  } finally {
    tmp.cleanup();
  }
});

test('log 可回显到注入的输出函数，不写文件时不产生文件', () => {
  const echoed: string[] = [];
  const logger = createLogger({ echo: (line) => echoed.push(line), clock: fixedClock() });
  logger.warn('额度紧张', { used: 0.95 });
  assert.equal(echoed.length, 1);
  const parsed = JSON.parse(echoed[0] ?? '') as { level: string; msg: string; used: number };
  assert.equal(parsed.level, 'warn');
  assert.equal(parsed.msg, '额度紧张');
  assert.equal(parsed.used, 0.95);
});

test('nullLogger 静默无副作用', () => {
  nullLogger.debug('x');
  nullLogger.info('x');
  nullLogger.warn('x');
  nullLogger.error('x');
});
