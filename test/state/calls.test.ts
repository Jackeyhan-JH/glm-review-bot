/**
 * 调用账本测试（#5 验收）：recordCall / listCalls、按时间/仓库/模型过滤、外键约束。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { recordCall, listCalls } from '../../src/state/calls.ts';
import { enqueue } from '../../src/state/jobs.ts';
import { openTmpState } from './helpers.ts';

const T0 = '2026-10-12T08:00:00.000Z';

function seedJob(t: ReturnType<typeof openTmpState>, repo: string, pr: number, sha: string): number {
  const { job } = enqueue(t.state, { repo, pr, headSha: sha, now: T0 });
  return job.id;
}

test('recordCall 最小字段入库，默认值正确', () => {
  const t = openTmpState('glm-review-calls-min');
  try {
    const jobId = seedJob(t, 'a/b', 1, 'sha-1');
    const call = recordCall(t.state, {
      jobId,
      chunkIndex: 0,
      model: 'glm-5.3-flash',
      startedAt: '2026-10-12T09:00:00.000Z',
      durationMs: 12_345,
      exitCode: 0,
      ok: true,
    });
    assert.equal(call.id, 1);
    assert.equal(call.jobId, jobId);
    assert.equal(call.repo, 'a/b');
    assert.equal(call.model, 'glm-5.3-flash');
    assert.equal(call.durationMs, 12_345);
    assert.equal(call.exitCode, 0);
    assert.equal(call.ok, true);
    assert.equal(call.inputTokens, null);
    assert.equal(call.outputTokens, null);
    assert.equal(call.costUsd, null);
    assert.equal(call.peak, false, '非高峰期调用，peak 理应为 0');
    assert.equal(call.error, null);

    const all = listCalls(t.state);
    assert.equal(all.length, 1);
    assert.deepEqual(all[0], call);
  } finally {
    t.cleanup();
  }
});

test('recordCall 完整字段与失败调用都能如实记录', () => {
  const t = openTmpState('glm-review-calls-full');
  try {
    const jobId = seedJob(t, 'a/b', 2, 'sha-2');
    const ok = recordCall(t.state, {
      jobId,
      chunkIndex: 1,
      model: 'glm-5.3',
      startedAt: '2026-10-12T09:00:00.000Z',
      durationMs: 250_000,
      exitCode: 0,
      ok: true,
      inputTokens: 18_000,
      outputTokens: 3_200,
      costUsd: 0.042,
      peak: false,
    });
    assert.equal(ok.inputTokens, 18_000);
    assert.equal(ok.outputTokens, 3_200);
    assert.ok(Math.abs((ok.costUsd ?? 0) - 0.042) < 1e-9);
    assert.equal(ok.peak, false);

    const bad = recordCall(t.state, {
      jobId,
      chunkIndex: 2,
      model: 'glm-5.3',
      startedAt: '2026-10-12T09:05:00.000Z',
      durationMs: 5_000,
      exitCode: 1,
      ok: false,
      error: 'claude 超时',
    });
    assert.equal(bad.ok, false);
    assert.equal(bad.exitCode, 1);
    assert.equal(bad.error, 'claude 超时');
    assert.equal(listCalls(t.state).length, 2);
  } finally {
    t.cleanup();
  }
});

test('listCalls 按 since/until 过滤（含边界）', () => {
  const t = openTmpState('glm-review-calls-range');
  try {
    const jobId = seedJob(t, 'a/b', 1, 'sha-1');
    for (const at of [
      '2026-10-12T09:00:00.000Z',
      '2026-10-12T10:00:00.000Z',
      '2026-10-12T11:00:00.000Z',
    ]) {
      recordCall(t.state, {
        jobId,
        chunkIndex: 0,
        model: 'glm-5.3',
        startedAt: at,
        durationMs: 1000,
        exitCode: 0,
        ok: true,
      });
    }
    assert.equal(listCalls(t.state, { since: '2026-10-12T10:00:00.000Z' }).length, 2);
    assert.equal(listCalls(t.state, { until: '2026-10-12T10:00:00.000Z' }).length, 2);
    assert.equal(
      listCalls(t.state, {
        since: '2026-10-12T09:00:00.000Z',
        until: '2026-10-12T11:00:00.000Z',
      }).length,
      3,
    );
    assert.equal(listCalls(t.state, { since: '2026-10-12T12:00:00.000Z' }).length, 0);
    // 升序排列。
    const times = listCalls(t.state).map((c) => c.startedAt);
    assert.deepEqual([...times].sort(), times);
  } finally {
    t.cleanup();
  }
});

test('listCalls 按 repo / model / limit 过滤', () => {
  const t = openTmpState('glm-review-calls-filter');
  try {
    const jobIdAb = seedJob(t, 'a/b', 1, 'sha-1');
    const jobIdCd = seedJob(t, 'c/d', 1, 'sha-2');
    const rows = [
      { jobId: jobIdAb, model: 'glm-5.3-flash', at: '2026-10-12T09:00:00.000Z' },
      { jobId: jobIdAb, model: 'glm-5.3', at: '2026-10-12T09:30:00.000Z' },
      { jobId: jobIdCd, model: 'glm-5.3', at: '2026-10-12T10:00:00.000Z' },
    ];
    for (const [i, row] of rows.entries()) {
      recordCall(t.state, {
        jobId: row.jobId,
        chunkIndex: i,
        model: row.model,
        startedAt: row.at,
        durationMs: 1000,
        exitCode: 0,
        ok: true,
      });
    }
    const byRepo = listCalls(t.state, { repo: 'a/b' });
    assert.equal(byRepo.length, 2);
    assert.ok(byRepo.every((c) => c.repo === 'a/b'));

    const byModel = listCalls(t.state, { model: 'glm-5.3' });
    assert.equal(byModel.length, 2);

    assert.equal(listCalls(t.state, { limit: 2 }).length, 2);
    assert.equal(listCalls(t.state, { repo: 'a/b', model: 'glm-5.3' }).length, 1);
    assert.equal(listCalls(t.state, { repo: 'x/y' }).length, 0);
  } finally {
    t.cleanup();
  }
});

test('recordCall 的 job_id 必须指向已存在的任务（外键约束）', () => {
  const t = openTmpState('glm-review-calls-fk');
  try {
    assert.throws(
      () =>
        recordCall(t.state, {
          jobId: 999,
          chunkIndex: 0,
          model: 'glm-5.3',
          startedAt: T0,
          durationMs: 1000,
          exitCode: 0,
          ok: true,
        }),
      /FOREIGN KEY/,
    );
    assert.equal(listCalls(t.state).length, 0);
  } finally {
    t.cleanup();
  }
});
