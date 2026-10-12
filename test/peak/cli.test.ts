/**
 * `glm-review peak` 子命令测试：走真实 src/commands/peak.ts，
 * 输出捕获、时钟注入，全部在进程内完成，不碰真实网络 / gh / claude。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runCli } from '../../src/cli.ts';
import { fixedClock } from '../../src/lib/clock.ts';
import { exec } from '../../src/lib/exec.ts';
import { nullLogger } from '../../src/lib/log.ts';
import { resolvePaths } from '../../src/lib/paths.ts';
import type { CliContext } from '../../src/lib/types.ts';
import { createTmpEnv } from '../helpers/tmp.ts';

/** 自建上下文（时钟停在 clockIso），便于验证默认 --now 取自注入的时钟。 */
function makeCtx(clockIso: string): {
  ctx: CliContext;
  stdout(): string;
  stderr(): string;
  cleanup(): void;
} {
  const tmp = createTmpEnv('glm-review-peak-cli');
  let out = '';
  let err = '';
  const ctx: CliContext = {
    deps: {
      exec,
      clock: fixedClock(clockIso),
      env: tmp.env,
      paths: resolvePaths(tmp.env),
      log: nullLogger,
    },
    stdout: (text) => {
      out += text;
    },
    stderr: (text) => {
      err += text;
    },
  };
  return { ctx, stdout: () => out, stderr: () => err, cleanup: tmp.cleanup };
}

test('peak --json：高峰中输出单行 JSON（验收样例）', async () => {
  const t = makeCtx('2026-10-12T00:00:00Z');
  try {
    const code = await runCli(['peak', '--now', '2026-10-12T07:00:00Z', '--json'], { ctx: t.ctx });
    assert.equal(code, 0);
    assert.equal(t.stderr(), '');
    assert.equal(
      t.stdout(),
      '{"peak":true,"nextSwitch":"2026-10-12T10:00:00.000Z","msUntilSwitch":10800000}\n',
    );
  } finally {
    t.cleanup();
  }
});

test('peak --json：非高峰输出与键顺序（peak、nextSwitch、msUntilSwitch）', async () => {
  const t = makeCtx('2026-10-12T00:00:00Z');
  try {
    const code = await runCli(['peak', '--now', '2026-10-12T11:00:00Z', '--json'], { ctx: t.ctx });
    assert.equal(code, 0);
    assert.equal(
      t.stdout(),
      '{"peak":false,"nextSwitch":"2026-10-13T06:00:00.000Z","msUntilSwitch":68400000}\n',
    );
    // 键顺序与 glm-peak-clock CLI 一致，便于脚本比对
    assert.deepEqual(Object.keys(JSON.parse(t.stdout())), ['peak', 'nextSwitch', 'msUntilSwitch']);
  } finally {
    t.cleanup();
  }
});

test('peak 不带 --now：默认取注入时钟的当前时间', async () => {
  // 时钟停在 2026-10-15T18:30:00Z（北京周五 02:30，非高峰）→ 下一次切换周五 14:00
  const t = makeCtx('2026-10-15T18:30:00Z');
  try {
    const code = await runCli(['peak', '--json'], { ctx: t.ctx });
    assert.equal(code, 0);
    const parsed = JSON.parse(t.stdout()) as { peak: boolean; nextSwitch: string; msUntilSwitch: number };
    assert.equal(parsed.peak, false);
    assert.equal(parsed.nextSwitch, '2026-10-16T06:00:00.000Z');
    assert.equal(parsed.msUntilSwitch, 11.5 * 3_600_000);
  } finally {
    t.cleanup();
  }
});

test('peak 人读输出：三行中文（现在 / 下一次切换双时区 / 距离切换）', async () => {
  const t = makeCtx('2026-10-12T00:00:00Z');
  try {
    const code = await runCli(['peak', '--now', '2026-10-12T07:00:00Z'], { ctx: t.ctx });
    assert.equal(code, 0);
    assert.equal(t.stderr(), '');
    assert.equal(
      t.stdout(),
      [
        '现在：高峰期',
        '下一次切换：10月12日 周一 06:00（America/New_York），北京时间 周一 18:00',
        '距离切换：3 小时 0 分',
        '',
      ].join('\n'),
    );
  } finally {
    t.cleanup();
  }
});

