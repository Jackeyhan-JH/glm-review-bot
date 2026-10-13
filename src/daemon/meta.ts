/**
 * 状态库 meta 键值表的读写（#13）。
 *
 * `src/state`（#5）目前没有 meta 表的公开读写接口（见 #12 PR 里给 #13 的组装说明：
 * 「#13 需要一个 getMeta/setMeta（或等价）小接口」），而 meta 表在迁移 v1 就存在。
 * 按 #1 的目录归属约定，这里在 daemon 目录内用同语义 SQL 补齐，不改 `src/state/**`；
 * 后续宜开小 issue 把这两个函数挪进 src/state，届时本文件只需 re-export，调用方不变。
 */
import type { StateDb } from '../state/db.ts';

/** 读一个 meta 键；不存在返回 null。 */
export function getMeta(state: StateDb, key: string): string | null {
  const row = state.sqlite
    .prepare('SELECT value FROM meta WHERE key = ?')
    .get(key) as { value: string } | undefined;
  return row === undefined ? null : row.value;
}

/** 写一个 meta 键（upsert）。 */
export function setMeta(state: StateDb, key: string, value: string): void {
  state.sqlite
    .prepare(
      `INSERT INTO meta (key, value) VALUES (?, ?)
       ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
    )
    .run(key, value);
}
