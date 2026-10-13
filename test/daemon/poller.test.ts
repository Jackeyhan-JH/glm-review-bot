/**
 * 轮询单测：单仓库出错不影响其他仓库（验收标准 4）、限流暂停轮询、
 * /glm-review 手动重审、草稿转正重新入队、仓库配置缓存 10 分钟。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getMeta } from '../../src/daemon/meta.ts';
import { processedCommentsKey } from '../../src/daemon/poller.ts';
import { listJobs } from '../../src/state/jobs.ts';
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

test('验收：一个仓库 404 时另一个仓库照常处理', async () => {
  const w = createDaemonWorld({
    repos: [
      { repo: REPO_A, prs: [{ number: PR_A, headSha: SHA_A1 }], listError: { code: 1, stderr: 'gh: Could not resolve to a repository Jackeyhan-JH/split-bill' } },
      { repo: REPO_B, prs: [{ number: PR_B, headSha: SHA_B1 }] },
    ],
  });
  try {
    const result = await w.runDaemon();
    assert.equal(result.code, 0, '单仓库失败不影响整体');
    assert.ok(w.harness.stdout().includes(`仓库 ${REPO_A} 轮询失败`), '输出提示失败仓库');
    assert.ok(w.log.lines('warn').some((line) => line.includes('轮询仓库失败')), '记录告警日志');

    // B 的 PR 照常被审；A 没有产生任务
    assert.equal(w.claudeCalls().length, 1);
    assert.equal(listJobs(w.state, { repo: REPO_B }).length, 1);
    assert.equal(listJobs(w.state, { repo: REPO_A }).length, 0);
    assert.equal(listJobs(w.state, { repo: REPO_B, pr: PR_B })[0]?.status, 'done');
  } finally {
    w.cleanup();
  }
});

test('限流：按建议等待时间暂停本轮轮询，剩余仓库跳过', async () => {
  const w = createDaemonWorld({
    repos: [
      { repo: REPO_A, prs: [{ number: PR_A, headSha: SHA_A1 }], listError: { code: 1, stderr: 'gh: You have exceeded a secondary rate limit; re-trying in 1234 seconds' } },
      { repo: REPO_B, prs: [{ number: PR_B, headSha: SHA_B1 }] },
    ],
  });
  try {
    const summary = await w.pollOnce();
    assert.ok(summary.rateLimitUntil !== undefined, '返回限流恢复时刻');
    // 假时钟 00:00Z + 1234s
    assert.equal(summary.rateLimitUntil?.toISOString(), '2026-10-12T00:20:34.000Z');
    assert.ok(w.harness.stdout().includes('限流') || w.log.lines('warn').some((l) => l.includes('限流')));
    // 本轮剩余仓库（B）没有被动过
    assert.equal(w.ghListCalls().length, 1, '只调了第一个仓库的 pr list');
    assert.equal(listJobs(w.state).length, 0);
  } finally {
    w.cleanup();
  }
});

test('/glm-review 手动重审：忽略去重，同一 sha 强制重审一次', async () => {
  const w = createDaemonWorld({
    clockAt: NON_PEAK_AT,
    repos: [
      {
        repo: REPO_A,
        prs: [{ number: PR_A, headSha: SHA_A1, comments: [{ id: 101, body: '看起来不错', createdAt: '2026-10-11T08:00:00Z' }] }],
      },
    ],
  });
  try {
    await w.runDaemon(); // 首轮：审一次
    assert.equal(w.claudeCalls().length, 1);

    // owner 在 PR 评论里发 /glm-review → 强制重审同一 sha
    w.repos[0]!.prs[0]!.comments?.push({ id: 102, body: '/glm-review', createdAt: '2026-10-11T09:00:00Z' });
    w.rebuild();
    await w.runDaemon();

    assert.equal(w.claudeCalls().length, 2, '忽略去重，重新审一次');
    assert.equal(w.postCalls().length, 2);
    const jobs = listJobs(w.state, { repo: REPO_A, pr: PR_A });
    assert.equal(jobs.length, 1, '同键仍只有一行任务');
    assert.equal(jobs[0]?.status, 'done');
    assert.equal(jobs[0]?.reason, 'manual', '重置原因留存（worker 据此传 force）');
    // 已处理评论 id 已持久化
    assert.deepEqual(JSON.parse(getMeta(w.state, processedCommentsKey(REPO_A, PR_A)) ?? '[]'), [102]);

    // 同一评论不重复触发：再来一轮不再审
    await w.runDaemon();
    assert.equal(w.claudeCalls().length, 2);
  } finally {
    w.cleanup();
  }
});

test('非 owner 发的 /glm-review 不触发重审', async () => {
  const w = createDaemonWorld({
    clockAt: NON_PEAK_AT,
    repos: [{ repo: REPO_A, prs: [{ number: PR_A, headSha: SHA_A1 }] }],
  });
  try {
    await w.runDaemon();
    assert.equal(w.claudeCalls().length, 1);
    w.repos[0]!.prs[0]!.comments = [{ id: 201, author: 'someone-else', body: '/glm-review', createdAt: '2026-10-11T09:00:00Z' }];
    w.rebuild();
    await w.runDaemon();
    assert.equal(w.claudeCalls().length, 1, '非 owner 命令不触发');
  } finally {
    w.cleanup();
  }
});

test('草稿 PR → skipped(draft) 不审；转正后同一 sha 重新入队审查', async () => {
  const w = createDaemonWorld({
    clockAt: NON_PEAK_AT,
    repos: [{ repo: REPO_A, prs: [{ number: PR_A, headSha: SHA_A1, isDraft: true }] }],
  });
  try {
    await w.runDaemon();
    const job = listJobs(w.state, { repo: REPO_A, pr: PR_A })[0];
    assert.equal(job?.status, 'skipped');
    assert.equal(job?.reason, 'draft');
    assert.equal(w.claudeCalls().length, 0);

    // 转正（同一 sha）：skipped(draft) 不算已审 → 重新入队审查
    w.repos[0]!.prs[0]!.isDraft = false;
    w.rebuild();
    await w.runDaemon();
    assert.equal(w.claudeCalls().length, 1);
    const after = listJobs(w.state, { repo: REPO_A, pr: PR_A })[0];
    assert.equal(after?.status, 'done');
    assert.equal(after?.attempts, 1);
  } finally {
    w.cleanup();
  }
});

test('仓库配置缓存 10 分钟：缓存期内不重拉，过期后重拉', async () => {
  const w = createDaemonWorld({
    repos: [{ repo: REPO_A, prs: [{ number: PR_A, headSha: SHA_A1 }] }],
  });
  try {
    await w.pollOnce();
    await w.pollOnce();
    assert.equal(w.configCalls().length, 1, '10 分钟内两次轮询只拉一次 .glm-review.yml');

    w.clock.advance(11 * 60 * 1000);
    await w.pollOnce();
    assert.equal(w.configCalls().length, 2, '过期后重新拉取');
  } finally {
    w.cleanup();
  }
});