test('peak 人读输出：非高峰 + 距离超过一天时带「N 天」', async () => {
  const t = makeCtx('2026-10-12T00:00:00Z');
  try {
    const code = await runCli(['peak', '--now', '2026-10-16T19:23:45Z'], { ctx: t.ctx });
    assert.equal(code, 0);
    // 北京周六 03:23:45 → 下一次切换下周一 14:00（美东 02:00，与北京同日故北京部分省略日期）
    const lines = t.stdout().split('\n');
    assert.equal(lines[0], '现在：非高峰期');
    assert.match(lines[1] ?? '', /^下一次切换：10月19日 周一 02:00（America\/New_York），北京时间 周一 14:00$/);
    assert.equal(lines[2], '距离切换：2 天 10 小时 36 分');
  } finally {
    t.cleanup();
  }
});

test('peak --tz Asia/Shanghai：所选时区与北京时间相同', async () => {
  const t = makeCtx('2026-10-12T00:00:00Z');
  try {
    const code = await runCli(['peak', '--now', '2026-10-12T07:00:00Z', '--tz', 'Asia/Shanghai'], { ctx: t.ctx });
    assert.equal(code, 0);
    assert.match(t.stdout(), /下一次切换：10月12日 周一 18:00（Asia\/Shanghai），北京时间 周一 18:00/);
  } finally {
    t.cleanup();
  }
});

test('peak --tz 跨日时区：北京时间带日期前缀（檀香山比北京慢 18 小时）', async () => {
  const t = makeCtx('2026-10-12T00:00:00Z');
  try {
    // 北京周二 03:00（非高峰）→ 切换时刻 2026-10-13T06:00Z：檀香山还是周一 20:00
    const code = await runCli(['peak', '--now', '2026-10-12T19:00:00Z', '--tz', 'Pacific/Honolulu'], { ctx: t.ctx });
    assert.equal(code, 0);
    assert.match(
      t.stdout(),
      /下一次切换：10月12日 周一 20:00（Pacific\/Honolulu），北京时间 10月13日 周二 14:00/,
    );
  } finally {
    t.cleanup();
  }
});

test('peak 距离切换不足 1 分钟显示「不到 1 分」', async () => {
  const t = makeCtx('2026-10-12T00:00:00Z');
  try {
    const code = await runCli(['peak', '--now', '2026-10-12T05:59:30Z'], { ctx: t.ctx });
    assert.equal(code, 0);
    assert.match(t.stdout(), /距离切换：不到 1 分/);
  } finally {
    t.cleanup();
  }
});

test('peak 非法 --now / --tz / 未知选项 / 多余参数：stderr 中文报错，退出码 2', async () => {
  const cases: Array<[string[], RegExp]> = [
    [['peak', '--now', 'not-a-date', '--json'], /无效的 --now 取值/],
    [['peak', '--tz', 'Mars/Olympus'], /无效的 --tz 取值/],
    [['peak', '--plan', 'v2'], /未知选项：--plan/],
    [['peak', 'extra'], /多余的参数：extra/],
    [['peak', '--now'], /选项 --now 缺少取值/],
  ];
  for (const [argv, pattern] of cases) {
    const t = makeCtx('2026-10-12T00:00:00Z');
    try {
      const code = await runCli(argv, { ctx: t.ctx });
      assert.equal(code, 2, argv.join(' '));
      assert.match(t.stderr(), pattern, argv.join(' '));
      assert.match(t.stderr(), /用法：glm-review peak/, argv.join(' '));
      assert.equal(t.stdout(), '', argv.join(' '));
    } finally {
      t.cleanup();
    }
  }
});

test('help 自动列出 peak 子命令，help peak 显示用法', async () => {
  const t = makeCtx('2026-10-12T00:00:00Z');
  try {
    assert.equal(await runCli(['help'], { ctx: t.ctx }), 0);
    assert.match(t.stdout(), /peak\s+查看现在是不是 GLM 高峰期/);
    assert.equal(await runCli(['help', 'peak'], { ctx: t.ctx }), 0);
    assert.match(t.stdout(), /用法：glm-review peak \[--now <ISO>\] \[--tz <IANA>\] \[--json\]/);
  } finally {
    t.cleanup();
  }
});
