import assert from 'node:assert/strict';
import { test } from 'node:test';
import { withRetry, type RetryableResult } from '../../src/llm/retry.ts';

const fail = (retryable: boolean, tag: string): RetryableResult & { tag: string } => ({
  ok: false,
  retryable,
  tag,
});
const success: RetryableResult & { tag: string } = { ok: true, retryable: false, tag: 'ok' };

test('可重试错误：第一次失败、第二次成功，共调用 2 次', async () => {
  const attempts: number[] = [];
  const result = await withRetry(
    async (attempt) => {
      attempts.push(attempt);
      return attempt === 1 ? fail(true, '瞬时错误') : success;
    },
    { attempts: 2, backoffMs: 0 },
  );
  assert.deepEqual(result, success);
  assert.deepEqual(attempts, [1, 2]);
});

test('不可重试错误：立即返回，只调用 1 次', async () => {
  const attempts: number[] = [];
  const result = await withRetry(
    async (attempt) => {
      attempts.push(attempt);
      return fail(false, '认证失败');
    },
    { attempts: 3, backoffMs: 0 },
  );
  assert.equal(result.ok, false);
  assert.equal(result.tag, '认证失败');
  assert.deepEqual(attempts, [1]);
});

test('重试耗尽：返回最后一次失败，不再多试', async () => {
  const attempts: number[] = [];
  const result = await withRetry(
    async (attempt) => {
      attempts.push(attempt);
      return fail(true, `第 ${attempt} 次`);
    },
    { attempts: 3, backoffMs: 0 },
  );
  assert.equal(result.ok, false);
  assert.equal(result.tag, '第 3 次');
  assert.deepEqual(attempts, [1, 2, 3]);
});

test('成功不重试；attempts 默认 2、下限 1', async () => {
  let calls = 0;
  const okFirst = await withRetry(async () => {
    calls += 1;
    return success;
  });
  assert.equal(okFirst.ok, true);
  assert.equal(calls, 1);

  let zeroCalls = 0;
  const zero = await withRetry(
    async () => {
      zeroCalls += 1;
      return fail(true, 'x');
    },
    { attempts: 0, backoffMs: 0 },
  );
  assert.equal(zero.ok, false);
  assert.equal(zeroCalls, 1);
});

test('backoffMs > 0 时每次重试前经注入的 sleep 等待', async () => {
  const sleeps: number[] = [];
  const attempts: number[] = [];
  const result = await withRetry(
    async (attempt) => {
      attempts.push(attempt);
      return attempt === 1 ? fail(true, 't') : success;
    },
    { attempts: 2, backoffMs: 50, sleep: async (ms) => { sleeps.push(ms); } },
  );
  assert.equal(result.ok, true);
  assert.deepEqual(sleeps, [50]);
  assert.deepEqual(attempts, [1, 2]);
});

test('backoffMs = 0（默认）时不等待', async () => {
  const sleeps: number[] = [];
  await withRetry(async () => fail(true, 't'), { attempts: 2, sleep: async (ms) => { sleeps.push(ms); } });
  assert.deepEqual(sleeps, []);
});

test('fn 抛出的异常直接上抛、不重试', async () => {
  let calls = 0;
  await assert.rejects(
    withRetry(
      async () => {
        calls += 1;
        throw new Error('spawn 失败');
      },
      { attempts: 3, backoffMs: 0 },
    ),
    /spawn 失败/,
  );
  assert.equal(calls, 1);
});
