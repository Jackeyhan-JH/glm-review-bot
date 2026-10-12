/**
 * `glm-review usage` 命令层测试（#15 验收）：默认 / --json / --csv 三种输出、
 * --since（7d|24h|ISO，非法值退出码 2）、--until（只收 ISO）、--by、--plan、
 * 状态库缺失时的空报表，以及子命令自动发现。数据全部来自临时状态库的固定
 * 夹具（不碰真实 gh / claude / 网络）。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runCli } from '../../src/cli.ts';
import { command } from '../../src/commands/usage.ts';
import type { UsageReport } from '../../src/usage/report.ts';
import { createUsageHarness, FIXED_CALLS, type UsageHarness } from './helpers.ts';

/** 建好夹具的 harness：5 条调用、时钟停在 2026-10-13T06:00:00Z。 */
function seededHarness(prefix: string): UsageHarness {
  const h = createUsageHarness('2026-10-13T06:00:00.000Z', prefix);
  h.seed(FIXED_CALLS);
  return h;
}

async function runUsage(h: UsageHarness, argv: string[]): Promise<number> {
  h.reset();
  return command.run(argv, h.ctx);
}

function parseJson(h: UsageHarness): UsageReport {
  const out = h.stdout();
  assert.equal(out.endsWith('\n'), true, '输出应以换行结尾');
  assert.equal(out.indexOf('\n'), out.length - 1, '--json 只输出一行');
  return JSON.parse(out) as UsageReport;
}

test('默认输出：分组表、总计、两个窗口与红色高峰警告（退出码 0）', async () => {
  const h = seededHarness('glm-review-usage-human');
  try {
    assert.equal(await runUsage(h, []), 0);
    const out = h.stdout();
    assert.match(out, /用量报表（套餐：新版积分套餐，分组：日期）/);
    assert.match(out, /共 5 次调用/);
    assert.match(out, /2026-10-12/);
    assert.match(out, /2026-10-13/);
    assert.match(out, /总计/);
    assert.match(out, /近 5 小时（2026-10-13T01:00:00.000Z ～ 2026-10-13T06:00:00.000Z，左闭右开）：2 次调用/);
    assert.match(out, /近 7 天/);
    assert.match(out, /折合 3 prompt/);
    // 高峰期调用非 0：标红警告。
    assert.ok(out.includes('\x1b[31m'), '警告应带 ANSI 红色');
    assert.ok(out.includes('\x1b[0m'), '红色应复位');
    assert.match(out, /⚠ 高峰期调用 1 次（理应为 0）/);
    assert.equal(h.stderr(), '');
  } finally {
    h.cleanup();
  }
});

test('--json：单行可解析，数值与报表一致', async () => {
  const h = seededHarness('glm-review-usage-json');
  try {
    assert.equal(await runUsage(h, ['--json']), 0);
    const report = parseJson(h);
    assert.equal(report.totals.calls, 5);
    assert.equal(report.totals.okCalls, 3);
    assert.equal(report.totals.failedCalls, 2);
    assert.equal(report.totals.inputTokens, 4800);
    assert.equal(report.totals.outputTokens, 1200);
    assert.equal(report.totals.costUsd, 0.036);
    assert.equal(report.totals.prompts, 3);
    assert.equal(report.totals.peakCalls, 1);
    assert.equal(report.groups.length, 2);
    assert.equal(report.window5h.calls, 2);
    assert.equal(report.window7d.calls, 5);
    assert.equal(report.planId, 'new');
    assert.equal(report.warnings.length, 1);
    assert.equal(report.since, null);
    assert.equal(report.until, null);
    assert.equal(report.generatedAt, '2026-10-13T06:00:00.000Z');
  } finally {
    h.cleanup();
  }
});

