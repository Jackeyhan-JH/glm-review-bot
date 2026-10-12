/**
 * `glm-review review` 命令层测试：白名单拦截、参数校验、阶段进度与结果输出
 * （--json 时进度走 stderr）。流水线本身的行为在 review.test.ts 覆盖。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runCli } from '../../src/cli.ts';
import { fixedClock } from '../../src/lib/clock.ts';
import { resolvePaths } from '../../src/lib/paths.ts';
import { openState } from '../../src/state/db.ts';
import { listJobs } from '../../src/state/jobs.ts';
import { createFakeBin } from '../helpers/fakebin.ts';
import { createTmpEnv } from '../helpers/tmp.ts';
import {
  createCliHarness,
  createWorld,
  NON_PEAK_AT,
  PR_NO,
  REPO,
  REVIEW_URL,
  writeGlobalConfig,
} from './helpers.ts';

test('review：正常审查 → 退出码 0，输出阶段进度与 review 链接，任务落库', async () => {
  const w = createWorld();
  try {
    // 命令自己打开状态库；world 的 deps.state 不用，另建一个只装 fake 的上下文。
    const harness = createCliHarness(w.fake, w.tmp, w.clock);
    const code = await runCli(['review', REPO, String(PR_NO)], { ctx: harness.ctx });
    assert.equal(code, 0);
    const out = harness.stdout();
    assert.ok(out.includes('→ 获取 PR 信息'));
    assert.ok(out.includes('审查完成'));
    assert.ok(out.includes(REVIEW_URL));
    assert.ok(out.includes('2 条问题'));

    // 命令打开过的状态库里任务 done
    const paths = resolvePaths(harness.ctx.deps.env);
    const state = openState(paths.stateDb);
    try {
      const jobs = listJobs(state);
      assert.equal(jobs.length, 1);
      assert.equal(jobs[0]?.status, 'done');
      assert.equal(jobs[0]?.reviewUrl, REVIEW_URL);
    } finally {
      state.close();
    }
  } finally {
    w.cleanup();
  }
});

test('review --json：stdout 只有一行结果 JSON，阶段进度走 stderr', async () => {
  const w = createWorld();
  try {
    const harness = createCliHarness(w.fake, w.tmp, w.clock);
    const code = await runCli(['review', REPO, String(PR_NO), '--json'], { ctx: harness.ctx });
    assert.equal(code, 0);
    const lines = harness.stdout().trim().split('\n');
    assert.equal(lines.length, 1);
    const parsed = JSON.parse(lines[0] ?? '') as Record<string, unknown>;
    assert.equal(parsed.status, 'reviewed');
    assert.equal(parsed.url, REVIEW_URL);
    assert.equal(parsed.findingsCount, 2);
    assert.ok(harness.stderr().includes('→ '));
    assert.ok(!harness.stdout().includes('→ '));
  } finally {
    w.cleanup();
  }
});

test('review：不在白名单的仓库 → 退出码 2，--force 也不放行，不碰 gh', async () => {
  const fake = createFakeBin({ bins: ['gh', 'claude', 'git', 'pgrep'] });
  const tmp = createTmpEnv('glm-review-review-cmd-test');
  try {
    writeGlobalConfig(tmp); // 白名单只有 REPO
    const harness = createCliHarness(fake, tmp, fixedClock(NON_PEAK_AT));
    const code = await runCli(['review', 'other/repo', '12', '--force'], { ctx: harness.ctx });
    assert.equal(code, 2);
    assert.ok(harness.stderr().includes('不在白名单'));
    assert.equal(fake.calls().length, 0);
  } finally {
    fake.remove();
    tmp.cleanup();
  }
});

test('review：参数错误 → 退出码 2', async () => {
  const fake = createFakeBin({ bins: ['gh', 'claude', 'git', 'pgrep'] });
  const tmp = createTmpEnv('glm-review-review-cmd-test');
  try {
    writeGlobalConfig(tmp);
    const harness = createCliHarness(fake, tmp, fixedClock(NON_PEAK_AT));
    const cases: string[][] = [
      ['review'],
      ['review', REPO],
      ['review', REPO, String(PR_NO), '多余'],
      ['review', '不是仓库', String(PR_NO)],
      ['review', REPO, 'abc'],
      ['review', REPO, String(PR_NO), '--wat'],
    ];
    for (const argv of cases) {
      const code = await runCli(argv, { ctx: harness.ctx });
      assert.equal(code, 2, `参数 ${JSON.stringify(argv)} 应退出码 2`);
      assert.ok(harness.stderr().includes('错误'), `参数 ${JSON.stringify(argv)} 应有错误提示`);
    }
  } finally {
    fake.remove();
    tmp.cleanup();
  }
});

test('review --dry-run：输出 dry-run 预览，退出码 0，不发 POST', async () => {
  const w = createWorld();
  try {
    const harness = createCliHarness(w.fake, w.tmp, w.clock);
    const code = await runCli(['review', REPO, String(PR_NO), '--dry-run'], { ctx: harness.ctx });
    assert.equal(code, 0);
    const out = harness.stdout();
    assert.ok(out.includes('dry-run 预览完成'));
    assert.ok(out.includes('dry-run 预览：以下内容不会发送到 GitHub'));
    assert.equal(w.postCalls().length, 0);
  } finally {
    w.cleanup();
  }
});

test('review：高峰期 → 退出码 0，输出排队时间（北京时间与美东时间）', async () => {
  const w = createWorld({ clockAt: '2026-10-12T07:00:00Z' });
  try {
    const harness = createCliHarness(w.fake, w.tmp, w.clock);
    const code = await runCli(['review', REPO, String(PR_NO)], { ctx: harness.ctx });
    assert.equal(code, 0);
    const out = harness.stdout();
    assert.ok(out.includes('高峰期'));
    assert.ok(out.includes('北京时间'));
    assert.ok(out.includes('美东时间'));
    assert.ok(out.includes('10-12 18:00') || out.includes('10/12 18:00'));
    assert.equal(w.claudeCalls().length, 0);
  } finally {
    w.cleanup();
  }
});

test('review：审查失败 → 退出码 1，错误走 stderr', async () => {
  const w = createWorld({ claude: { code: 1, stderr: 'Error: service unavailable (503)' } });
  try {
    const harness = createCliHarness(w.fake, w.tmp, w.clock);
    const code = await runCli(['review', REPO, String(PR_NO)], { ctx: harness.ctx });
    assert.equal(code, 1);
    assert.ok(harness.stderr().includes('审查失败'));
    assert.equal(w.postCalls().length, 0);
  } finally {
    w.cleanup();
  }
});

/** 打开命令用的状态库（命令每次运行自己 open / close，这里只读）。 */
function openCommandState(harness: ReturnType<typeof createCliHarness>) {
  return openState(resolvePaths(harness.ctx.deps.env).stateDb);
}

