/**
 * 验收标准 2：高峰期运行 `--once` → 新 PR 入队为 deferred、零次 claude 调用；
 * 假时钟推到峰后再 `--once` → 完成审查。时间点见 helpers（北京时间换算）。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { listJobs } from '../../src/state/jobs.ts';
import {
  AFTER_PEAK_AT,
  createDaemonWorld,
  PEAK_AT,
  PR_A,
  REPO_A,
  SHA_A1,
} from './helpers.ts';

test('验收：高峰期 --once → 入队 deferred、零次 claude；峰后 --once → 完成审查', async () => {
  const w = createDaemonWorld({
    clockAt: PEAK_AT, // 周一 07:00Z = 北京 15:00，本段高峰 10:00Z（北京 18:00）结束
    repos: [{ repo: REPO_A, prs: [{ number: PR_A, headSha: SHA_A1 }] }],
  });
  try {
    const first = await w.runDaemon();
    assert.equal(first.code, 0);

    const job = listJobs(w.state, { repo: REPO_A, pr: PR_A })[0];
    assert.ok(job !== undefined, '高峰期照常入队');
    assert.equal(job.status, 'deferred');
    assert.equal(job.reason, 'peak');
    assert.equal(job.notBefore, '2026-10-12T10:00:00.000Z');
    assert.equal(job.attempts, 0);
    assert.equal(w.claudeCalls().length, 0, '高峰期零次 claude 调用');
    assert.ok(w.harness.stdout().includes('高峰期'), '输出说明高峰期不领取');

    // 假时钟推到峰后（北京 18:30）再 --once → 完成审查
    w.clock.set(AFTER_PEAK_AT);
    const second = await w.runDaemon();
    assert.equal(second.code, 0);
    assert.equal(w.claudeCalls().length, 1);
    assert.equal(w.postCalls().length, 1);

    const done = listJobs(w.state, { repo: REPO_A, pr: PR_A })[0];
    assert.equal(done?.status, 'done');
    assert.equal(done?.attempts, 1);
    assert.equal(done?.reviewUrl, `https://github.com/${REPO_A}/pull/${PR_A}#pullrequestreview-1`);
  } finally {
    w.cleanup();
  }
});
