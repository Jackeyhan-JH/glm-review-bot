/**
 * #39 回归：优雅退出不得被滞留的计时器占住事件循环。
 *
 * 1. 睡眠窗口内收到 SIGTERM：race 先行唤醒后必须取消两轮之间的睡眠 setTimeout，
 *    进程立即退出（cli.ts 只置 process.exitCode，靠事件循环排空自然退出）；
 *    修复前进程要等 pollIntervalSec 走满才退出（daemon.sh stop 90 秒等不到）。
 * 2. 审查在跑时收到 SIGTERM、审查在宽限内完成：defaultGraceWaiter 的限时计时器
 *    必须清理，进程随审查完成立即退出而不是占满 claude.timeoutSec。
 *
 * 全程 fake gh / claude（PATH 指向 fakebin），真实子进程 + 真实信号，只用本地时间断言
 * 「远小于滞留时长」；peak 关闭，不依赖测试机的真实时钟是否高峰。
 */
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { defaultGraceWaiter } from '../../src/daemon/worker.ts';
import { listJobs } from '../../src/state/jobs.ts';
import { claudeEnvelope, createDaemonWorld, PR_A, REPO_A, SHA_A1 } from './helpers.ts';

const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** 轮询等待条件成立（100ms 一次）；超时抛错并附带诊断文本。 */
async function waitUntil(what: string, check: () => boolean, timeoutMs: number, diagnose: () => string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (check()) return;
    if (Date.now() > deadline) {
      throw new Error(`等待超时：${what}\n诊断：${diagnose()}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/** 等子进程退出并返回 { 退出码, 耗时 }（close：stdio 已排空）；超时杀掉后抛错。 */
async function waitForExit(child: ChildProcess, timeoutMs: number): Promise<{ code: number | null; elapsedMs: number }> {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`子进程 ${child.pid} ${timeoutMs}ms 内未退出`));
    }, timeoutMs);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, elapsedMs: Date.now() - startedAt });
    });
  });
}

/** 收集子进程的 stdout+stderr（字符串是不可变的，须经 getter 取最新内容）。 */
function capture(child: ChildProcess): { text(): string } {
  const chunks: string[] = [];
  child.stdout?.on('data', (chunk) => chunks.push(String(chunk)));
  child.stderr?.on('data', (chunk) => chunks.push(String(chunk)));
  return { text: () => chunks.join('') };
}

/** 起 `node src/cli.ts daemon` 子进程（连续模式，fakebin PATH）。 */
function spawnDaemon(env: NodeJS.ProcessEnv): ChildProcess {
  return spawn(process.execPath, [path.join(REPO_ROOT, 'src', 'cli.ts'), 'daemon'], {
    env,
    cwd: REPO_ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

test(
  '验收：睡眠窗口内 SIGTERM → 取消睡眠计时器，进程不等 pollIntervalSec 立即退出',
  { timeout: 60_000 },
  async () => {
    // 队列为空 → 第一轮轮询后进入 pollIntervalSec=60 的睡眠窗口；修复前 SIGTERM
    // 后进程还要滞留 ~60 秒（本测试 25 秒等待会超时）。
    const w = createDaemonWorld({
      repos: [{ repo: REPO_A, prs: [] }],
      pollIntervalSec: 60,
      configExtra: ['peak:', '  enabled: false'],
    });
    const child = spawnDaemon({
      ...w.tmp.env,
      PATH: `${w.fake.binDir}:${w.tmp.env.PATH ?? ''}`,
    });
    const out = capture(child);
    const lockFile = path.join(w.tmp.homeDir, 'daemon.lock');
    try {
      // 等第一轮轮询完成并确认进入睡眠窗口：尚无第二次轮询（gh pr list 只调过一次）。
      await waitUntil('第一轮轮询完成', () => out.text().includes('轮询完成'), 30_000, () => out.text());
      await new Promise((resolve) => setTimeout(resolve, 500));
      assert.equal(w.ghListCalls().length, 1, '应只轮询过一轮，此刻在两轮之间的睡眠窗口内');

      const sentAt = Date.now();
      child.kill('SIGTERM');
      const { code, elapsedMs } = await waitForExit(child, 25_000);
      assert.equal(code, 0, `应优雅退出（0），实际输出：\n${out.text()}`);
      assert.ok(out.text().includes('SIGTERM'), '输出说明收到退出信号');
      assert.ok(elapsedMs < 15_000, `SIGTERM 后 ${elapsedMs}ms 才退出，睡眠计时器疑似未取消（输出：\n${out.text()})`);
      assert.equal(existsSync(lockFile), false, '退出时释放了单实例锁');
      assert.ok(Date.now() - sentAt < 20_000, '整体远小于 60 秒的睡眠窗口');
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await new Promise<void>((resolve) => {
        if (child.exitCode !== null || child.signalCode !== null) resolve();
        else child.on('close', () => resolve());
      });
      w.cleanup();
    }
  },
);

test(
  '验收：SIGTERM 时审查在跑、宽限内完成 → 清理宽限计时器，进程随审查完成退出',
  { timeout: 60_000 },
  async () => {
    // maxConcurrent=2：领取唯一任务后 runRound 以 idle 返回、任务在跑，守护进程停在
    // interruptible(awaitSettle())；SIGTERM → 宽限等待（claude.timeoutSec=60）。
    // 假 claude 1.5 秒应答 → 审查完成即应退出；修复前滞留的 60 秒宽限计时器会把
    // 进程占满 claude.timeoutSec（本测试 30 秒等待会超时）。
    const w = createDaemonWorld({
      repos: [{ repo: REPO_A, prs: [{ number: PR_A, headSha: SHA_A1 }] }],
      configExtra: ['maxConcurrent: 2', 'claude:', '  timeoutSec: 60', 'peak:', '  enabled: false'],
      claude: { stdout: claudeEnvelope(), delayMs: 1_500 },
    });
    const child = spawnDaemon({
      ...w.tmp.env,
      PATH: `${w.fake.binDir}:${w.tmp.env.PATH ?? ''}`,
    });
    const out = capture(child);
    try {
      await waitUntil('审查开始（claude 调用出现）', () => w.claudeCalls().length > 0, 30_000, () => out.text());
      // 让守护进程跑到「等待在跑审查收尾」处再发信号。
      await new Promise((resolve) => setTimeout(resolve, 500));

      child.kill('SIGTERM');
      const { code, elapsedMs } = await waitForExit(child, 30_000);
      assert.equal(code, 0, `应优雅退出（0），实际输出：\n${out.text()}`);
      // 审查 1.5 秒完成（发信号时已跑约 0.5 秒），退出应紧随其后，远小于 60 秒宽限。
      assert.ok(elapsedMs < 15_000, `SIGTERM 后 ${elapsedMs}ms 才退出，宽限计时器疑似未清理（输出：\n${out.text()})`);
      const job = listJobs(w.state, { repo: REPO_A, pr: PR_A })[0];
      assert.ok(job !== undefined, `任务行应存在，实际任务：${JSON.stringify(listJobs(w.state))}`);
      assert.equal(job.status, 'done', `审查应在宽限内完成，实际：${JSON.stringify(job)}；输出：\n${out.text()}`);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await new Promise<void>((resolve) => {
        if (child.exitCode !== null || child.signalCode !== null) resolve();
        else child.on('close', () => resolve());
      });
      w.cleanup();
    }
  },
);

test('defaultGraceWaiter 全部完成后清理限时计时器（不滞留事件循环）', async () => {
  const countTimers = (): number =>
    process.getActiveResourcesInfo().filter((name) => name === 'Timeout').length;
  const before = countTimers();
  const outcome = await defaultGraceWaiter(
    [new Promise<void>((resolve) => setTimeout(resolve, 20))],
    60_000,
  );
  assert.equal(outcome, 'done');
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(countTimers(), before, '60 秒宽限计时器应随全部完成一并清理');
});

test('defaultGraceWaiter 到时未完成仍返回 timeout（行为不变）', async () => {
  const outcome = await defaultGraceWaiter([new Promise<void>(() => {})], 30);
  assert.equal(outcome, 'timeout');
});
