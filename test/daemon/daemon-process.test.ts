/**
 * 验收标准 5（子进程）：真实起一个 `node src/cli.ts daemon` 子进程——
 * 审查进行中时第二个实例被拒（退出码 4）；SIGTERM 后第一个实例优雅退出
 * （退出码 0）、释放单实例锁、运行中的任务回到队列。
 *
 * 全程 fake gh / claude（PATH 指向 fakebin），假 claude 应答前睡 10 秒且
 * claude.timeoutSec=2（审查永远等不完 → 任务停在 running）；peak 关闭，
 * 不依赖测试机的真实时钟是否高峰。
 */
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { readLockPid } from '../../src/daemon/lock.ts';
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

/** 等子进程退出并返回退出码（close：stdio 流也已排空，输出不丢）；超时杀掉后抛错。 */
async function waitForExit(child: ChildProcess, timeoutMs: number): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`子进程 ${child.pid} ${timeoutMs}ms 内未退出`));
    }, timeoutMs);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve(code);
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

test(
  '验收：第二实例退出码 4；SIGTERM → 锁释放、运行中任务回到队列',
  { timeout: 90_000 },
  async () => {
    const w = createDaemonWorld({
      repos: [{ repo: REPO_A, prs: [{ number: PR_A, headSha: SHA_A1 }] }],
      configExtra: ['claude:', '  timeoutSec: 2', 'peak:', '  enabled: false'],
      claude: { stdout: claudeEnvelope(), delayMs: 10_000 },
    });
    const env = {
      ...w.tmp.env,
      PATH: `${w.fake.binDir}:${w.tmp.env.PATH ?? ''}`,
    };
    const daemonArgs = [path.join(REPO_ROOT, 'src', 'cli.ts'), 'daemon'];
    const lockFile = path.join(w.tmp.homeDir, 'daemon.lock');

    const first = spawn(process.execPath, daemonArgs, { env, cwd: REPO_ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    const firstOut = capture(first);
    try {
      // 等审查真的跑起来：claude 被调用 + 任务处于 running + 锁写的是该子进程 pid。
      await waitUntil(
        '第一个实例开始审查（claude 调用出现）',
        () => w.claudeCalls().length > 0,
        30_000,
        () => firstOut.text(),
      );
      const jobs = () => listJobs(w.state, { repo: REPO_A, pr: PR_A });
      await waitUntil('任务进入 running', () => jobs()[0]?.status === 'running', 5_000, () => firstOut.text());
      assert.equal(readLockPid(lockFile), first.pid, '锁里是第一个实例的 pid');

      // 第二个实例：锁被活进程占用 → 退出码 4，不做任何事
      const second = spawn(process.execPath, daemonArgs, { env, cwd: REPO_ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
      const secondOut = capture(second);
      const secondCode = await waitForExit(second, 30_000);
      assert.equal(secondCode, 4, `第二实例应退出码 4，实际输出：\n${secondOut.text()}`);
      assert.ok(secondOut.text().includes('已有守护进程实例在运行'), `stderr 应说明被拒：\n${secondOut.text()}`);
      assert.equal(readLockPid(lockFile), first.pid, '第二实例没有抢走锁');

      // SIGTERM 第一个实例：优雅退出，锁释放，运行中的任务回到队列
      first.kill('SIGTERM');
      const firstCode = await waitForExit(first, 60_000);
      assert.equal(firstCode, 0, `第一实例应优雅退出（0），实际输出：\n${firstOut.text()}`);
      assert.ok(firstOut.text().includes('SIGTERM'), '输出说明收到退出信号');
      assert.equal(existsSync(lockFile), false, '退出时释放了单实例锁');

      const job = listJobs(w.state, { repo: REPO_A, pr: PR_A })[0];
      assert.ok(job !== undefined, `任务行应存在，实际任务：${JSON.stringify(listJobs(w.state))}；输出：\n${firstOut.text()}`);
      assert.equal(job.status, 'queued', '运行中的任务回到队列（或按失败退避排队），绝不滞留 running');
      assert.equal(job.startedAt, null, 'started_at 已清空');
      assert.equal(job.attempts, 1, `只领取过一次；任务：${JSON.stringify(job)}；输出：\n${firstOut.text()}`);
      // 第二实例没做任何事已由「退出码 4 + 只输出被拒提示」证明；这里不再对 claude
      // 调用计数做断言——第一实例优雅退出期间在跑审查的就地重试也会增加计数。
    } finally {
      if (first.exitCode === null && first.signalCode === null) first.kill('SIGKILL');
      await new Promise<void>((resolve) => {
        if (first.exitCode !== null || first.signalCode !== null) resolve();
        else first.on('close', () => resolve());
      });
      w.cleanup();
    }
  },
);
