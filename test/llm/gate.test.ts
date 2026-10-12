import assert from 'node:assert/strict';
import { rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import type { ExecFn } from '../../src/lib/exec.ts';
import { checkGate, countClaudeProcesses } from '../../src/llm/gate.ts';
import { createTmpEnv } from '../helpers/tmp.ts';

// 整个文件共用一个隔离临时环境：baseDir 下的 GLM_PAUSE 默认不存在（= 未暂停），
// 需要「存在」的用例写完在 finally 里删掉。
const tmp = createTmpEnv('glm-review-gate-test');
const pauseFile = path.join(tmp.baseDir, 'GLM_PAUSE');

/** 假 exec：只应答 pgrep，其余调用记录下来（用于断言「没起子进程」）。 */
function pgrepFake(pids: string[], code = 0): { exec: ExecFn; calls: Array<{ cmd: string; args: string[] }> } {
  const calls: Array<{ cmd: string; args: string[] }> = [];
  const exec: ExecFn = async (cmd, args) => {
    calls.push({ cmd, args });
    return {
      code,
      stdout: code === 1 ? '' : `${pids.join('\n')}\n`,
      stderr: '',
      timedOut: false,
      durationMs: 1,
    };
  };
  return { exec, calls };
}

test('闸门：暂停文件存在 → paused，且不起 pgrep 子进程', async () => {
  writeFileSync(pauseFile, '');
  const { exec, calls } = pgrepFake([]);
  try {
    const result = await checkGate({ pauseFile, mineRunning: 0 }, { exec });
    assert.deepEqual(result, { ok: false, reason: 'paused', detail: `额度暂停文件存在：${pauseFile}` });
    assert.equal(calls.length, 0);
  } finally {
    rmSync(pauseFile, { force: true });
  }
});

test('闸门：自身已达 maxConcurrent → self-busy，不起 pgrep 子进程', async () => {
  const { exec, calls } = pgrepFake([]);
  const result = await checkGate(
    { pauseFile, mineRunning: 1, maxConcurrent: 1 },
    { exec },
  );
  assert.ok(!result.ok);
  assert.equal(result.reason, 'self-busy');
  assert.match(result.detail, /自身并发 1 已达上限 1/);
  assert.equal(calls.length, 0);
});

test('闸门：maxConcurrent 默认 1，自身有 1 个在跑即 self-busy', async () => {
  const { exec } = pgrepFake([]);
  const result = await checkGate({ pauseFile, mineRunning: 1 }, { exec });
  assert.ok(!result.ok);
  assert.equal(result.reason, 'self-busy');
});

test('闸门：pgrep 报 4 个进程 → box-busy', async () => {
  const { exec, calls } = pgrepFake(['111', '222', '333', '444']);
  const result = await checkGate(
    { pauseFile, mineRunning: 0, maxConcurrent: 1, boxClaudeLimit: 4 },
    { exec },
  );
  assert.ok(!result.ok);
  assert.equal(result.reason, 'box-busy');
  assert.match(result.detail, /本机 claude 进程 4 已达上限 4/);
  assert.deepEqual(calls, [{ cmd: 'pgrep', args: ['-x', 'claude'] }]);
});

test('闸门：boxClaudeLimit 默认 4，pgrep 报 4 个进程同样 box-busy', async () => {
  const { exec } = pgrepFake(['111', '222', '333', '444']);
  const result = await checkGate({ pauseFile, mineRunning: 0 }, { exec });
  assert.ok(!result.ok);
  assert.equal(result.reason, 'box-busy');
});

test('闸门：pgrep 报 3 个进程、自身未满 → ok', async () => {
  const { exec } = pgrepFake(['111', '222', '333']);
  const result = await checkGate({ pauseFile, mineRunning: 0 }, { exec });
  assert.deepEqual(result, { ok: true });
});

test('闸门：pgrep 退出码 1（无匹配）按 0 个进程处理 → ok', async () => {
  const { exec } = pgrepFake([], 1);
  const result = await checkGate({ pauseFile, mineRunning: 0 }, { exec });
  assert.deepEqual(result, { ok: true });
});

test('countClaudeProcesses：按输出行数统计', async () => {
  assert.equal(await countClaudeProcesses(pgrepFake(['11', '22', '33']).exec), 3);
  assert.equal(await countClaudeProcesses(pgrepFake([], 0).exec), 0);
});

test('countClaudeProcesses：pgrep 自身失败（退出码 ≥ 2）时抛错', async () => {
  const { exec } = pgrepFake([], 2);
  await assert.rejects(countClaudeProcesses(exec), /pgrep 执行失败（退出码 2）/);
});
