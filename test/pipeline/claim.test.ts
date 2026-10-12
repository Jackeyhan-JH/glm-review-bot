/**
 * #33 / #35 复审 领取与收尾（src/pipeline/claim.ts）测试：claimJob 按 id 领取
 * （attempts +1、不重复计）、refundClaim 退回领取（没真正审查的运行不占失败次数，
 * deferred 只退领取保留排队时刻）、settleClaimedReview 的调用方契约——失败由调用方
 * markFailed（attempts 正确递增，连续失败 3 次进终态 failed）、deferred / waiting /
 * superseded / dry-run 退回领取、其余终态不动。全程只用临时状态库。
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { claimJob, refundClaim, settleClaimedReview } from '../../src/pipeline/claim.ts';
import type { ReviewOutcome } from '../../src/pipeline/review.ts';
import { openState, type StateDb } from '../../src/state/db.ts';
import { DEFAULT_RETRY_POLICY, defer, enqueue, getJob, markDone, type Job } from '../../src/state/jobs.ts';
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

test('refundClaim(queued)：running → queued、attempts -1、清 started_at、not_before 不动（#35 复审 A）', () => {
  const { state, cleanup } = setup();
  try {
    const job = enqueueJob(state);
    claimJob(state, job.id, NOW);
    const refunded = refundClaim(state, job.id, NOW, 'queued');
    assert.equal(refunded.status, 'queued');
    assert.equal(refunded.startedAt, null);
    assert.equal(refunded.attempts, 0); // 没真正审查，退回失败名额
    assert.equal(refunded.notBefore, '2026-10-12T00:00:00.000Z');
  } finally {
    cleanup();
  }
});

test('refundClaim(deferred)：只退领取（attempts -1、清 started_at），保留 deferred 与 not_before', () => {
  const { state, cleanup } = setup();
  try {
    const job = enqueueJob(state);
    claimJob(state, job.id, NOW);
    // reviewPr 的高峰分支会把行置为 deferred 并设 not_before = 峰后，这里同样置好
    defer(state, job.id, '2026-10-12T10:00:00Z', 'peak', NOW);
    const refunded = refundClaim(state, job.id, NOW, 'deferred');
    assert.equal(refunded.status, 'deferred');
    assert.equal(refunded.attempts, 0);
    assert.equal(refunded.startedAt, null);
    assert.equal(refunded.notBefore, '2026-10-12T10:00:00.000Z');
    assert.equal(refunded.reason, 'peak');
  } finally {
    cleanup();
  }
});

test('refundClaim：attempts 不为负；非 running / deferred 的行不动', () => {
  const { state, cleanup } = setup();
  try {
    const job = enqueueJob(state); // 从未领取过（attempts=0）
    assert.equal(refundClaim(state, job.id, NOW, 'queued').attempts, 0);
    assert.equal(refundClaim(state, job.id, NOW, 'queued').status, 'queued'); // 幂等

    claimJob(state, job.id, NOW);
    refundClaim(state, job.id, NOW, 'queued');
    refundClaim(state, job.id, NOW, 'queued'); // 多退不欠
    assert.equal(getJob(state, job.id).attempts, 0);
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

test('settleClaimedReview：deferred / waiting / superseded / dry-run 退回领取（attempts 归还），其余终态不动', () => {
  const { state, cleanup } = setup();
  try {
    // deferred：reviewPr 已置 deferred + not_before；settle 只退领取
    const peak = enqueueJob(state, `d${'4'.repeat(39)}`);
    claimJob(state, peak.id, NOW);
    defer(state, peak.id, '2026-10-12T10:00:00Z', 'peak', NOW);
    const refundedDeferred = settleClaimedReview(
      state,
      peak,
      { status: 'deferred', until: '2026-10-12T10:00:00.000Z', jobId: peak.id },
      { now: NOW },
    );
    assert.equal(refundedDeferred?.status, 'deferred');
    assert.equal(refundedDeferred?.attempts, 0);
    assert.equal(refundedDeferred?.startedAt, null);
    assert.equal(refundedDeferred?.notBefore, '2026-10-12T10:00:00.000Z');

    // waiting / superseded / dry-run 预览：退回领取并放回 queued
    const requeued: Array<{ label: string; outcome: ReviewOutcome }> = [
      { label: 'waiting', outcome: { status: 'waiting', reason: 'paused', detail: '额度暂停', jobId: 0 } },
      { label: 'superseded', outcome: { status: 'superseded', expected: 'a', current: 'b' } },
      {
        label: 'dry-run 预览',
        outcome: {
          status: 'reviewed', dryRun: true, degraded: false, findingsCount: 0,
          model: 'm', chunks: 1, durationMs: 1, jobId: 0,
        },
      },
    ];
    for (const [index, { label, outcome }] of requeued.entries()) {
      const job = enqueueJob(state, `${index}${'3'.repeat(39)}`);
      claimJob(state, job.id, NOW);
      const settled = settleClaimedReview(state, job, outcome, { now: NOW });
      assert.equal(settled?.status, 'queued', `${label} 应放回队列`);
      assert.equal(settled?.startedAt, null, `${label} 应清 started_at`);
      assert.equal(settled?.attempts, 0, `${label} 没真正审查，应退回失败名额`);
    }

    // 真实完成 / 跳过 / 已审过：reviewPr 内部已落终态，settle 不动
    const untouched: Array<{ label: string; outcome: ReviewOutcome }> = [
      { label: 'reviewed（非 dry-run）', outcome: { status: 'reviewed', dryRun: false, degraded: false, findingsCount: 0, model: 'm', chunks: 1, durationMs: 1, jobId: 0 } },
      { label: 'already-reviewed', outcome: { status: 'already-reviewed', source: 'state', jobId: 0 } },
      { label: 'skipped', outcome: { status: 'skipped', reason: 'disabled', jobId: 0 } },
    ];
    for (const [index, { label, outcome }] of untouched.entries()) {
      const job = enqueueJob(state, `${index}${'5'.repeat(39)}`);
      claimJob(state, job.id, NOW);
      assert.equal(settleClaimedReview(state, job, outcome, { now: NOW }), undefined, `${label} 不应有收尾动作`);
    }
  } finally {
    cleanup();
  }
});

test('settleClaimedReview：高峰没审的运行连续发生也不累积 attempts（#35 复审 A）', () => {
  const { state, cleanup } = setup();
  try {
    const job = enqueueJob(state);
    for (let round = 1; round <= 3; round++) {
      claimJob(state, job.id, NOW); // 每次手动运行都先领取
      defer(state, job.id, '2026-10-12T10:00:00Z', 'peak', NOW); // reviewPr 的高峰分支
      const settled = settleClaimedReview(
        state,
        job,
        { status: 'deferred', until: '2026-10-12T10:00:00.000Z', jobId: job.id },
        { now: NOW },
      );
      assert.equal(settled?.attempts, 0, `高峰第 ${round} 次运行后 attempts 应退回 0`);
      assert.equal(settled?.status, 'deferred');
    }
    // 峰后第一次真实失败：attempts=1、回队列退避，而不是直接冲进终态
    claimJob(state, job.id, NOW);
    const failed = settleClaimedReview(state, job, failedOutcome(job.id), { now: NOW, retry: RETRY });
    assert.equal(failed?.status, 'queued');
    assert.equal(failed?.attempts, 1);
    assert.equal(failed?.notBefore, '2026-10-12T00:01:00.000Z');
  } finally {
    cleanup();
  }
});
