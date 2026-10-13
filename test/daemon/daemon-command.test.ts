/**
 * `glm-review daemon` 命令层测试：参数解析（未知选项 → 2）、help 可发现、
 * --once --dry-run 全链路、repos 白名单为空的提示。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getMeta } from '../../src/daemon/meta.ts';
import { META_DAEMON_HEARTBEAT_AT } from '../../src/status/collect.ts';
import { listJobs } from '../../src/state/jobs.ts';
import { createDaemonWorld, PR_A, REPO_A, SHA_A1 } from './helpers.ts';

test('未知选项 → 退出码 2，提示用法', async () => {
  const w = createDaemonWorld({ repos: [] });
  try {
    const code = await w.runCli(['daemon', '--forever']);
    assert.equal(code, 2);
    assert.ok(w.harness.stderr().includes('错误'), '说明错误');
    assert.ok(w.harness.stderr().includes('用法：glm-review daemon'), '附上用法');
    assert.equal(w.claudeCalls().length, 0);
  } finally {
    w.cleanup();
  }
});

test('help 能发现 daemon 子命令并展示用法', async () => {
  const w = createDaemonWorld({ repos: [] });
  try {
    const list = await w.runCli(['help']);
    assert.equal(list, 0);
    assert.ok(w.harness.stdout().includes('daemon'), '命令列表里有 daemon');

    const detail = await w.runCli(['help', 'daemon']);
    assert.equal(detail, 0);
    const stdout = w.harness.stdout();
    assert.ok(stdout.includes('用法：glm-review daemon'), '详细用法');
    assert.ok(stdout.includes('--once'));
    assert.ok(stdout.includes('--dry-run'));
  } finally {
    w.cleanup();
  }
});

test('daemon --once --dry-run 全链路：预览不发评论、不标记 done', async () => {
  const w = createDaemonWorld({
    repos: [{ repo: REPO_A, prs: [{ number: PR_A, headSha: SHA_A1 }] }],
  });
  try {
    const code = await w.runCli(['daemon', '--once', '--dry-run']);
    assert.equal(code, 0);
    const stdout = w.harness.stdout();
    assert.ok(stdout.includes('单轮模式'), '输出说明单轮模式');
    assert.ok(stdout.includes('dry-run 预览完成'), '预览完成输出');

    assert.equal(w.claudeCalls().length, 1);
    assert.equal(w.postCalls().length, 0, 'dry-run 不发 review');
    const job = listJobs(w.state, { repo: REPO_A, pr: PR_A })[0];
    assert.equal(job?.status, 'queued', '预览不标记 done');
    assert.equal(job?.attempts, 0);
  } finally {
    w.cleanup();
  }
});

test('repos 白名单为空 → 提示轮询不到仓库，心跳照常写入', async () => {
  const w = createDaemonWorld({ repos: [] });
  try {
    const code = await w.runCli(['daemon', '--once']);
    assert.equal(code, 0);
    assert.ok(w.harness.stdout().includes('白名单为空'), '提示白名单为空');
    assert.ok(w.claudeCalls().length === 0);
    assert.ok(getMeta(w.state, META_DAEMON_HEARTBEAT_AT) !== null, '心跳照常写入');
  } finally {
    w.cleanup();
  }
});
