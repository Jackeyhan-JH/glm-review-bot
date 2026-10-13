/**
 * worker 单测：闸门不通过不领取（不扣 attempts）、reviewPr 抛异常由 worker 记失败
 * （#33 约定）、claude 失败退避升档与终态、dry-run 退回领取、并发上限。
 */
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import type { ReviewPrInput, ReviewPipelineDeps, ReviewOutcome } from '../../src/pipeline/review.ts';
import { findJobByKey } from '../../src/daemon/queue.ts';
import { listJobs, markDone } from '../../src/state/jobs.ts';
import {
  createDaemonWorld,
  NON_PEAK_AT,
  PR_A,
  PR_B,
  REPO_A,
  REPO_B,
  SHA_A1,
  SHA_B1,
} from './helpers.ts';

test('闸门未通过（额度暂停文件存在）→ 不领取，任务保持 queued、attempts 0（不扣次数）', async () => {
  const w = createDaemonWorld({
    repos: [{ repo: REPO_A, prs: [{ number: PR_A, headSha: SHA_A1 }] }],
  });
  try {
    writeFileSync(path.join(w.tmp.baseDir, 'GLM_PAUSE'), '');
    const result = await w.runDaemon();
    assert.equal(result.code, 0);

    const job = listJobs(w.state, { repo: REPO_A, pr: PR_A })[0];
    assert.equal(job?.status, 'queued');
    assert.equal(job?.attempts, 0, '没领取就不扣 attempts');
    assert.equal(w.claudeCalls().length, 0);
    assert.ok(w.harness.stdout().includes('闸门未通过'), '输出说明闸门未通过');
    assert.ok(w.harness.stdout().includes('30 秒后重试'), '按 30 秒重试口径说明');
  } finally {
    w.cleanup();
  }
});

test('reviewPr 抛异常（getPr 阶段 gh 失败）→ worker 记一次失败，任务不卡 running', async () => {
  const w = createDaemonWorld({
    clockAt: NON_PEAK_AT,
    repos: [
      {
        repo: REPO_A,
        prs: [{ number: PR_A, headSha: SHA_A1, viewError: { code: 1, stderr: 'gh: 网络错误 connection reset' } }],
      },
    ],
  });
  try {
    const result = await w.runDaemon();
    assert.equal(result.code, 0);

    const job = listJobs(w.state, { repo: REPO_A, pr: PR_A })[0];
    assert.equal(job?.status, 'queued', '按重试策略回到队列');
    assert.equal(job?.attempts, 1, '失败占一次尝试');
    assert.equal(job?.startedAt, null, '不卡 running');
    assert.ok(job?.reason?.includes('网络错误') || job?.reason?.includes('命令失败'), `reason 记录错误：${job?.reason}`);
    assert.equal(job?.notBefore, '2026-10-12T00:01:00.000Z', '第一档退避 60 秒');
    assert.equal(w.claudeCalls().length, 0);
    assert.ok(w.harness.stdout().includes('审查异常') || w.harness.stdout().includes('审查失败'));
  } finally {
    w.cleanup();
  }
});

test('claude 连续失败 → 退避升档（60s → 300s），3 次后终态 failed', async () => {
  const w = createDaemonWorld({
    clockAt: NON_PEAK_AT,
    claude: { code: 1, stderr: 'claude: overload 5xx' },
    repos: [{ repo: REPO_A, prs: [{ number: PR_A, headSha: SHA_A1 }] }],
  });
  try {
    // 第 1 次：attempts=1，退避 60 秒
    await w.runDaemon();
    let job = listJobs(w.state, { repo: REPO_A, pr: PR_A })[0];
    assert.equal(job?.status, 'queued');
    assert.equal(job?.attempts, 1);
    assert.equal(job?.notBefore, '2026-10-12T00:01:00.000Z');

    // 第 2 次（时钟推过退避时刻）：attempts=2，退避升到 300 秒
    w.clock.advance(61_000);
    await w.runDaemon();
    job = listJobs(w.state, { repo: REPO_A, pr: PR_A })[0];
    assert.equal(job?.attempts, 2);
    assert.equal(job?.notBefore, '2026-10-12T00:06:01.000Z', '00:01:01 + 300s');

    // 第 3 次：attempts=3 = maxAttempts → 终态 failed
    w.clock.advance(301_000);
    await w.runDaemon();
    job = listJobs(w.state, { repo: REPO_A, pr: PR_A })[0];
    assert.equal(job?.status, 'failed');
    assert.ok(job?.finishedAt !== null);
    // 每次审查内部就地重试 2 次 claude，共 3 轮 = 6 次
    assert.equal(w.claudeCalls().length, 6);
  } finally {
    w.cleanup();
  }
});

