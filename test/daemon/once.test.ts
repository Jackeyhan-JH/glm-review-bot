/**
 * 验收标准 1：`--once` 集成（假 gh / git / claude、假时钟）——两个仓库各有 1 个新 PR
 * → 各审一次；第二次 `--once` 不再调用 claude。另覆盖心跳 meta 写入。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getMeta } from '../../src/daemon/meta.ts';
import {
  META_DAEMON_HEARTBEAT_AT,
  META_DAEMON_LAST_POLL_MS,
  META_DAEMON_OPEN_PRS,
} from '../../src/status/collect.ts';
import { listJobs } from '../../src/state/jobs.ts';
import { createDaemonWorld, PR_A, PR_B, REPO_A, REPO_B, SHA_A1, SHA_B1 } from './helpers.ts';

test('验收：--once 两个仓库各有 1 个新 PR → 各审一次；第二次 --once 不再调用 claude', async () => {
  const w = createDaemonWorld({
    repos: [
      { repo: REPO_A, prs: [{ number: PR_A, headSha: SHA_A1 }] },
      { repo: REPO_B, prs: [{ number: PR_B, headSha: SHA_B1 }] },
    ],
  });
  try {
    const result = await w.runDaemon();
    assert.equal(result.code, 0);
    assert.equal(result.rounds, 1);

    // 各审一次：claude 恰好两次，每个仓库各 POST 一条 review
    assert.equal(w.claudeCalls().length, 2);
    assert.equal(w.postCalls().length, 2);
    for (const [repo, pr] of [
      [REPO_A, PR_A],
      [REPO_B, PR_B],
    ] as const) {
      const jobs = listJobs(w.state, { repo, pr });
      assert.equal(jobs.length, 1, `${repo} 只有一行任务`);
      assert.equal(jobs[0]?.status, 'done');
      assert.equal(jobs[0]?.attempts, 1);
      assert.ok(jobs[0]?.finishedAt !== null);
    }

    // 中文输出有轮询汇总与审查结果
    const stdout = w.harness.stdout();
    assert.ok(stdout.includes('轮询完成'));
    assert.ok(stdout.includes('入队 2'));
    assert.ok(stdout.includes('审查完成'));

    // 第二次 --once：全部 ignore(duplicate)，不再调用 claude、不再 POST、不新增任务行
    const second = await w.runDaemon();
    assert.equal(second.code, 0);
    assert.equal(w.claudeCalls().length, 2);
    assert.equal(w.postCalls().length, 2);
    assert.equal(listJobs(w.state).length, 2);
  } finally {
    w.cleanup();
  }
});

test('心跳：每轮把 heartbeat_at / last_poll_ms / open_prs 写进状态库 meta', async () => {
  const w = createDaemonWorld({
    repos: [
      { repo: REPO_A, prs: [{ number: PR_A, headSha: SHA_A1 }] },
      { repo: REPO_B, prs: [{ number: PR_B, headSha: SHA_B1 }] },
    ],
  });
  try {
    await w.runDaemon();
    // 假时钟停在 2026-10-12T00:00:00Z，心跳应是该时刻的 ISO 串
    assert.equal(getMeta(w.state, META_DAEMON_HEARTBEAT_AT), '2026-10-12T00:00:00.000Z');
    const pollMs = getMeta(w.state, META_DAEMON_LAST_POLL_MS);
    assert.ok(pollMs !== null && /^\d+$/.test(pollMs), `last_poll_ms 应为数字串：${pollMs}`);
    assert.deepEqual(
      JSON.parse(getMeta(w.state, META_DAEMON_OPEN_PRS) ?? '{}'),
      { [REPO_A]: 1, [REPO_B]: 1 },
    );
  } finally {
    w.cleanup();
  }
});