test('--csv：带表头、列数一致、数值正确，含总计与两个窗口行', async () => {
  const h = seededHarness('glm-review-usage-csv');
  try {
    assert.equal(await runUsage(h, ['--csv']), 0);
    const lines = h.stdout().trimEnd().split('\n');
    assert.equal(lines[0], '日期,调用次数,成功次数,失败次数,成功率,平均耗时ms,总耗时ms,输入token,输出token,费用usd,折合prompt,高峰调用次数');
    for (const line of lines) {
      assert.equal(line.split(',').length, 12, `列数应为 12：${line}`);
    }
    // 分组行（数值逐项）。
    assert.ok(lines.includes('2026-10-12,3,2,1,0.6667,45000,135000,2500,400,0.016,2,1'));
    assert.ok(lines.includes('2026-10-13,2,1,1,0.5,55000,110000,2300,800,0.02,1,0'));
    assert.ok(lines.includes('总计,5,3,2,0.6,49000,245000,4800,1200,0.036,3,1'));
    assert.ok(lines.includes('近5小时,2,1,1,0.5,55000,110000,2300,800,0.02,1,0'));
    assert.ok(lines.includes('近7天,5,3,2,0.6,49000,245000,4800,1200,0.036,3,1'));
    // 警告走 stderr（不混进 CSV）。
    assert.match(h.stderr(), /高峰期调用 1 次/);
    assert.ok(!h.stdout().includes('高峰期调用'), 'CSV 主体不含警告文案');
  } finally {
    h.cleanup();
  }
});

test('--by repo / model：分组键与表头切换', async () => {
  const h = seededHarness('glm-review-usage-by');
  try {
    assert.equal(await runUsage(h, ['--by', 'repo', '--csv']), 0);
    assert.match(h.stdout(), /^仓库,/);
    assert.ok(h.stdout().includes('Jackeyhan-JH/glm-toolbox,3,1,2,0.3333,51667,155000,2800,800,0.02,1.5,0'));
    assert.ok(h.stdout().includes('Jackeyhan-JH/split-bill,2,2,0,1,45000,90000,2000,400,0.016,1.5,1'));

    const h2 = seededHarness('glm-review-usage-by-model');
    try {
      assert.equal(await runUsage(h2, ['--by', 'model', '--csv']), 0);
      assert.match(h2.stdout(), /^模型,/);
      assert.ok(h2.stdout().includes('glm-5.3,3,2,1,0.6667,65000,195000,3700,1100,0.032,1.5,0'));
      assert.ok(h2.stdout().includes('glm-5.3-flash,2,1,1,0.5,25000,50000,1100,100,0.004,1.5,1'));
    } finally {
      h2.cleanup();
    }
  } finally {
    h.cleanup();
  }
});

test('--plan：三种套餐的折合 prompt 数与套餐名展示', async () => {
  const h = seededHarness('glm-review-usage-plan');
  try {
    assert.equal(await runUsage(h, ['--plan', 'new', '--json']), 0);
    assert.equal(parseJson(h).totals.prompts, 3);

    assert.equal(await runUsage(h, ['--plan', 'v2-glm-5.3', '--json']), 0);
    const v2 = parseJson(h);
    assert.equal(v2.planId, 'v2-glm-5.3');
    assert.equal(v2.planName, '历史 V2 · GLM-5.3');
    assert.equal(v2.totals.prompts, 4.6);
    assert.equal(v2.window7d.prompts, 4.6);

    assert.equal(await runUsage(h, ['--plan', 'v2-glm-5.3-flash', '--json']), 0);
    const v2f = parseJson(h);
    assert.equal(v2f.planId, 'v2-glm-5.3-flash');
    assert.equal(v2f.totals.prompts, 4.6, '已知模型按模型选行，两个 V2 套餐一致');

    assert.equal(await runUsage(h, ['--plan', 'v2-glm-5.3']), 0);
    assert.match(h.stdout(), /套餐：历史 V2 · GLM-5.3/);
    assert.match(h.stdout(), /折合 4\.6 prompt/);
  } finally {
    h.cleanup();
  }
});

