/**
 * 迁移测试（#5 验收）：新库自动建表、旧版本库升级、schema_version 正确。
 */
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import path from 'node:path';
import { openState } from '../../src/state/db.ts';
import {
  applyMigrations,
  LATEST_SCHEMA_VERSION,
  MIGRATIONS,
  readSchemaVersion,
} from '../../src/state/migrations.ts';
import { getJob } from '../../src/state/jobs.ts';
import { listCalls } from '../../src/state/calls.ts';
import { createTmpEnv } from '../helpers/tmp.ts';
import { openTmpState } from './helpers.ts';

function readMetaVersion(state: ReturnType<typeof openState>): number {
  const row = state.sqlite
    .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
    .get() as { value: string };
  return Number(row.value);
}

test('迁移列表版本号从 1 开始且连续递增', () => {
  const versions = MIGRATIONS.map((m) => m.version);
  assert.deepEqual(versions, versions.map((_, i) => i + 1));
  assert.equal(LATEST_SCHEMA_VERSION, versions[versions.length - 1]);
});

test('新库自动建表，schema_version 为最新，WAL 与 busy_timeout 生效', () => {
  const t = openTmpState('glm-review-state-mig');
  try {
    const tables = (
      t.state.sqlite
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
        .all() as Array<{ name: string }>
    ).map((r) => r.name);
    assert.ok(tables.includes('jobs'));
    assert.ok(tables.includes('calls'));
    assert.ok(tables.includes('meta'));
    assert.equal(readMetaVersion(t.state), LATEST_SCHEMA_VERSION);
    assert.equal(readSchemaVersion(t.state.sqlite), LATEST_SCHEMA_VERSION);

    const journal = t.state.sqlite.prepare('PRAGMA journal_mode').get() as {
      journal_mode: string;
    };
    assert.equal(journal.journal_mode.toLowerCase(), 'wal');

    const busy = t.state.sqlite.prepare('PRAGMA busy_timeout').get() as { timeout: number };
    assert.equal(busy.timeout, 5000);
  } finally {
    t.cleanup();
  }
});

test('busyTimeoutMs 可配置', () => {
  const tmp = createTmpEnv('glm-review-state-busy');
  const state = openState(path.join(tmp.homeDir, 'state.db'), { busyTimeoutMs: 1200 });
  try {
    const busy = state.sqlite.prepare('PRAGMA busy_timeout').get() as { timeout: number };
    assert.equal(busy.timeout, 1200);
  } finally {
    state.close();
    tmp.cleanup();
  }
});

test('从 v1 升到最新：补上新列、保留旧数据、schema_version 正确', () => {
  const tmp = createTmpEnv('glm-review-state-upgrade');
  try {
    const dbPath = path.join(tmp.homeDir, 'state.db');
    // 先造一个只有 v1 结构的旧库，并写入 v1 时代的数据。
    const old = new DatabaseSync(dbPath);
    assert.equal(applyMigrations(old, { to: 1 }), 1);
    old
      .prepare(
        `INSERT INTO jobs (repo, pr, head_sha, status, attempts, not_before, created_at, updated_at)
         VALUES ('a/b', 7, 'oldsha', 'done', 2, '2026-01-01T00:00:00.000Z',
                 '2026-01-01T00:00:00.000Z', '2026-01-01T00:05:00.000Z')`,
      )
      .run();
    old
      .prepare(
        `INSERT INTO calls (job_id, chunk_index, model, started_at, duration_ms, exit_code, ok)
         VALUES (1, 0, 'glm-5.3-flash', '2026-01-01T00:01:00.000Z', 1234, 0, 1)`,
      )
      .run();
    old.close();

    // 重新打开：自动迁移到最新。
    const state = openState(dbPath);
    try {
      assert.equal(readSchemaVersion(state.sqlite), LATEST_SCHEMA_VERSION);
      const columns = (
        state.sqlite.prepare('PRAGMA table_info(jobs)').all() as Array<{ name: string }>
      ).map((r) => r.name);
      assert.ok(columns.includes('review_url'));
      assert.ok(columns.includes('findings_count'));
      assert.ok(columns.includes('model'));

      const job = getJob(state, 1);
      assert.equal(job.status, 'done');
      assert.equal(job.headSha, 'oldsha');
      assert.equal(job.attempts, 2);
      assert.equal(job.reviewUrl, null);
      assert.equal(job.findingsCount, null);
      assert.equal(job.model, null);

      const calls = listCalls(state);
      assert.equal(calls.length, 1);
      assert.equal(calls[0].model, 'glm-5.3-flash');
      assert.equal(calls[0].ok, true);
    } finally {
      state.close();
    }
  } finally {
    tmp.cleanup();
  }
});

test('重复打开已是最新的库是幂等操作', () => {
  const t = openTmpState('glm-review-state-idempotent');
  try {
    const again = openState(t.dbPath);
    try {
      assert.equal(readSchemaVersion(again.sqlite), LATEST_SCHEMA_VERSION);
    } finally {
      again.close();
    }
  } finally {
    t.cleanup();
  }
});

test('库版本比程序新时报错', () => {
  const t = openTmpState('glm-review-state-newer');
  try {
    t.state.sqlite
      .prepare("UPDATE meta SET value = '9999' WHERE key = 'schema_version'")
      .run();
    t.state.close();
    assert.throws(() => openState(t.dbPath), /新/);
  } finally {
    t.cleanup();
  }
});

test('meta 表存在但没有 schema_version 时报错', () => {
  const tmp = createTmpEnv('glm-review-state-noversion');
  try {
    const brokenPath = path.join(tmp.homeDir, 'broken.db');
    const raw = new DatabaseSync(brokenPath);
    raw.exec('CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    raw.close();
    assert.throws(() => openState(brokenPath), /schema_version/);
  } finally {
    tmp.cleanup();
  }
});
