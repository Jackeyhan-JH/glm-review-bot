/**
 * 守护进程单实例锁（#13）：`paths.lockFile`（GLM_REVIEW_HOME/daemon.lock）写 pid。
 * - 启动时锁存在且 pid 对应的进程活着 → 拒绝启动（命令层退出码 4）；
 * - pid 已死（上次实例没来得及清理）或文件内容损坏 → 视为过期锁，接管并覆盖；
 * - 退出时释放：只删除内容仍是自己 pid 的锁文件，防止误删后继实例的锁。
 */
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';

/** acquireLock 的结果。 */
export interface LockResult {
  ok: boolean;
  /** 拒绝启动时占用锁的进程 pid。 */
  holderPid?: number;
  /** true = 接管了过期（进程已死）或内容损坏的旧锁。 */
  tookOver?: boolean;
}

/** 进程是否存活。信号 0 只做存在性检查；EPERM 表示进程存在但属于其他用户。 */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** 读锁文件里的 pid；文件不存在或内容不是合法 pid 返回 null。 */
export function readLockPid(lockFile: string): number | null {
  if (!existsSync(lockFile)) return null;
  let text = '';
  try {
    text = readFileSync(lockFile, 'utf8').trim();
  } catch {
    return null;
  }
  if (!/^\d{1,10}$/.test(text)) return null;
  const pid = Number(text);
  return pid > 0 ? pid : null;
}

/**
 * 获取单实例锁：写入自己的 pid。锁被活着的进程占用时返回 ok=false（不覆盖）；
 * 旧锁进程已死或内容损坏时接管。锁文件父目录需已存在（ensureDirs 负责）。
 */
export function acquireLock(lockFile: string, pid: number = process.pid): LockResult {
  const fileExists = existsSync(lockFile);
  const existing = readLockPid(lockFile);
  if (existing !== null && existing !== pid && isProcessAlive(existing)) {
    return { ok: false, holderPid: existing };
  }
  writeFileSync(lockFile, `${pid}\n`);
  // 锁文件已存在（持锁进程已死 / 内容损坏）都算接管；重取自己的锁不算。
  return { ok: true, tookOver: fileExists && existing !== pid };
}

/**
 * 释放锁：仅当锁文件内容仍是自己的 pid 时删除（接管竞态下后继实例已覆写时不误删）。
 * 返回是否真的执行了删除。
 */
export function releaseLock(lockFile: string, pid: number = process.pid): boolean {
  const existing = readLockPid(lockFile);
  if (existing !== pid) return false;
  rmSync(lockFile, { force: true });
  return true;
}
