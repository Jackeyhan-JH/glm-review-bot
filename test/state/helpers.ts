/**
 * state 模块测试夹具：在临时目录里建状态库，测试结束自动清理。
 * 库文件（含 WAL / SHM 伴生文件）都在临时目录内，随目录一起删除。
 */
import path from 'node:path';
import { openState, type StateDb } from '../../src/state/db.ts';
import { createTmpEnv } from '../helpers/tmp.ts';

export interface TmpState {
  state: StateDb;
  /** 库文件路径（测迁移 / 多连接时复用）。 */
  dbPath: string;
  cleanup(): void;
}

export function openTmpState(prefix = 'glm-review-state-test'): TmpState {
  const tmp = createTmpEnv(prefix);
  const dbPath = path.join(tmp.homeDir, 'state.db');
  const state = openState(dbPath);
  const cleanup = (): void => {
    try {
      state.close();
    } catch {
      // 已关闭则忽略。
    }
    tmp.cleanup();
  };
  return { state, dbPath, cleanup };
}

/** 直接数 jobs 表行数（绕过 listJobs，用于去重断言）。 */
export function countJobs(state: StateDb): number {
  const row = state.sqlite.prepare('SELECT COUNT(*) AS n FROM jobs').get() as { n: number };
  return row.n;
}
