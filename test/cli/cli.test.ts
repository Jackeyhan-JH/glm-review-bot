import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync } from 'node:fs';
import { test } from 'node:test';
import path from 'node:path';
import { loadCommands, runCli } from '../../src/cli.ts';
import { createTestContext } from '../helpers/ctx.ts';
import { createTmpEnv } from '../helpers/tmp.ts';

const realCommandsDir = path.join(import.meta.dirname, '..', '..', 'src', 'commands');

test('help 列出 help 与 version 子命令（含中文摘要）', async () => {
  const t = createTestContext();
  try {
    const code = await runCli(['help'], { ctx: t.ctx });
    assert.equal(code, 0);
    assert.match(t.stdout(), /help\s+显示帮助/);
    assert.match(t.stdout(), /version\s+显示版本号/);
  } finally {
    t.cleanup();
  }
});

test('无参数与 -h 同样列出全部子命令', async () => {
  const t = createTestContext();
  try {
    assert.equal(await runCli([], { ctx: t.ctx }), 0);
    assert.match(t.stdout(), /子命令：/);
    const t2 = createTestContext();
    try {
      assert.equal(await runCli(['-h'], { ctx: t2.ctx }), 0);
      assert.match(t2.stdout(), /version/);
    } finally {
      t2.cleanup();
    }
  } finally {
    t.cleanup();
  }
});

test('help version 显示该子命令详细用法', async () => {
  const t = createTestContext();
  try {
    const code = await runCli(['help', 'version'], { ctx: t.ctx });
    assert.equal(code, 0);
    assert.match(t.stdout(), /用法：glm-review version/);
  } finally {
    t.cleanup();
  }
});

test('version 输出 glm-review-bot 与 package.json 版本号', async () => {
  const t = createTestContext();
  try {
    const code = await runCli(['version'], { ctx: t.ctx });
    assert.equal(code, 0);
    assert.equal(t.stdout(), 'glm-review-bot 0.1.0\n');
  } finally {
    t.cleanup();
  }
});

test('未知子命令：stderr 中文报错，退出码 2', async () => {
  const t = createTestContext();
  try {
    const code = await runCli(['nope'], { ctx: t.ctx });
    assert.equal(code, 2);
    assert.match(t.stderr(), /未知子命令：nope/);
    assert.match(t.stderr(), /glm-review help/);
  } finally {
    t.cleanup();
  }
});

test('子命令抛出的未捕获异常：中文错误，退出码 1', async () => {
  const tmp = createTmpEnv('glm-review-cmd-error-test');
  const dir = path.join(tmp.baseDir, 'commands');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, 'boom.ts'),
    [
      'export const command = {',
      "  name: 'boom',",
      "  summary: '测试用：抛异常',",
      "  usage: 'glm-review boom',",
      '  async run(): Promise<number> {',
      "    throw new Error('模拟失败');",
      '  },',
      '};',
      '',
    ].join('\n'),
  );
  const t = createTestContext();
  try {
    const code = await runCli(['boom'], { ctx: t.ctx, commandsDir: dir });
    assert.equal(code, 1);
    assert.match(t.stderr(), /执行出错：模拟失败/);
  } finally {
    t.cleanup();
    tmp.cleanup();
  }
});

test('向注入的命令目录临时新增文件即成为新子命令，无需改其他文件', async () => {
  const tmp = createTmpEnv('glm-review-autodiscover-test');
  const dir = path.join(tmp.baseDir, 'commands');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, 'greet.ts'),
    [
      'export const command = {',
      "  name: 'greet',",
      "  summary: '测试用临时子命令',",
      "  usage: 'glm-review greet [名字]',",
      '  async run(argv: string[], ctx: { stdout: (text: string) => void }): Promise<number> {',
      "    ctx.stdout(`你好，${argv[0] ?? '世界'}\\n`);",
      '    return 0;',
      '  },',
      '};',
      '',
    ].join('\n'),
  );
  const t = createTestContext();
  try {
    // help 列出新命令
    assert.equal(await runCli(['help'], { ctx: t.ctx, commandsDir: dir }), 0);
    assert.match(t.stdout(), /greet\s+测试用临时子命令/);
    // 直接运行新命令
    assert.equal(await runCli(['greet', 'GLM'], { ctx: t.ctx, commandsDir: dir }), 0);
    assert.match(t.stdout(), /你好，GLM/);
    // 真实 src/commands 不受临时目录影响
    const commands = await loadCommands(realCommandsDir);
    assert.ok(commands.has('version'));
    assert.ok(!commands.has('greet'));
  } finally {
    t.cleanup();
    tmp.cleanup();
  }
});

test('加载失败的命令文件被跳过，不影响其余子命令', async () => {
  const tmp = createTmpEnv('glm-review-badcmd-test');
  const dir = path.join(tmp.baseDir, 'commands');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'broken.ts'), 'throw new Error("语法外的运行时错误");\n');
  writeFileSync(
    path.join(dir, 'fine.ts'),
    [
      'export const command = {',
      "  name: 'fine',",
      "  summary: '正常命令',",
      "  usage: 'glm-review fine',",
      '  async run(_argv: unknown, ctx: { stdout: (t: string) => void }): Promise<number> {',
      "    ctx.stdout('fine\\n');",
      '    return 0;',
      '  },',
      '};',
      '',
    ].join('\n'),
  );
  const t = createTestContext();
  try {
    const code = await runCli(['fine'], { ctx: t.ctx, commandsDir: dir });
    assert.equal(code, 0);
    assert.equal(t.stdout(), 'fine\n');
  } finally {
    t.cleanup();
    tmp.cleanup();
  }
});
