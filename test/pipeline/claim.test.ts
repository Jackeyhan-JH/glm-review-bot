/**
 * #33 领取与收尾（src/pipeline/claim.ts）测试：claimJob 按 id 领取（attempts +1、
 * 不重复计）、requeueJob 放回单个任务、settleClaimedReview 的调用方契约——
 * 失败由调用方 markFailed（attempts 正确递增，连续失败 3 次进终态 failed）、
 * waiting / superseded / dry-run 放回队列、其余终态不动。全程只用临时状态库。
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { claimJob, requeueJob, settleClaimedReview } from '../../src/pipeline/claim.ts';
import type { ReviewOutcome } from '../../src/pipeline/review.ts';
import { openState, type StateDb } from '../../src/state/db.ts';
import { DEFAULT_RETRY_POLICY, enqueue, getJob, markDone, type Job } from '../../src/state/jobs.ts';
import { createTmpEnv } from '../helpers/tmp.ts';

const NOW = new Date('2026-10-12T00:00:00Z');
const RETRY = DEFAULT_RETRY_POLICY; // 最多 3 次，退避 60s / 300s / 1800s

function setup(): { state: StateDb; cleanup(): void } {
  const tmp = createTmpEnv('glm-review-claim-test');
  const state = openState(path.join(tmp.homeDir, 'state.db'));
  return {
    state,
    cleanup: () => {
      state.close();
      tmp.cleanup();
    },
  };
}

function enqueueJob(state: StateDb, headSha = `a${'1'.repeat(39)}`): Job {
  return enqueue(state, { repo: 'Jackeyhan-JH/split-bill', pr: 45, headSha, now: NOW }).job;
}

function failedOutcome(jobId: number): ReviewOutcome {
  return { status: 'failed', error: 'claude 调用失败（退出码 1）', jobId };
}

test('claimJob：queued → running、attempts +1、记 started_at', () => {
  const { state, cleanup } = setup();
  try {
    const job = enqueueJob(state);
    const claimed = claimJob(state, job.id, NOW);
    assert.equal(claimed.status, 'running');
    assert.equal(claimed.attempts, 1);
    assert.equal(claimed.startedAt, '2026-10-12T00:00:00.000Z');
  } finally {
    cleanup();
  }
});

test('claimJob：deferred 且未到 not_before 也可领取（手动路径不受退避限制）', () => {
  const { state, cleanup } = setup();
  try {
    const job = enqueueJob(state);
    // 模拟一次失败后的退避：queued → 认领 → markFailed 回队列，not_before = +60s
    claimJob(state, job.id, NOW);
    const settled = settleClaimedReview(state, job, failedOutcome(job.id), { now: NOW, retry: RETRY });
    assert.equal(settled?.status, 'queued');
    assert.equal(settled?.notBefore, '2026-10-12T00:01:00.000Z');

    // 未到退避时刻，手动路径仍可领取（claimNext 会跳过，claimJob 不会）
    const claimedAgain = claimJob(state, job.id, NOW);
    assert.equal(claimedAgain.status, 'running');
    assert.equal(claimedAgain.attempts, 2);
  } finally {
    cleanup();
  }
});

test('claimJob：running 或终态的任务不重复领取（attempts 不变）', () => {
  const { state, cleanup } = setup();
  try {
    const job = enqueueJob(state);
    claimJob(state, job.id, NOW); // running
    assert.equal(claimJob(state, job.id, NOW).attempts, 1);

    // 终态（done）的行同样不会被领取（markDone 本是 reviewPr 内部做的，这里直接置好）
    const done = markDone(state, enqueueJob(state, `b${'2'.repeat(39)}`).id, { now: NOW });
    assert.equal(claimJob(state, done.id, NOW).status, 'done');
    assert.equal(claimJob(state, done.id, NOW).attempts, 0);
  } finally {
    cleanup();
  }
});

test('requeueJob：running → queued、清 started_at、attempts 保留、not_before 不动', () => {
  const { state, cleanup } = setup();
  try {
    const job = enqueueJob(state);
    claimJob(state, job.id, NOW);
    const requeued = requeueJob(state, job.id, NOW);
    assert.equal(requeued.status, 'queued');
    assert.equal(requeued.startedAt, null);
    assert.equal(requeued.attempts, 1); // 领取已计入尝试次数，放回不回滚
    assert.equal(requeued.notBefore, '2026-10-12T00:00:00.000Z');
  } finally {
    cleanup();
  }
});

test('requeueJob：非 running 的任务不动', () => {
  const { state, cleanup } = setup();
  try {
    const job = enqueueJob(state);
    assert.equal(requeueJob(state, job.id, NOW).status, 'queued'); // 本来就 queued
    claimJob(state, job.id, NOW);
    requeueJob(state, job.id, NOW);
    assert.equal(requeueJob(state, job.id, NOW).status, 'queued'); // 幂等
  } finally {
    cleanup();
  }
});

test('settleClaimedReview：同一任务连续失败 3 次 → 第 3 次进终态 failed（#33 验收）', () => {
  const { state, cleanup } = setup();
  try {
    const job = enqueueJob(state);
    for (let round = 1; round <= 3; round++) {
      claimJob(state, job.id, NOW); // 调用方领取：attempts +1
      const settled = settleClaimedReview(state, job, failedOutcome(job.id), { now: NOW, retry: RETRY });
      assert.ok(settled !== undefined);
      assert.equal(settled.attempts, round, `第 ${round} 次失败后 attempts 应为 ${round}`);
      if (round < 3) {
        assert.equal(settled.status, 'queued', `第 ${round} 次失败应回队列`);
        assert.equal(settled.startedAt, null);
        assert.ok(settled.reason !== null && settled.reason.includes('claude'));
        assert.equal(settled.finishedAt, null);
      } else {
        assert.equal(settled.status, 'failed', '第 3 次失败应达重试上限，终态 failed');
        assert.ok(settled.finishedAt !== null);
      }
    }
    assert.equal(getJob(state, job.id).status, 'failed');
  } finally {
    cleanup();
  }
});

test('settleClaimedReview：退避随失败次数升档（60s → 300s）', () => {
  const { state, cleanup } = setup();
  try {
    const job = enqueueJob(state);
    claimJob(state, job.id, NOW);
    const first = settleClaimedReview(state, job, failedOutcome(job.id), { now: NOW, retry: RETRY });
    assert.equal(first?.notBefore, '2026-10-12T00:01:00.000Z'); // 第一档 60s
    claimJob(state, job.id, NOW);
    const second = settleClaimedReview(state, job, failedOutcome(job.id), { now: NOW, retry: RETRY });
    assert.equal(second?.notBefore, '2026-10-12T00:05:00.000Z'); // 第二档 300s
  } finally {
    cleanup();
  }
});

test('settleClaimedReview：waiting / superseded / dry-run 预览放回队列，其余终态不动', () => {
  const { state, cleanup } = setup();
  try {
    const cases: Array<{ outcome: ReviewOutcome; want: 'queued' | 'untouched' }> = [
      {
        outcome: { status: 'waiting', reason: 'paused', detail: '额度暂停', jobId: 0 },
        want: 'queued',
      },
      { outcome: { status: 'superseded', expected: 'a', current: 'b' }, want: 'queued' },
      {
        outcome: {
          status: 'reviewed', dryRun: true, degraded: false, findingsCount: 0,
          model: 'm', chunks: 1, durationMs: 1, jobId: 0,
        },
        want: 'queued',
      },
      { outcome: { status: 'already-reviewed', source: 'state', jobId: 0 }, want: 'untouched' },
      { outcome: { status: 'deferred', until: '2026-10-12T10:00:00.000Z', jobId: 0 }, want: 'untouched' },
      { outcome: { status: 'skipped', reason: 'disabled', jobId: 0 }, want: 'untouched' },
    ];
    for (const [index, { outcome, want }] of cases.entries()) {
      const job = enqueueJob(state, `${index}${'3'.repeat(39)}`);
      claimJob(state, job.id, NOW);
      const settled = settleClaimedReview(state, job, outcome, { now: NOW });
      if (want === 'queued') {
        assert.equal(settled?.status, 'queued', `${outcome.status} 应放回队列`);
        assert.equal(settled?.startedAt, null);
      } else {
        assert.equal(settled, undefined, `${outcome.status} 不应有收尾动作`);
      }
    }
  } finally {
    cleanup();
  }
});
