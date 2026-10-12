/**
 * `glm-review status` 命令测试（验收标准第 2 条后半）：默认文本输出、
 * `--json` 可解析、参数校验（未知选项 / 非法端口 / 多余参数）。
 * 配置文件指向临时目录（pauseFile 等不依赖真实机器状态），
 * 不启动 --serve（阻塞模式由 server.test.ts 覆盖其下层）。
 */
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { test } from 'node:test';
import { runCli } from '../../src/cli.ts';
import { createTestContext, type TestHarness } from '../helpers/ctx.ts';

/** 写一份最小全局配置，让 pauseFile 指向临时路径（避免读到真实 /workspace/GLM_PAUSE）。 */
function writeConfig(h: TestHarness, pauseFile: string): void {
  writeFileSync(
    h.tmp.configPath,
    [`pauseFile: ${pauseFile}`, 'statusPort: 43140', 'pollIntervalSec: 120', ''].join('\n'),
  );
}

test('status：默认输出中文文本状态', async () => {
  const t = createTestContext();
  try {
    writeConfig(t, `${t.tmp.baseDir}/GLM_PAUSE`);
    const code = await runCli(['status'], { ctx: t.ctx });
    assert.equal(code, 0);
    assert.match(t.stdout(), /^GLM 审查机器人状态/);
    assert.match(t.stdout(), /守护进程：未运行或无心跳/);
    assert.match(t.stdout(), /任务统计：排队 0 · 延后 0 · 进行中 0 · 完成 0 · 失败 0 · 跳过 0/);
    assert.match(t.stdout(), /等待队列：空/);
    assert.match(t.stdout(), /最近审查：还没有记录/);
    assert.match(t.stdout(), /GLM 高峰：当前非高峰期/); // 测试时钟：周一北京时间 08:00
  } finally {
    t.cleanup();
  }
});

test('status --json：输出一行可解析的 JSON 快照', async () => {
  const t = createTestContext();
  try {
    writeConfig(t, `${t.tmp.baseDir}/GLM_PAUSE`);
    const code = await runCli(['status', '--json'], { ctx: t.ctx });
    assert.equal(code, 0);
    const lines = t.stdout().trim().split('\n');
    assert.equal(lines.length, 1, '应只输出一行 JSON');
    const snapshot = JSON.parse(lines[0] ?? '') as {
      generatedAt: string;
      jobs: Record<string, number>;
      queue: unknown[];
      recentReviews: unknown[];
      usage: { today: { calls: number }; last7d: { calls: number } };
      peak: { isPeak: boolean; nextSwitchBeijing: string; nextSwitchNewYork: string };
      heartbeat: { present: boolean };
      paused: boolean;
    };
    assert.equal(snapshot.generatedAt, '2026-10-12T00:00:00.000Z');
    assert.deepEqual(snapshot.jobs, {
      queued: 0,
      deferred: 0,
      running: 0,
      done: 0,
      failed: 0,
      skipped: 0,
    });
    assert.deepEqual(snapshot.queue, []);
    assert.deepEqual(snapshot.recentReviews, []);
    assert.equal(snapshot.usage.today.calls, 0);
    assert.equal(snapshot.heartbeat.present, false);
    assert.equal(snapshot.paused, false);
    // 双时区字段都在。
    assert.equal(snapshot.peak.isPeak, false);
    assert.equal(typeof snapshot.peak.nextSwitchBeijing, 'string');
    assert.equal(typeof snapshot.peak.nextSwitchNewYork, 'string');
  } finally {
    t.cleanup();
  }
});

test('status：未知选项 / 非法端口 / 多余参数都退出码 2', async () => {
  const t = createTestContext();
  try {
    writeConfig(t, `${t.tmp.baseDir}/GLM_PAUSE`);

    const unknown = await runCli(['status', '--nope'], { ctx: t.ctx });
    assert.equal(unknown, 2);
    assert.match(t.stderr(), /未知选项：--nope/);

    const badPort = await runCli(['status', '--port', 'abc'], { ctx: t.ctx });
    assert.equal(badPort, 2);
    assert.match(t.stderr(), /无效的 --port 取值/);

    const zeroPort = await runCli(['status', '--port', '0'], { ctx: t.ctx });
    assert.equal(zeroPort, 2);

    const bigPort = await runCli(['status', '--port', '99999'], { ctx: t.ctx });
    assert.equal(bigPort, 2);

    const stray = await runCli(['status', 'extra'], { ctx: t.ctx });
    assert.equal(stray, 2);
    assert.match(t.stderr(), /多余的参数：extra/);
  } finally {
    t.cleanup();
  }
});

test('help 列表自动发现 status 子命令', async () => {
  const t = createTestContext();
  try {
    const code = await runCli(['help'], { ctx: t.ctx });
    assert.equal(code, 0);
    assert.match(t.stdout(), /status\s+/);
    assert.match(t.stdout(), /查看机器人状态/);

    const detail = await runCli(['help', 'status'], { ctx: t.ctx });
    assert.equal(detail, 0);
    assert.match(t.stdout(), /glm-review status \[--json\] \[--serve \[--port <n>\]\]/);
  } finally {
    t.cleanup();
  }
});

test('status：全局配置非法时退出码 1 并给出中文错误', async () => {
  const t = createTestContext();
  try {
    writeFileSync(t.tmp.configPath, 'statusPort: 0\n');
    const code = await runCli(['status'], { ctx: t.ctx });
    assert.equal(code, 1);
    assert.match(t.stderr(), /全局配置校验失败/);
  } finally {
    t.cleanup();
  }
});