test('dry-run：预览不发送、不标记 done、不扣 attempts；随后可真实发布', async () => {
  const w = createDaemonWorld({
    repos: [{ repo: REPO_A, prs: [{ number: PR_A, headSha: SHA_A1 }] }],
  });
  try {
    await w.runDaemon({ dryRun: true });
    assert.equal(w.claudeCalls().length, 1, '模型照跑（真实预览）');
    assert.equal(w.postCalls().length, 0, '不发评论');
    let job = listJobs(w.state, { repo: REPO_A, pr: PR_A })[0];
    assert.equal(job?.status, 'queued', 'dry-run 预览不占「审过」键，退回队列');
    assert.equal(job?.attempts, 0, 'dry-run 不扣 attempts（#35 约定）');
    // 预览退回的任务被延后 30 秒（同一轮不反复预览），推过这个窗口再真实发布
    w.clock.advance(31_000);

    const second = await w.runDaemon();
    assert.equal(second.code, 0);
    assert.equal(w.claudeCalls().length, 2);
    assert.equal(w.postCalls().length, 1);
    job = listJobs(w.state, { repo: REPO_A, pr: PR_A })[0];
    assert.equal(job?.status, 'done');
  } finally {
    w.cleanup();
  }
});

test('并发上限：maxConcurrent=1 串行执行；=2 时两个任务并行（注入 review 计数）', async () => {
  async function runWithConcurrency(maxConcurrent: number): Promise<{ maxActive: number; count: number }> {
    const w = createDaemonWorld({
      repos: [
        { repo: REPO_A, prs: [{ number: PR_A, headSha: SHA_A1 }] },
        { repo: REPO_B, prs: [{ number: PR_B, headSha: SHA_B1 }] },
      ],
      configExtra: [`maxConcurrent: ${maxConcurrent}`],
    });
    try {
      const stats = { active: 0, maxActive: 0, count: 0 };
      const fakeReview = async (
        input: ReviewPrInput,
        deps: ReviewPipelineDeps,
      ): Promise<ReviewOutcome> => {
        stats.active += 1;
        stats.count += 1;
        stats.maxActive = Math.max(stats.maxActive, stats.active);
        // 睡得比一轮 gate 的 pgrep 子进程久一些：负载高的机器上窗口太窄会把
        // 本应并行的两个任务挤成串行（曾以 40ms 在满载 CI 上偶发）。
        await new Promise((resolve) => setTimeout(resolve, 300));
        stats.active -= 1;
        const job = findJobByKey(deps.state, input.repo, input.pr, input.headSha ?? '');
        if (job !== undefined) {
          markDone(deps.state, job.id, { now: deps.clock.now() });
        }
        return {
          status: 'reviewed',
          dryRun: false,
          degraded: false,
          findingsCount: 0,
          model: 'fake',
          chunks: 1,
          durationMs: 1,
          jobId: job?.id ?? 0,
        };
      };
      const result = await w.runDaemon({ review: fakeReview });
      assert.equal(result.code, 0);
      assert.equal(stats.count, 2);
      assert.equal(listJobs(w.state).length, 2);
      return { maxActive: stats.maxActive, count: stats.count };
    } finally {
      w.cleanup();
    }
  }

  assert.equal((await runWithConcurrency(1)).maxActive, 1, 'maxConcurrent=1：审查串行');
  assert.equal((await runWithConcurrency(2)).maxActive, 2, 'maxConcurrent=2：两个任务并行');
});
