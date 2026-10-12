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
  PEAK_AT,
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

test('review：闸门未通过（waiting）→ 领取的任务退回（queued、attempts 归还），不卡在 running（#35 复审 A）', async () => {
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
      assert.equal(job.attempts, 0); // 没真正审查，不占失败次数
    } finally {
      state.close();
    }
  } finally {
    w.cleanup();
  }
});

test('review --dry-run：预览后任务退回（queued、不卡 running、不占去重键与失败次数），再真实跑可发布（#35 复审 A）', async () => {
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
      assert.equal(job.attempts, 0); // 预览不占失败次数
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

test('review：高峰期连续跑 3 次不扣 attempts，峰后第一次真实失败 attempts=1 并回队列（#35 复审 A）', async () => {
  const w = createWorld({ claude: { code: 1, stderr: 'Error: service unavailable (503)' }, clockAt: PEAK_AT });
  try {
    const harness = createCliHarness(w.fake, w.tmp, w.clock);
    for (let round = 1; round <= 3; round++) {
      const code = await runCli(['review', REPO, String(PR_NO)], { ctx: harness.ctx });
      assert.equal(code, 0, `高峰第 ${round} 次应退出码 0（排队到峰后）`);
      const state = openCommandState(harness);
      try {
        const jobs = listJobs(state);
        assert.equal(jobs.length, 1);
        const job = jobs[0];
        assert.ok(job !== undefined);
        assert.equal(job.status, 'deferred');
        assert.equal(job.attempts, 0, `高峰第 ${round} 次没真正审查，attempts 应退回 0`);
        assert.equal(job.startedAt, null);
        assert.equal(job.notBefore, '2026-10-12T10:00:00.000Z'); // 排队到北京 18:00
      } finally {
        state.close();
      }
    }
    assert.equal(w.claudeCalls().length, 0); // 高峰期绝不调 claude

    // 峰后（10:00Z，本段高峰右开）第一次真实运行失败：attempts=1、回队列按第一档退避
    w.clock.set('2026-10-12T10:00:00Z');
    const code = await runCli(['review', REPO, String(PR_NO)], { ctx: harness.ctx });
    assert.equal(code, 1);
    const state = openCommandState(harness);
    try {
      const job = listJobs(state)[0];
      assert.ok(job !== undefined);
      assert.equal(job.status, 'queued');
      assert.equal(job.attempts, 1);
      assert.equal(job.startedAt, null);
      assert.equal(job.notBefore, '2026-10-12T10:01:00.000Z');
      assert.ok(job.reason !== null && job.reason.includes('claude'));
    } finally {
      state.close();
    }
  } finally {
    w.cleanup();
  }
});

test('review：getDiff 抛错（HTTP 502）→ 任务不卡 running，调用方记一次失败并按退避回队列（#35 复审 B）', async () => {
  const w = createWorld({ diff: { code: 1, stderr: 'gh: HTTP 502 Bad Gateway' } });
  try {
    const harness = createCliHarness(w.fake, w.tmp, w.clock);
    const code = await runCli(['review', REPO, String(PR_NO)], { ctx: harness.ctx });
    assert.equal(code, 1); // 异常由 CLI 兜底：中文错误 + 退出码 1
    assert.ok(harness.stderr().includes('执行出错'));
    assert.equal(w.claudeCalls().length, 0);
    assert.equal(w.postCalls().length, 0);

    const state = openCommandState(harness);
    try {
      const job = listJobs(state)[0];
      assert.ok(job !== undefined);
      assert.notEqual(job.status, 'running'); // 不能卡在 running
      assert.equal(job.status, 'queued'); // 记一次失败后按重试策略回队列
      assert.equal(job.attempts, 1);
      assert.equal(job.startedAt, null);
      assert.equal(job.notBefore, '2026-10-12T00:01:00.000Z');
      assert.ok(job.reason !== null && job.reason.length > 0);
    } finally {
      state.close();
    }
  } finally {
    w.cleanup();
  }
});

test('review：终态 failed 的任务重跑需 --force，否则提示并退出、不调 claude（#35 复审建议）', async () => {
  const w = createWorld({ claude: { code: 1, stderr: 'Error: service unavailable (503)' } });
  try {
    const harness = createCliHarness(w.fake, w.tmp, w.clock);
    for (let round = 1; round <= 3; round++) {
      await runCli(['review', REPO, String(PR_NO)], { ctx: harness.ctx });
    }
    const state = openCommandState(harness);
    try {
      assert.equal(listJobs(state)[0]?.status, 'failed');
    } finally {
      state.close();
    }
    const claudeAfterFailed = w.claudeCalls().length;

    const code = await runCli(['review', REPO, String(PR_NO)], { ctx: harness.ctx });
    assert.equal(code, 1);
    assert.ok(harness.stderr().includes('终态 failed'));
    assert.ok(harness.stderr().includes('--force'));
    assert.equal(w.claudeCalls().length, claudeAfterFailed); // 没有静默重审
    const state2 = openCommandState(harness);
    try {
      assert.equal(listJobs(state2)[0]?.status, 'failed'); // 状态不变
    } finally {
      state2.close();
    }
  } finally {
    w.cleanup();
  }
});

