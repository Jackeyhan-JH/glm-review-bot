/**
 * 状态库连接（#5）：基于 node:sqlite 的本地状态库入口。
 * - `openState(path)` 打开（或创建）库文件：WAL 模式 + busy_timeout + 外键约束；
 * - 建表与升级统一走 `migrations.ts` 的版本化迁移，打开即升到最新；
 * - 其他模块一律经由 jobs.ts / calls.ts 读写状态，不直接写 SQL。
 * 库文件的父目录需已存在（由 paths.ensureDirs 负责）。
 */
import { DatabaseSync } from 'node:sqlite';
import { applyMigrations } from './migrations.ts';

/** 打开的状态库句柄；sqlite 是底层连接，仅供 state 模块内部使用。 */
export interface StateDb {
  /** 库文件路径。 */
  readonly path: string;
  /** 底层 node:sqlite 连接（外部模块请走 jobs.ts / calls.ts）。 */
  readonly sqlite: DatabaseSync;
  /** 关闭连接。 */
  close(): void;
}

export interface OpenStateOptions {
  /** 拿不到写锁时的等待毫秒数（busy_timeout），默认 5000。 */
  busyTimeoutMs?: number;
}

/** 字符串或 Date 统一转 ISO 字符串：库里所有时间都是这种格式，等长、可按字典序比较。 */
export function toIso(value: string | Date): string {
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

export function openState(path: string, options: OpenStateOptions = {}): StateDb {
  const sqlite = new DatabaseSync(path);
  sqlite.exec('PRAGMA journal_mode = WAL');
  sqlite.exec(`PRAGMA busy_timeout = ${Math.max(0, Math.floor(options.busyTimeoutMs ?? 5000))}`);
  sqlite.exec('PRAGMA foreign_keys = ON');
  applyMigrations(sqlite);
  return {
    path,
    sqlite,
    close(): void {
      sqlite.close();
    },
  };
}
