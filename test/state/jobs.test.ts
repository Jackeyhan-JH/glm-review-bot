/**
 * 任务队列测试（#5 验收）：去重、并发认领、重试退避（假时钟）、defer、
 * supersede、recoverStale、查询与统计。全部使用临时目录里的库文件。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openState } from '../../src/state/db.ts';
import {
  claimNext,
  defer,
  DEFAULT_RETRY_POLICY,
  enqueue,
  getJob,
  isReviewed,
  listJobs,
  markDone,
  markFailed,
  markSkipped,
  stats,
  supersede,
  recoverStale,
  type Job,
} from '../../src/state/jobs.ts';
import { fixedClock } from '../../src/lib/clock.ts';
import { countJobs, openTmpState } from './helpers.ts';

const T0 = '2026-10-12T08:00:00.000Z';

test('enqueue 插入新任务并填默认值', () => {
  const t = openTmpState('glm-review-jobs-enqueue');
  try {
    const { job, created } = enqueue(t.state, { repo: 'a/b', pr: 3, headSha: 'sha-x', now: T0 });
    assert.equal(created, true);
    assert.equal(job.status, 'queued');
    assert.equal(job.attempts, 0);
    assert.equal(job.notBefore, T0);
    assert.equal(job.createdAt, T0);
    assert.equal(job.updatedAt, T0);
    assert.equal(job.startedAt, null);
    assert.equal(job.finishedAt, null);
    assert.equal(job.reason, null);
  } finally {
    t.cleanup();
  }
});

test('同键 enqueue 两次只有一行，created 标志区分', () => {
  const t = openTmpState('glm-review-jobs-dedup');
  try {
    const first = enqueue(t.state, { repo: 'a/b', pr: 3, headSha: 'sha-x', now: T0 });
    const second = enqueue(t.state, {
      repo: 'a/b',
      pr: 3,
      headSha: 'sha-x',
      now: '2026-10-12T09:00:00.000Z',
    });
    assert.equal(first.created, true);
    assert.equal(second.created, false);
    assert.equal(second.job.id, first.job.id);
    // 已审过的任务再入队也不会被重置或新建。
    assert.equal(second.job.createdAt, T0);
    assert.equal(countJobs(t.state), 1);

    // 不同 SHA、不同 PR 都是独立任务。
    enqueue(t.state, { repo: 'a/b', pr: 3, headSha: 'sha-y', now: T0 });
    enqueue(t.state, { repo: 'a/b', pr: 4, headSha: 'sha-x', now: T0 });
    assert.equal(countJobs(t.state), 3);
  } finally {
    t.cleanup();
  }
});

test('enqueue 可直接以 deferred 状态入队（高峰期路径）', () => {
  const t = openTmpState('glm-review-jobs-deferred-enqueue');
  try {
    const until = '2026-10-12T10:00:00.000Z';
    const { job } = enqueue(t.state, {
      repo: 'a/b',
      pr: 1,
      headSha: 'sha-d',
      now: T0,
      notBefore: until,
      status: 'deferred',
      reason: 'peak',
    });
    assert.equal(job.status, 'deferred');
    assert.equal(job.notBefore, until);
    assert.equal(job.reason, 'peak');
    // 峰后可正常认领。
    assert.equal(claimNext(t.state, '2026-10-12T09:59:59.000Z'), undefined);
    const claimed = claimNext(t.state, until);
    assert.ok(claimed !== undefined);
    assert.equal(claimed.status, 'running');
  } finally {
    t.cleanup();
  }
});

test('claimNext 置 running、attempts+1、记 started_at，空队列返回 undefined', () => {
  const t = openTmpState('glm-review-jobs-claim');
  try {
    enqueue(t.state, { repo: 'a/b', pr: 1, headSha: 'sha-1', now: T0 });
    const at = '2026-10-12T08:05:00.000Z';
    const job = claimNext(t.state, at);
    assert.ok(job !== undefined);
    assert.equal(job.status, 'running');
    assert.equal(job.attempts, 1);
    assert.equal(job.startedAt, at);
    assert.equal(job.updatedAt, at);
    // 没有其他可认领任务。
    assert.equal(claimNext(t.state, '2026-10-12T08:06:00.000Z'), undefined);
  } finally {
    t.cleanup();
  }
});

test('claimNext 只取 queued/deferred，按 not_before 最早优先', () => {
  const t = openTmpState('glm-review-jobs-order');
  try {
    enqueue(t.state, { repo: 'a/b', pr: 1, headSha: 'sha-late', now: T0, notBefore: '2026-10-12T09:00:00.000Z' });
    enqueue(t.state, { repo: 'a/b', pr: 2, headSha: 'sha-early', now: T0, notBefore: '2026-10-12T08:30:00.000Z' });
    const first = claimNext(t.state, '2026-10-12T08:45:00.000Z');
    assert.ok(first !== undefined);
    assert.equal(first.headSha, 'sha-early');
    const second = claimNext(t.state, '2026-10-12T09:00:00.000Z');
    assert.ok(second !== undefined);
    assert.equal(second.headSha, 'sha-late');
    // 终态与非 queued 状态不会被认领。
    markDone(t.state, first.id, { now: '2026-10-12T08:50:00.000Z' });
    const third = enqueue(t.state, { repo: 'a/b', pr: 3, headSha: 'sha-skip', now: T0 });
    markSkipped(t.state, third.job.id, 'draft', T0);
    assert.equal(claimNext(t.state, '2026-10-12T10:00:00.000Z'), undefined);
  } finally {
    t.cleanup();
  }
});

test('两个连接交替 claimNext 不会拿到同一任务', () => {
  const t = openTmpState('glm-review-jobs-concurrent');
  const other = openState(t.dbPath);
  try {
    const total = 8;
    for (let i = 0; i < total; i++) {
      enqueue(t.state, {
        repo: 'a/b',
        pr: i + 1,
        headSha: `sha-${i}`,
        now: T0,
        notBefore: `2026-10-12T08:0${i}:00.000Z`,
      });
    }
    const claimed: number[] = [];
    for (let i = 0; i < total; i++) {
      const conn = i % 2 === 0 ? t.state : other;
      const job = claimNext(conn, '2026-10-12T09:00:00.000Z');
      assert.ok(job !== undefined, `第 ${i} 次认领不应为空`);
      assert.equal(job.status, 'running');
      claimed.push(job.id);
    }
    assert.equal(new Set(claimed).size, total, '认领到的任务不应重复');
    assert.equal(claimNext(t.state, '2026-10-12T09:00:00.000Z'), undefined);
    assert.equal(claimNext(other, '2026-10-12T09:00:00.000Z'), undefined);
    assert.equal(stats(t.state).running, total);
  } finally {
    other.close();
    t.cleanup();
  }
});

test('defer 后 claimNext 在 not_before 之前拿不到、之后能拿到', () => {
  const t = openTmpState('glm-review-jobs-defer');
  try {
    const { job } = enqueue(t.state, { repo: 'a/b', pr: 1, headSha: 'sha-p', now: T0 });
    const until = '2026-10-12T18:00:00.000Z';
    const deferred = defer(t.state, job.id, until, 'peak', '2026-10-12T13:59:00.000Z');
    assert.equal(deferred.status, 'deferred');
    assert.equal(deferred.notBefore, until);
    assert.equal(deferred.reason, 'peak');

    assert.equal(claimNext(t.state, '2026-10-12T17:59:59.000Z'), undefined);
    const claimed = claimNext(t.state, until);
    assert.ok(claimed !== undefined);
    assert.equal(claimed.id, job.id);
    assert.equal(claimed.status, 'running');
  } finally {
    t.cleanup();
  }
});

test('markFailed 按退避重试：第 1、2 次回 queued 且 not_before 正确，第 3 次终态 failed', () => {
  const t = openTmpState('glm-review-jobs-retry');
  try {
    assert.deepEqual(DEFAULT_RETRY_POLICY, { maxAttempts: 3, backoffSeconds: [60, 300, 1800] });
    const clock = fixedClock(T0); // 假时钟：工作日 16:00 北京时间（高峰内入队，仅取时间）
    const { job } = enqueue(t.state, { repo: 'a/b', pr: 1, headSha: 'sha-r', now: clock.now() });

    // 第 1 次尝试失败：+60s 后重试。
    let claimed = claimNext(t.state, clock.now());
    assert.ok(claimed !== undefined);
    assert.equal(claimed.attempts, 1);
    let failed = markFailed(t.state, claimed.id, '第一次失败', { now: clock.now() });
    assert.equal(failed.status, 'queued');
    assert.equal(failed.reason, '第一次失败');
    assert.equal(failed.notBefore, '2026-10-12T08:01:00.000Z');
    assert.equal(failed.startedAt, null);
    clock.advance(59_000);
    assert.equal(claimNext(t.state, clock.now()), undefined, '退避未到不应认领');
    clock.advance(1_000);

    // 第 2 次尝试失败：+300s 后重试。
    claimed = claimNext(t.state, clock.now());
    assert.ok(claimed !== undefined);
    assert.equal(claimed.attempts, 2);
    failed = markFailed(t.state, claimed.id, new Error('第二次失败'), { now: clock.now() });
    assert.equal(failed.status, 'queued');
    assert.equal(failed.notBefore, '2026-10-12T08:06:00.000Z');

    // 第 3 次尝试失败：终态 failed。
    clock.set('2026-10-12T08:06:00.000Z');
    claimed = claimNext(t.state, clock.now());
    assert.ok(claimed !== undefined);
    assert.equal(claimed.attempts, 3);
    failed = markFailed(t.state, claimed.id, '第三次失败', { now: clock.now() });
    assert.equal(failed.status, 'failed');
    assert.equal(failed.attempts, 3);
    assert.equal(failed.reason, '第三次失败');
    assert.equal(failed.finishedAt, '2026-10-12T08:06:00.000Z');

    // 终态任务不会再被认领，isReviewed 为 false。
    assert.equal(claimNext(t.state, '2026-10-12T23:00:00.000Z'), undefined);
    assert.equal(isReviewed(t.state, 'a/b', 1, 'sha-r'), false);
    assert.equal(getJob(t.state, job.id).status, 'failed');
  } finally {
    t.cleanup();
  }
});

test('markFailed 支持自定义重试策略与显式 retryAt', () => {
  const t = openTmpState('glm-review-jobs-retry-custom');
  try {
    enqueue(t.state, { repo: 'a/b', pr: 2, headSha: 'sha-c', now: T0 });

    // maxAttempts=1：第一次失败即终态。
    let claimed = claimNext(t.state, T0);
    assert.ok(claimed !== undefined);
    const failedOnce = markFailed(t.state, claimed.id, '失败', {
      now: T0,
      retry: { maxAttempts: 1, backoffSeconds: [60] },
    });
    assert.equal(failedOnce.status, 'failed');
    assert.equal(failedOnce.finishedAt, T0);

    // retryAt 覆盖退避计算。
    enqueue(t.state, { repo: 'a/b', pr: 3, headSha: 'sha-o', now: T0 });
    const claimed2 = claimNext(t.state, T0);
    assert.ok(claimed2 !== undefined);
    const requeued = markFailed(t.state, claimed2.id, '显式时刻', {
      now: T0,
      retryAt: '2026-10-13T00:00:00.000Z',
    });
    assert.equal(requeued.status, 'queued');
    assert.equal(requeued.notBefore, '2026-10-13T00:00:00.000Z');
  } finally {
    t.cleanup();
  }
});

test('markDone 记录终态与 review 信息，isReviewed 变 true', () => {
  const t = openTmpState('glm-review-jobs-done');
  try {
    const { job } = enqueue(t.state, { repo: 'a/b', pr: 5, headSha: 'sha-ok', now: T0 });
    const claimed = claimNext(t.state, T0);
    assert.ok(claimed !== undefined);
    const done = markDone(t.state, job.id, {
      now: '2026-10-12T08:02:00.000Z',
      reviewUrl: 'https://github.com/a/b/pull/5#pullrequestreview-1',
      findingsCount: 4,
      model: 'glm-5.3',
    });
    assert.equal(done.status, 'done');
    assert.equal(done.finishedAt, '2026-10-12T08:02:00.000Z');
    assert.equal(done.reviewUrl, 'https://github.com/a/b/pull/5#pullrequestreview-1');
    assert.equal(done.findingsCount, 4);
    assert.equal(done.model, 'glm-5.3');
    assert.equal(isReviewed(t.state, 'a/b', 5, 'sha-ok'), true);
    // 审过的任务再入队：不新建、状态不变。
    const again = enqueue(t.state, { repo: 'a/b', pr: 5, headSha: 'sha-ok', now: T0 });
    assert.equal(again.created, false);
    assert.equal(again.job.status, 'done');
    assert.equal(countJobs(t.state), 1);
  } finally {
    t.cleanup();
  }
});

test('markSkipped 终态并记录原因，isReviewed 变 true', () => {
  const t = openTmpState('glm-review-jobs-skip');
  try {
    const { job } = enqueue(t.state, { repo: 'a/b', pr: 6, headSha: 'sha-s', now: T0 });
    const at = '2026-10-12T08:03:00.000Z';
    const skipped = markSkipped(t.state, job.id, 'skip-label', at);
    assert.equal(skipped.status, 'skipped');
    assert.equal(skipped.reason, 'skip-label');
    assert.equal(skipped.finishedAt, at);
    assert.equal(isReviewed(t.state, 'a/b', 6, 'sha-s'), true);
    assert.equal(claimNext(t.state, '2026-10-12T09:00:00.000Z'), undefined);
  } finally {
    t.cleanup();
  }
});

test('isReviewed：无记录、queued、running、failed 均为 false', () => {
  const t = openTmpState('glm-review-jobs-reviewed');
  try {
    assert.equal(isReviewed(t.state, 'a/b', 9, 'none'), false);
    const { job } = enqueue(t.state, { repo: 'a/b', pr: 9, headSha: 'sha-q', now: T0 });
    assert.equal(isReviewed(t.state, 'a/b', 9, 'sha-q'), false);
    const claimed = claimNext(t.state, T0);
    assert.ok(claimed !== undefined);
    assert.equal(isReviewed(t.state, 'a/b', 9, 'sha-q'), false);
    markFailed(t.state, job.id, '失败', { now: T0, retry: { maxAttempts: 1, backoffSeconds: [] } });
    assert.equal(isReviewed(t.state, 'a/b', 9, 'sha-q'), false);
  } finally {
    t.cleanup();
  }
});

test('recoverStale 把超时 running 恢复为 queued，未超时不动，attempts 保留', () => {
  const t = openTmpState('glm-review-jobs-stale');
  try {
    const { job } = enqueue(t.state, { repo: 'a/b', pr: 1, headSha: 'sha-st', now: T0 });
    const claimed = claimNext(t.state, T0);
    assert.ok(claimed !== undefined);
    assert.equal(claimed.attempts, 1);

    // 开始后 10 分钟，阈值 30 分钟：仍是 running。
    assert.equal(recoverStale(t.state, '2026-10-12T08:10:00.000Z', 30), 0);
    assert.equal(getJob(t.state, job.id).status, 'running');

    // 超过阈值：恢复为 queued。
    assert.equal(recoverStale(t.state, '2026-10-12T08:30:01.000Z', 30), 1);
    const recovered = getJob(t.state, job.id);
    assert.equal(recovered.status, 'queued');
    assert.equal(recovered.startedAt, null);
    assert.equal(recovered.attempts, 1, '崩溃消耗的尝试次数保留');
    assert.equal(recoverStale(t.state, '2026-10-12T09:00:00.000Z', 30), 0, '幂等：无 running 可恢复');

    // 恢复后可再次认领，attempts 继续累计。
    const reClaimed = claimNext(t.state, '2026-10-12T08:31:00.000Z');
    assert.ok(reClaimed !== undefined);
    assert.equal(reClaimed.attempts, 2);
  } finally {
    t.cleanup();
  }
});

test('supersede：旧 SHA 未开始任务标 skipped，running/done 不动，新 SHA 正常', () => {
  const t = openTmpState('glm-review-jobs-supersede');
  try {
    const running = enqueue(t.state, { repo: 'a/b', pr: 2, headSha: 'sha-old-r', now: T0 });
    const done = enqueue(t.state, { repo: 'a/b', pr: 2, headSha: 'sha-old-d', now: T0 });
    markDone(t.state, done.job.id, { now: T0 });
    const queued = enqueue(t.state, { repo: 'a/b', pr: 2, headSha: 'sha-old-q', now: T0 });
    const deferred = enqueue(t.state, {
      repo: 'a/b',
      pr: 2,
      headSha: 'sha-old-f',
      now: T0,
      status: 'deferred',
      reason: 'peak',
    });
    const runningClaimed = claimNext(t.state, T0);
    assert.ok(runningClaimed !== undefined);
    assert.equal(runningClaimed.id, running.job.id);

    // 其他 PR / 仓库的任务不应受影响。
    const otherPr = enqueue(t.state, { repo: 'a/b', pr: 3, headSha: 'sha-other', now: T0 });
    const otherRepo = enqueue(t.state, { repo: 'c/d', pr: 2, headSha: 'sha-repo', now: T0 });

    const at = '2026-10-12T09:00:00.000Z';
    assert.equal(supersede(t.state, 'a/b', 2, 'sha-new', at), 2);

    assert.equal(getJob(t.state, queued.job.id).status, 'skipped');
    assert.equal(getJob(t.state, queued.job.id).reason, 'superseded');
    assert.equal(getJob(t.state, queued.job.id).finishedAt, at);
    assert.equal(getJob(t.state, deferred.job.id).status, 'skipped');
    assert.equal(getJob(t.state, deferred.job.id).reason, 'superseded');
    assert.equal(getJob(t.state, runningClaimed.id).status, 'running');
    assert.equal(getJob(t.state, done.job.id).status, 'done');
    assert.equal(getJob(t.state, otherPr.job.id).status, 'queued');
    assert.equal(getJob(t.state, otherRepo.job.id).status, 'queued');

    // 新 SHA 正常入队；a/b#2 的队列里只剩它。
    const fresh = enqueue(t.state, { repo: 'a/b', pr: 2, headSha: 'sha-new', now: at });
    assert.equal(fresh.created, true);
    assert.deepEqual(
      listJobs(t.state, { repo: 'a/b', pr: 2, status: 'queued' }).map((j) => j.headSha),
      ['sha-new'],
    );
    // 其他任务也在队列里，逐个认领直到取到新 SHA。
    let claimedNew: Job | undefined;
    for (let i = 0; i < 4 && claimedNew === undefined; i++) {
      const j = claimNext(t.state, at);
      if (j !== undefined && j.headSha === 'sha-new') claimedNew = j;
    }
    assert.ok(claimedNew !== undefined);
    assert.equal(claimedNew.status, 'running');
  } finally {
    t.cleanup();
  }
});

test('listJobs 按入队时间倒序，支持 status/repo/pr/limit 过滤', () => {
  const t = openTmpState('glm-review-jobs-list');
  try {
    enqueue(t.state, { repo: 'a/b', pr: 1, headSha: 's1', now: '2026-10-12T08:00:00.000Z' });
    enqueue(t.state, { repo: 'a/b', pr: 2, headSha: 's2', now: '2026-10-12T08:01:00.000Z' });
    enqueue(t.state, { repo: 'c/d', pr: 1, headSha: 's3', now: '2026-10-12T08:02:00.000Z' });
    const third = enqueue(t.state, { repo: 'a/b', pr: 3, headSha: 's4', now: '2026-10-12T08:03:00.000Z' });
    markSkipped(t.state, third.job.id, 'draft', '2026-10-12T08:04:00.000Z');

    const all = listJobs(t.state);
    assert.equal(all.length, 4);
    assert.equal(all[0].headSha, 's4', '最新在前');

    assert.deepEqual(
      listJobs(t.state, { repo: 'a/b' }).map((j) => j.headSha),
      ['s4', 's2', 's1'],
    );
    assert.deepEqual(
      listJobs(t.state, { status: 'skipped' }).map((j) => j.headSha),
      ['s4'],
    );
    assert.deepEqual(
      listJobs(t.state, { repo: 'a/b', pr: 2 }).map((j) => j.headSha),
      ['s2'],
    );
    assert.deepEqual(
      listJobs(t.state, { repo: 'a/b', limit: 2 }).map((j) => j.headSha),
      ['s4', 's2'],
    );
  } finally {
    t.cleanup();
  }
});

test('stats 各状态计数正确', () => {
  const t = openTmpState('glm-review-jobs-stats');
  try {
    assert.deepEqual(stats(t.state), {
      queued: 0,
      deferred: 0,
      running: 0,
      done: 0,
      failed: 0,
      skipped: 0,
    });
    const j1 = enqueue(t.state, { repo: 'a/b', pr: 1, headSha: 's1', now: T0 });
    // 除 s1 / s5 外都压到 09:00 之后，保证 T0 时刻按顺序认领到 s1、s5。
    enqueue(t.state, {
      repo: 'a/b',
      pr: 2,
      headSha: 's2',
      now: T0,
      notBefore: '2026-10-12T09:00:00.000Z',
      status: 'deferred',
      reason: 'peak',
    });
    const j3 = enqueue(t.state, {
      repo: 'a/b',
      pr: 3,
      headSha: 's3',
      now: T0,
      notBefore: '2026-10-12T09:00:00.000Z',
    });
    const j4 = enqueue(t.state, {
      repo: 'a/b',
      pr: 4,
      headSha: 's4',
      now: T0,
      notBefore: '2026-10-12T09:00:00.000Z',
    });
    const j5 = enqueue(t.state, { repo: 'a/b', pr: 5, headSha: 's5', now: T0 });
    enqueue(t.state, {
      repo: 'a/b',
      pr: 6,
      headSha: 's6',
      now: T0,
      notBefore: '2026-10-12T09:00:00.000Z',
    });
    const first = claimNext(t.state, T0); // s1 -> running
    assert.ok(first !== undefined);
    assert.equal(first.headSha, 's1');
    const second = claimNext(t.state, T0); // 其余都压在峰后，第二个取到 s5
    assert.ok(second !== undefined);
    assert.equal(second.headSha, 's5');
    markSkipped(t.state, j3.job.id, 'draft', T0);
    markDone(t.state, j4.job.id, { now: T0 });
    markFailed(t.state, j5.job.id, '失败', {
      now: T0,
      retry: { maxAttempts: 1, backoffSeconds: [] },
    });

    assert.deepEqual(stats(t.state), {
      queued: 1, // s6
      deferred: 1, // s2
      running: 1, // s1
      done: 1, // s4
      failed: 1, // s5
      skipped: 1, // s3
    });
  } finally {
    t.cleanup();
  }
});

test('对不存在的 id 调 mark* 抛错', () => {
  const t = openTmpState('glm-review-jobs-missing');
  try {
    assert.throws(() => markDone(t.state, 999, { now: T0 }), /任务不存在/);
    assert.throws(() => markFailed(t.state, 999, 'err', { now: T0 }), /任务不存在/);
    assert.throws(() => markSkipped(t.state, 999, 'r', T0), /任务不存在/);
    assert.throws(() => defer(t.state, 999, T0, 'peak', T0), /任务不存在/);
    assert.throws(() => getJob(t.state, 999), /任务不存在/);
  } finally {
    t.cleanup();
  }
});
