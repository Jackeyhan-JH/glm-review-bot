/**
 * 状态库迁移（#5）：按版本号顺序执行的建表 / 升级脚本。
 * - v1：初始结构（meta、jobs、calls）；
 * - v2：jobs 补充审查结果字段（review_url / findings_count / model）并建索引。
 * 每个迁移在独立事务里执行，成功后把版本号写进 meta.schema_version；
 * `to` 参数只供测试构造旧版本库，正常运行一律升到最新。
 */
import type { DatabaseSync } from 'node:sqlite';

/** 单个迁移：up 只做 DDL，不写版本号（由 applyMigrations 统一写）。 */
export interface Migration {
  version: number;
  name: string;
  up(db: DatabaseSync): void;
}

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: '初始结构：meta、jobs、calls',
    up(db) {
      db.exec(`
        CREATE TABLE meta (
          key   TEXT PRIMARY KEY NOT NULL,
          value TEXT NOT NULL
        );

        CREATE TABLE jobs (
          id          INTEGER PRIMARY KEY AUTOINCREMENT,
          repo        TEXT    NOT NULL,
          pr          INTEGER NOT NULL,
          head_sha    TEXT    NOT NULL,
          status      TEXT    NOT NULL DEFAULT 'queued',
          reason      TEXT,
          attempts    INTEGER NOT NULL DEFAULT 0,
          not_before  TEXT    NOT NULL,
          created_at  TEXT    NOT NULL,
          updated_at  TEXT    NOT NULL,
          started_at  TEXT,
          finished_at TEXT,
          UNIQUE (repo, pr, head_sha)
        );

        CREATE TABLE calls (
          id            INTEGER PRIMARY KEY AUTOINCREMENT,
          job_id        INTEGER NOT NULL REFERENCES jobs (id),
          chunk_index   INTEGER NOT NULL,
          model         TEXT    NOT NULL,
          started_at    TEXT    NOT NULL,
          duration_ms   INTEGER NOT NULL,
          exit_code     INTEGER,
          ok            INTEGER NOT NULL,
          input_tokens  INTEGER,
          output_tokens INTEGER,
          cost_usd      REAL,
          peak          INTEGER NOT NULL DEFAULT 0,
          error         TEXT
        );
      `);
    },
  },
  {
    version: 2,
    name: 'jobs 补充审查结果字段并建索引',
    up(db) {
      db.exec(`
        ALTER TABLE jobs ADD COLUMN review_url     TEXT;
        ALTER TABLE jobs ADD COLUMN findings_count INTEGER;
        ALTER TABLE jobs ADD COLUMN model          TEXT;
        CREATE INDEX idx_jobs_status_not_before ON jobs (status, not_before);
        CREATE INDEX idx_jobs_repo_pr           ON jobs (repo, pr);
        CREATE INDEX idx_calls_started_at       ON calls (started_at);
        CREATE INDEX idx_calls_job_id           ON calls (job_id);
      `);
    },
  },
];

/** 当前代码支持的最新结构版本。 */
export const LATEST_SCHEMA_VERSION: number = MIGRATIONS[MIGRATIONS.length - 1].version;

/** 读出库里的结构版本：全新库（还没有 meta 表）返回 0。 */
export function readSchemaVersion(db: DatabaseSync): number {
  const table = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'meta'")
    .get();
  if (table === undefined) return 0;
  const row = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as
    | { value: string }
    | undefined;
  if (row === undefined) {
    throw new Error('状态库有 meta 表但缺少 schema_version，无法判断结构版本');
  }
  const version = Number(row.value);
  if (!Number.isInteger(version) || version < 1) {
    throw new Error(`schema_version 不是合法版本号：${row.value}`);
  }
  return version;
}

function writeSchemaVersion(db: DatabaseSync, version: number): void {
  db
    .prepare(
      `INSERT INTO meta (key, value) VALUES ('schema_version', ?)
       ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
    )
    .run(String(version));
}

/**
 * 按版本顺序执行尚未应用的迁移，返回应用后的结构版本。
 * 已是目标版本时是幂等空操作；库版本比目标新时报错（需要升级程序本身）。
 */
export function applyMigrations(db: DatabaseSync, options: { to?: number } = {}): number {
  let expected = 0;
  for (const migration of MIGRATIONS) {
    if (migration.version !== expected + 1) {
      throw new Error(`迁移版本号必须从 1 连续递增，违规项：v${migration.version}`);
    }
    expected = migration.version;
  }
  const current = readSchemaVersion(db);
  const target = options.to ?? LATEST_SCHEMA_VERSION;
  if (current > target) {
    throw new Error(`状态库结构版本 v${current} 比程序支持的 v${target} 新，请先升级 glm-review-bot`);
  }
  if (current === target) return current;
  for (const migration of MIGRATIONS) {
    if (migration.version <= current || migration.version > target) continue;
    db.exec('BEGIN');
    try {
      migration.up(db);
      writeSchemaVersion(db, migration.version);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`迁移 v${migration.version}（${migration.name}）失败：${message}`);
    }
  }
  return target;
}
