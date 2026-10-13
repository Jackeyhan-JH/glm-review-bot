/**
 * 单实例锁单测：活进程占用 → 拒绝；进程已死 / 内容损坏 → 接管；
 * 释放只删自己的锁；命令层被占用时退出码 4（验收标准 5 的进程内一半，
 * 子进程侧见 daemon-process.test.ts）。
 */
import assert from 'node:assert/strict';
import { existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { test } from 'node:test';
import { acquireLock, isProcessAlive, readLockPid, releaseLock } from '../../src/daemon/lock.ts';
import { createTmpEnv } from '../helpers/tmp.ts';
import { createDaemonWorld, PR_A, REPO_A, SHA_A1 } from './helpers.ts';

test('acquireLock：无锁文件 → 写入自己的 pid', () => {
  const tmp = createTmpEnv('glm-review-lock-test');
  try {
    const lockFile = path.join(tmp.baseDir, 'daemon.lock');
    const result = acquireLock(lockFile, 12345);
    assert.equal(result.ok, true);
    assert.equal(result.tookOver, false);
    assert.equal(readLockPid(lockFile), 12345);
  } finally {
    tmp.cleanup();
  }
});

test('acquireLock：锁被活着的进程占用 → 拒绝且不覆盖', () => {
  const tmp = createTmpEnv('glm-review-lock-test');
  try {
    const lockFile = path.join(tmp.baseDir, 'daemon.lock');
    writeFileSync(lockFile, `${process.pid}\n`); // 测试进程本身一定是活的
    const result = acquireLock(lockFile, 12345);
    assert.equal(result.ok, false);
    assert.equal(result.holderPid, process.pid);
    assert.equal(readLockPid(lockFile), process.pid, '未覆盖原锁');
  } finally {
    tmp.cleanup();
  }
});

test('acquireLock：内容损坏的锁 → 接管覆盖', () => {
  const tmp = createTmpEnv('glm-review-lock-test');
  try {
    const lockFile = path.join(tmp.baseDir, 'daemon.lock');
    writeFileSync(lockFile, 'not-a-pid');
    const result = acquireLock(lockFile, 12345);
    assert.equal(result.ok, true);
    assert.equal(result.tookOver, true);
    assert.equal(readLockPid(lockFile), 12345);
  } finally {
    tmp.cleanup();
  }
});

test('acquireLock：持锁进程已死（上次实例没清理）→ 接管', async () => {
  const tmp = createTmpEnv('glm-review-lock-test');
  try {
    const dead = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
    await new Promise<void>((resolve) => dead.on('exit', () => resolve()));
    assert.equal(isProcessAlive(dead.pid ?? -1), false);

    const lockFile = path.join(tmp.baseDir, 'daemon.lock');
    writeFileSync(lockFile, `${dead.pid}\n`);
    const result = acquireLock(lockFile, 54321);
    assert.equal(result.ok, true);
    assert.equal(result.tookOver, true);
    assert.equal(readLockPid(lockFile), 54321);
  } finally {
    tmp.cleanup();
  }
});

test('releaseLock：只删除内容仍是自己 pid 的锁文件', () => {
  const tmp = createTmpEnv('glm-review-lock-test');
  try {
    const mine = path.join(tmp.baseDir, 'mine.lock');
    writeFileSync(mine, '12345\n');
    assert.equal(releaseLock(mine, 12345), true);
    assert.equal(existsSync(mine), false);

    const others = path.join(tmp.baseDir, 'others.lock');
    writeFileSync(others, '99999\n');
    assert.equal(releaseLock(others, 12345), false, '别人的锁不删');
    assert.equal(existsSync(others), true);

    const missing = path.join(tmp.baseDir, 'missing.lock');
    assert.equal(releaseLock(missing, 12345), false, '不存在的锁返回 false');
  } finally {
    tmp.cleanup();
  }
});

test('isProcessAlive：自己活着；非法 / 不存在的 pid 不 alive', () => {
  assert.equal(isProcessAlive(process.pid), true);
  assert.equal(isProcessAlive(0), false);
  assert.equal(isProcessAlive(-1), false);
  assert.equal(isProcessAlive(1.5), false);
  // 内核 pid_max 通常远小于这个数；即使被复用，也几乎不可能在测试瞬间出现。
  assert.equal(isProcessAlive(2_000_000_000), false);
});

test('命令层：锁被其他活进程占用 → 退出码 4、不做任何审查', async () => {
  const w = createDaemonWorld({
    repos: [{ repo: REPO_A, prs: [{ number: PR_A, headSha: SHA_A1 }] }],
  });
  // 占住锁的「另一个实例」：一个活着的短命子进程
  const holder = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
  try {
    await new Promise<void>((resolve) => holder.on('spawn', () => resolve()));
    writeFileSync(path.join(w.tmp.homeDir, 'daemon.lock'), `${holder.pid}\n`);

    const code = await w.runCli(['daemon', '--once']);
    assert.equal(code, 4);
    assert.ok(w.harness.stderr().includes('已有守护进程实例在运行'), 'stderr 说明被拒原因');
    assert.ok(w.harness.stderr().includes(String(holder.pid)));
    assert.equal(w.claudeCalls().length, 0, '被拒不审查');
    assert.equal(readLockPid(path.join(w.tmp.homeDir, 'daemon.lock')), holder.pid, '不抢别人的锁');
  } finally {
    holder.kill('SIGKILL');
    await new Promise<void>((resolve) => holder.on('exit', () => resolve()));
    w.cleanup();
  }
});
