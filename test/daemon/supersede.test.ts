/**
 * 验收标准 3：PR 推了新 commit → 旧 sha 任务 superseded（skipped），新 sha 被审。
 * 两个场景：高峰期未开始的旧任务被取代；已审完的旧任务是历史记录、不受影响。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { listJobs } from '../../src/state/jobs.ts';
import {
  AFTER_PEAK_AT,
  createDaemonWorld,
  NON_PEAK_AT,
  PEAK_AT,
  PR_A,
  REPO_A,
  SHA_A1,
  SHA_A2,
} from './helpers.ts';

test('验收：高峰期新 commit 到来 → 旧 sha 任务 superseded，峰后只审新 sha', async () => {
  const w = createDaemonWorld({
    clockAt: PEAK_AT,
    repos: [{ repo: REPO_A, prs: [{ number: PR_A, headSha: SHA_A1 }] }],
  });
  try {
    await w.runDaemon(); // 高峰：A1 入队为 deferred
    const old = listJobs(w.state, { repo: REPO_A, pr: PR_A })[0];
    assert.equal(old?.status, 'deferred');

    // PR 推了新 commit（仍在高峰）：旧任务被取代，新任务入队（deferred 到峰后）
    w.repos[0]!.prs[0]!.headSha = SHA_A2;
    w.rebuild();
    await w.runDaemon();

    const jobs = listJobs(w.state, { repo: REPO_A, pr: PR_A });
    assert.equal(jobs.length, 2);
    const oldJob = jobs.find((job) => job.headSha === SHA_A1);
    const newJob = jobs.find((job) => job.headSha === SHA_A2);
    assert.equal(oldJob?.status, 'skipped', '旧 sha 未开始的任务被取代');
    assert.equal(oldJob?.reason, 'superseded');
    assert.equal(newJob?.status, 'deferred');

    // 峰后：只审新 sha（claude 的 cwd 是新 sha 的只读检出目录）
    w.clock.set(AFTER_PEAK_AT);
    await w.runDaemon();
    assert.equal(w.claudeCalls().length, 1);
    assert.ok(w.claudeCalls()[0]?.cwd.includes(SHA_A2.slice(0, 7)), '审的是新 sha 的检出');
    const after = listJobs(w.state, { repo: REPO_A, pr: PR_A });
    assert.equal(after.find((job) => job.headSha === SHA_A2)?.status, 'done');
    assert.equal(after.find((job) => job.headSha === SHA_A1)?.status, 'skipped');
  } finally {
    w.cleanup();
  }
});

test('旧 sha 已审完（done）时新 commit 到来 → 旧记录保留，新 sha 照常被审', async () => {
  const w = createDaemonWorld({
    clockAt: NON_PEAK_AT,
    repos: [{ repo: REPO_A, prs: [{ number: PR_A, headSha: SHA_A1 }] }],
  });
  try {
    await w.runDaemon(); // A1 审完
    assert.equal(w.claudeCalls().length, 1);

    w.repos[0]!.prs[0]!.headSha = SHA_A2;
    w.rebuild();
    await w.runDaemon(); // A2 被审

    assert.equal(w.claudeCalls().length, 2);
    const jobs = listJobs(w.state, { repo: REPO_A, pr: PR_A });
    assert.equal(jobs.length, 2);
    assert.equal(jobs.find((job) => job.headSha === SHA_A1)?.status, 'done', '已审记录是历史，不改写');
    assert.equal(jobs.find((job) => job.headSha === SHA_A2)?.status, 'done');
  } finally {
    w.cleanup();
  }
});