test('--since 7d / 24h / ISO：范围生效且展示在统计范围里', async () => {
  const h = seededHarness('glm-review-usage-since');
  try {
    assert.equal(await runUsage(h, ['--since', '7d', '--json']), 0);
    let report = parseJson(h);
    assert.equal(report.since, '2026-10-06T06:00:00.000Z');
    assert.equal(report.totals.calls, 5, '夹具全部落在近 7 天');
    assert.equal(report.window7d.calls, 5);

    assert.equal(await runUsage(h, ['--since', '24h', '--json']), 0);
    report = parseJson(h);
    assert.equal(report.since, '2026-10-12T06:00:00.000Z');
    assert.equal(report.totals.calls, 4, '排除 10-12 06:00 之前的一条');
    assert.equal(report.groups.length, 2);

    assert.equal(
      await runUsage(h, ['--since', '2026-10-13T00:00:00Z', '--until', '2026-10-13T03:30:00Z', '--json']),
      0,
    );
    report = parseJson(h);
    assert.equal(report.since, '2026-10-13T00:00:00.000Z');
    assert.equal(report.until, '2026-10-13T03:30:00.000Z');
    assert.equal(report.totals.calls, 2, '闭区间：两端边界各计入一条');
    assert.equal(report.window7d.calls, 5, '窗口不受 since/until 影响');

    assert.equal(await runUsage(h, ['--since', '7d']), 0);
    assert.match(h.stdout(), /统计范围：2026-10-06T06:00:00\.000Z ～ /);
  } finally {
    h.cleanup();
  }
});

test('--since / --until / --by / --plan 非法取值：中文报错、退出码 2', async () => {
  const cases: Array<[string[], RegExp]> = [
    [['--since', 'abc'], /无效的 --since 取值：abc/],
    [['--since', '7x'], /无效的 --since 取值：7x/],
    [['--since', '7'], /无效的 --since 取值：7/],
    [['--since', '2026-13-01'], /无效的 --since 取值：2026-13-01/],
    [['--until', '7d'], /无效的时间取值：7d/],
    [['--until', '昨天'], /无效的时间取值：昨天/],
    [['--by', 'week'], /无效的 --by 取值：week/],
    [['--plan', 'bogus'], /无效的 --plan 取值：bogus/],
    [['--json', '--csv'], /--json 与 --csv 不能同时使用/],
    [['多余参数'], /多余的参数：多余参数/],
    [['--unknown'], /未知选项：--unknown/],
  ];
  for (const [argv, pattern] of cases) {
    const h = seededHarness('glm-review-usage-invalid');
    try {
      assert.equal(await runUsage(h, argv), 2, `应退出码 2：${argv.join(' ')}`);
      assert.match(h.stderr(), pattern);
      assert.equal(h.stdout(), '', `不应有 stdout：${argv.join(' ')}`);
    } finally {
      h.cleanup();
    }
  }
});

test('--since 缺少取值：ArgError 也按退出码 2 处理', async () => {
  const h = seededHarness('glm-review-usage-noval');
  try {
    assert.equal(await runUsage(h, ['--since']), 2);
    assert.match(h.stderr(), /缺少取值/);
  } finally {
    h.cleanup();
  }
});

test('状态库不存在：空报表、stderr 提示、仍退出码 0', async () => {
  const h = createUsageHarness('2026-10-13T06:00:00.000Z', 'glm-review-usage-nodb');
  try {
    assert.equal(await runUsage(h, []), 0);
    assert.match(h.stdout(), /共 0 次调用/);
    assert.match(h.stderr(), /状态库不存在/);

    assert.equal(await runUsage(h, ['--json']), 0);
    const report = parseJson(h);
    assert.equal(report.totals.calls, 0);
    assert.deepEqual(report.groups, []);
    assert.deepEqual(report.warnings, []);
  } finally {
    h.cleanup();
  }
});

test('usage 子命令可被 cli 自动发现并列入 help', async () => {
  const h = createUsageHarness('2026-10-13T06:00:00.000Z', 'glm-review-usage-help');
  try {
    assert.equal(await runCli(['help'], { ctx: h.ctx }), 0);
    assert.match(h.stdout(), /usage\s+用量报表/);
  } finally {
    h.cleanup();
  }
});
