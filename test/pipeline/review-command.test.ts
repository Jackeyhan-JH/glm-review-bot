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