test('review：同一任务连续失败 3 次 → 每次由调用方记一次失败，第 3 次后终态 failed（#33）', async () => {
  const w = createWorld({ claude: { code: 1, stderr: 'Error: service unavailable (503)' } });
  try {
    const harness = createCliHarness(w.fake, w.tmp, w.clock);
    for (let round = 1; round <= 3; round++) {
      const code = await runCli(['review', REPO, String(PR_NO)], { ctx: harness.ctx });
      assert.equal(code, 1, `第 ${round} 次失败应退出码 1`);
      const state = openCommandState(harness);
      try {
        const jobs = listJobs(state);
        assert.equal(jobs.length, 1); // 同键只有一行任务
        const job = jobs[0];
        assert.ok(job !== undefined);
        // 领取与失败记录都在调用方：attempts 每轮 +1，不再恒为 0
        assert.equal(job.attempts, round, `第 ${round} 次失败后 attempts 应为 ${round}`);
        if (round < 3) {
          assert.equal(job.status, 'queued', `第 ${round} 次失败未达上限，应回队列`);
          assert.equal(job.startedAt, null);
          assert.ok(job.reason !== null && job.reason.includes('claude'));
        } else {
          assert.equal(job.status, 'failed', '第 3 次失败达重试上限，应终态 failed');
          assert.ok(job.finishedAt !== null);
        }
      } finally {
        state.close();
      }
    }
    assert.ok(harness.stderr().includes('审查失败'));
    assert.ok(harness.stderr().includes('回到队列'));
    assert.ok(harness.stderr().includes('已达重试上限'));
    assert.equal(w.postCalls().length, 0); // 始终不发半截 review
  } finally {
    w.cleanup();
  }
});

test('review：失败一次 → attempts=1、按第一档退避把 not_before 推后 60 秒', async () => {
  const w = createWorld({ claude: { code: 1, stderr: 'Error: service unavailable (503)' } });
  try {
    const harness = createCliHarness(w.fake, w.tmp, w.clock);
    const code = await runCli(['review', REPO, String(PR_NO)], { ctx: harness.ctx });
    assert.equal(code, 1);
    const state = openCommandState(harness);
    try {
      const job = listJobs(state)[0];
      assert.ok(job !== undefined);
      assert.equal(job.status, 'queued');
      assert.equal(job.attempts, 1);
      assert.equal(job.startedAt, null);
      // NON_PEAK_AT（00:00:00Z）+ 第一档退避 60s
      assert.equal(job.notBefore, '2026-10-12T00:01:00.000Z');
    } finally {
      state.close();
    }
  } finally {
    w.cleanup();
  }
});

test('review：闸门未通过（waiting）→ 领取的任务放回 queued，不卡在 running（#33）', async () => {
  const w = createWorld({ paused: true });
  try {
    const harness = createCliHarness(w.fake, w.tmp, w.clock);
    const code = await runCli(['review', REPO, String(PR_NO)], { ctx: harness.ctx });
    assert.equal(code, 0);
    assert.ok(harness.stdout().includes('暂不启动审查'));
    const state = openCommandState(harness);
    try {
      const job = listJobs(state)[0];
      assert.ok(job !== undefined);
      assert.equal(job.status, 'queued'); // 领取过但闸门未过：放回队列
      assert.equal(job.startedAt, null);
      assert.equal(job.attempts, 1);
    } finally {
      state.close();
    }
  } finally {
    w.cleanup();
  }
});

test('review --dry-run：预览后任务放回 queued（不卡 running、不占去重键），再真实跑可发布（#33）', async () => {
  const w = createWorld();
  try {
    const harness = createCliHarness(w.fake, w.tmp, w.clock);
    const code = await runCli(['review', REPO, String(PR_NO), '--dry-run'], { ctx: harness.ctx });
    assert.equal(code, 0);
    const state = openCommandState(harness);
    try {
      const job = listJobs(state)[0];
      assert.ok(job !== undefined);
      assert.equal(job.status, 'queued');
      assert.equal(job.startedAt, null);
      assert.equal(job.attempts, 1);
    } finally {
      state.close();
    }

    // 同一任务行再真实跑一次：正常发布并标记 done
    const second = await runCli(['review', REPO, String(PR_NO)], { ctx: harness.ctx });
    assert.equal(second, 0);
    assert.equal(w.postCalls().length, 1);
    const state2 = openCommandState(harness);
    try {
      const job = listJobs(state2)[0];
      assert.ok(job !== undefined);
      assert.equal(job.status, 'done');
      assert.equal(job.reviewUrl, REVIEW_URL);
    } finally {
      state2.close();
    }
  } finally {
    w.cleanup();
  }
});

