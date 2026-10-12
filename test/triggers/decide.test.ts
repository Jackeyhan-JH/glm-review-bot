/**
 * decide 的测试：每条规则一个用例（验收标准），包括草稿 → 转正后同一 sha 重新入队。
 * 纯函数，不碰状态库 / exec——既有任务信息以 TriggerState 传入。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { defaultRepoConfig, type RepoConfig } from '../../src/config/repo.ts';
import { decide, SKIP_REASON_DRAFT } from '../../src/triggers/decide.ts';
import { makeExisting, makePr } from './helpers.ts';

function config(overrides: Partial<RepoConfig> = {}): RepoConfig {
  return { ...defaultRepoConfig(), ...overrides };
}

test('规则：已合并的 PR → ignore(merged)', () => {
  const d = decide(makePr({ state: 'MERGED' }), config());
  assert.equal(d.action, 'ignore');
  assert.equal(d.reason, 'merged');
});

test('规则：已关闭的 PR → ignore(closed)，不再审查', () => {
  const d = decide(makePr({ state: 'CLOSED' }), config());
  assert.equal(d.action, 'ignore');
  assert.equal(d.reason, 'closed');
});

test('规则：同 (repo, pr, headSha) 已有任务 → ignore(duplicate)', () => {
  for (const status of ['queued', 'deferred', 'running', 'done', 'failed'] as const) {
    const d = decide(makePr(), config(), { existingJob: makeExisting({ status }) });
    assert.equal(d.action, 'ignore', `status=${status} 应忽略`);
    assert.equal(d.reason, 'duplicate');
  }
});

test('规则：没有任何跳过条件命中 → enqueue(new)', () => {
  const d = decide(makePr(), config());
  assert.deepEqual(d, { action: 'enqueue', reason: 'new', detail: d.detail });
  assert.ok(d.detail.length > 0, 'enqueue 也应带中文说明');
});

test('规则：仓库配置 enabled: false → skip(disabled)', () => {
  const d = decide(makePr(), config({ enabled: false }));
  assert.equal(d.action, 'skip');
  assert.equal(d.reason, 'disabled');
});

test('规则：草稿 PR 且 skipDrafts（默认开）→ skip(draft)', () => {
  const d = decide(makePr({ isDraft: true }), config());
  assert.equal(d.action, 'skip');
  assert.equal(d.reason, SKIP_REASON_DRAFT);
});

test('规则：草稿 PR 但 skipDrafts: false → 照常 enqueue', () => {
  const d = decide(makePr({ isDraft: true }), config({ skipDrafts: false }));
  assert.equal(d.action, 'enqueue');
  assert.equal(d.reason, 'new');
});

test('规则：带 skipLabels 中的标签（默认 no-review）→ skip(label:<标签>)', () => {
  const d = decide(makePr({ labels: ['enhancement', 'no-review'] }), config());
  assert.equal(d.action, 'skip');
  assert.equal(d.reason, 'label:no-review');
});

test('规则：标签匹配不区分大小写，reason 带 PR 上的原始标签名', () => {
  const d = decide(makePr({ labels: ['No-Review'] }), config({ skipLabels: ['no-review'] }));
  assert.equal(d.action, 'skip');
  assert.equal(d.reason, 'label:No-Review');
});

test('规则：其他标签不误伤 → enqueue', () => {
  const d = decide(makePr({ labels: ['enhancement', 'ready'] }), config());
  assert.equal(d.action, 'enqueue');
});

test('规则：作者在 skipAuthors → skip(author:<登录名>)', () => {
  const d = decide(makePr({ author: 'renovate[bot]' }), config({ skipAuthors: ['renovate[bot]'] }));
  assert.equal(d.action, 'skip');
  assert.equal(d.reason, 'author:renovate[bot]');
});

test('规则：作者匹配不区分大小写', () => {
  const d = decide(makePr({ author: 'SomeBot' }), config({ skipAuthors: ['somebot'] }));
  assert.equal(d.action, 'skip');
  assert.equal(d.reason, 'author:SomeBot');
});

test('规则：标题含 [skip review] → skip(title)', () => {
  const d = decide(makePr({ title: 'chore: 依赖升级 [skip review]' }), config());
  assert.equal(d.action, 'skip');
  assert.equal(d.reason, 'title');
});

test('规则：标题标记大小写不敏感（[SKIP REVIEW] / [No Review]）', () => {
  for (const title of ['x [SKIP REVIEW]', '[No Review] y']) {
    const d = decide(makePr({ title }), config());
    assert.equal(d.action, 'skip', `标题 "${title}" 应跳过`);
    assert.equal(d.reason, 'title');
  }
});

test('规则：标题标记识别中文方括号【skip review】/【no review】', () => {
  for (const title of ['【skip review】依赖升级', '修复【no review】', '【SKIP REVIEW】']) {
    const d = decide(makePr({ title }), config());
    assert.equal(d.action, 'skip', `标题 "${title}" 应跳过`);
  }
});

test('规则：标题标记允许标记内多余空白；相似但不同的词不误伤', () => {
  assert.equal(decide(makePr({ title: 'fix [skip  review]' }), config()).action, 'skip');
  assert.equal(decide(makePr({ title: 'fix [skip reviews]' }), config()).action, 'enqueue');
  assert.equal(decide(makePr({ title: 'fix [skip]' }), config()).action, 'enqueue');
});

test('草稿 → 转正后同一 sha 重新入队：skipped(draft) 不算已审', () => {
  const wasDraft = { existingJob: makeExisting({ status: 'skipped', reason: SKIP_REASON_DRAFT }) };
  // 仍是草稿：去重照常（已有 skipped(draft) 记录，不需要再记）。
  assert.equal(decide(makePr({ isDraft: true }), config(), wasDraft).action, 'ignore');
  // 转正后：同 sha 重新入队。
  const d = decide(makePr({ isDraft: false }), config(), wasDraft);
  assert.equal(d.action, 'enqueue');
  assert.equal(d.reason, 'ready');
});

test('草稿转正后仍要走其余跳过规则（如命中标签则 skip）', () => {
  const wasDraft = { existingJob: makeExisting({ status: 'skipped', reason: SKIP_REASON_DRAFT }) };
  const d = decide(makePr({ isDraft: false, labels: ['no-review'] }), config(), wasDraft);
  assert.equal(d.action, 'skip');
  assert.equal(d.reason, 'label:no-review');
});

test('其他 skip 原因（非 draft）的 skipped 任务转正后不去重豁免', () => {
  const d = decide(
    makePr(),
    config(),
    { existingJob: makeExisting({ status: 'skipped', reason: 'label:no-review' }) },
  );
  assert.equal(d.action, 'ignore');
  assert.equal(d.reason, 'duplicate');
});

test('force（/glm-review 手动重审）：忽略去重与各跳过规则', () => {
  // 已审过（done）也重审。
  const reviewed = decide(makePr(), config(), { existingJob: makeExisting({ status: 'done' }), force: true });
  assert.equal(reviewed.action, 'enqueue');
  assert.equal(reviewed.reason, 'manual');
  // 草稿、标签、作者、标题、停用统统让位。
  const stubborn = makePr({
    isDraft: true,
    labels: ['no-review'],
    author: 'renovate[bot]',
    title: 'chore [skip review]',
  });
  const d = decide(stubborn, config({ enabled: false, skipAuthors: ['renovate[bot]'] }), { force: true });
  assert.equal(d.action, 'enqueue');
  assert.equal(d.reason, 'manual');
  // 已关闭 / 合并的 PR 即便 force 也不审。
  assert.equal(decide(makePr({ state: 'CLOSED' }), config(), { force: true }).action, 'ignore');
  assert.equal(decide(makePr({ state: 'MERGED' }), config(), { force: true }).action, 'ignore');
});

test('规则判定顺序：已关闭优先于一切（连 force 也拦不住，skip 规则更不用比）', () => {
  const d = decide(
    makePr({ state: 'CLOSED', isDraft: true, labels: ['no-review'] }),
    config(),
    { existingJob: makeExisting({ status: 'queued' }) },
  );
  assert.equal(d.action, 'ignore');
  assert.equal(d.reason, 'closed');
});
