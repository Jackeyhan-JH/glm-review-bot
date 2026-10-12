/**
 * prs.ts 的测试：用假 gh 断言实际 argv 与输出映射（不碰真实网络 / 真实 gh）。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { fixedClock } from '../../src/lib/clock.ts';
import { nullLogger } from '../../src/lib/log.ts';
import { resolvePaths } from '../../src/lib/paths.ts';
import {
  DEFAULT_MAX_DIFF_BYTES,
  getDiff,
  getPr,
  getPrBaseSha,
  getPrComments,
  listOpenPrs,
} from '../../src/github/prs.ts';
import { DiffTooLargeError, UnexpectedResponseError } from '../../src/github/errors.ts';
import type { GithubDeps } from '../../src/github/run.ts';
import { createFakeBin } from '../helpers/fakebin.ts';
import { createTmpEnv } from '../helpers/tmp.ts';
import { fakeDeps, REPO, SHA_A, SHA_B } from './helpers.ts';

const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'common');

const PR_FIELDS =
  'number,title,author,url,headRefOid,baseRefName,headRefName,isDraft,labels,updatedAt,state';

const LIST_JSON = [
  {
    number: 45,
    title: 'feat(pay): 支持多币种分摊',
    author: { login: 'Jackeyhan-JH' },
    url: `https://github.com/${REPO}/pull/45`,
    headRefOid: SHA_A,
    baseRefName: 'main',
    headRefName: 'feat/multi-currency',
    isDraft: true,
    labels: [{ name: 'ready' }, { name: 'enhancement' }],
    updatedAt: '2026-10-10T08:30:00Z',
    state: 'OPEN',
  },
  {
    number: 46,
    title: 'fix: 空值容错',
    author: null,
    url: `https://github.com/${REPO}/pull/46`,
    headRefOid: '0123456789abcdef0123456789abcdef01234567',
    baseRefName: 'main',
    headRefName: 'fix/null',
    isDraft: false,
    labels: null,
    updatedAt: '2026-10-11T09:00:00Z',
    state: 'OPEN',
  },
].map((pr) => JSON.stringify(pr))
  .join(',');

test('listOpenPrs：argv 精确、author/labels 对象映射为字符串', async () => {
  const fake = createFakeBin();
  const tmp = createTmpEnv('glm-review-github-prs');
  try {
    fake.rule('gh', { mode: 'prefix', match: ['pr', 'list'], stdout: `[${LIST_JSON}]` });
    const prs = await listOpenPrs(fakeDeps(fake, tmp), REPO);

    assert.equal(prs.length, 2);
    assert.deepEqual(prs[0], {
      repo: REPO,
      number: 45,
      title: 'feat(pay): 支持多币种分摊',
      author: 'Jackeyhan-JH',
      url: `https://github.com/${REPO}/pull/45`,
      headSha: SHA_A,
      baseRef: 'main',
      headRef: 'feat/multi-currency',
      isDraft: true,
      labels: ['ready', 'enhancement'],
      state: 'OPEN',
      updatedAt: '2026-10-10T08:30:00Z',
    });
    // author 为 null / labels 缺失时兜底为空值，不抛错。
    assert.equal(prs[1]?.author, '');
    assert.deepEqual(prs[1]?.labels, []);

    const calls = fake.calls().filter((call) => call.bin === 'gh');
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0]?.argv, [
      'pr',
      'list',
      '--repo',
      REPO,
      '--state',
      'open',
      '--limit',
      '100',
      '--json',
      PR_FIELDS,
    ]);
  } finally {
    tmp.cleanup();
    fake.remove();
  }
});

test('listOpenPrs：gh 返回非 JSON 时抛 UnexpectedResponseError', async () => {
  const fake = createFakeBin();
  const tmp = createTmpEnv('glm-review-github-prs');
  try {
    fake.rule('gh', { mode: 'prefix', match: ['pr', 'list'], stdout: '不是 JSON' });
    await assert.rejects(listOpenPrs(fakeDeps(fake, tmp), REPO), UnexpectedResponseError);
  } finally {
    tmp.cleanup();
    fake.remove();
  }
});

test('getPr：argv 精确，公共夹具映射为 PrInfo（repo 注入）', async () => {
  const fake = createFakeBin();
  const tmp = createTmpEnv('glm-review-github-prs');
  try {
    const fixture = readFileSync(path.join(fixturesDir, 'pr-view.sample.json'), 'utf8');
    fake.rule('gh', { mode: 'prefix', match: ['pr', 'view'], stdout: fixture });
    const pr = await getPr(fakeDeps(fake, tmp), REPO, 45);

    assert.equal(pr.repo, REPO);
    assert.equal(pr.number, 45);
    assert.equal(pr.author, 'Jackeyhan-JH');
    assert.equal(pr.headSha, '9f2b1c3a4d5e6f708192a3b4c5d6e7f8091a2b3c');
    // PR_FIELDS 不再请求 baseRefOid（#30），映射结果也不再填 baseSha。
    assert.equal(pr.baseSha, undefined);
    assert.equal(pr.baseRef, 'main');
    assert.equal(pr.headRef, 'feat/multi-currency');
    assert.equal(pr.isDraft, false);
    assert.deepEqual(pr.labels, ['ready', 'enhancement']);

    const calls = fake.calls().filter((call) => call.bin === 'gh');
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0]?.argv, ['pr', 'view', '45', '--repo', REPO, '--json', PR_FIELDS]);
    assert.equal(calls[0]?.stdin, '');
  } finally {
    tmp.cleanup();
    fake.remove();
  }
});

test('getPr：PR 编号必须为正整数', async () => {
  const fake = createFakeBin();
  const tmp = createTmpEnv('glm-review-github-prs');
  try {
    await assert.rejects(getPr(fakeDeps(fake, tmp), REPO, 0), /PR 编号/);
    await assert.rejects(getPr(fakeDeps(fake, tmp), REPO, 12.5), /PR 编号/);
    assert.equal(fake.calls().length, 0);
  } finally {
    tmp.cleanup();
    fake.remove();
  }
});

test('#30 回归：getPr / listOpenPrs 请求的 --json 字段不含 baseRefOid', async () => {
  const fake = createFakeBin();
  const tmp = createTmpEnv('glm-review-github-prs');
  try {
    fake.rule('gh', { mode: 'prefix', match: ['pr', 'list'], stdout: `[${LIST_JSON}]` });
    const fixture = readFileSync(path.join(fixturesDir, 'pr-view.sample.json'), 'utf8');
    fake.rule('gh', { mode: 'prefix', match: ['pr', 'view'], stdout: fixture });
    await listOpenPrs(fakeDeps(fake, tmp), REPO);
    await getPr(fakeDeps(fake, tmp), REPO, 45);

    // 从真实 argv 动态取出 --json 的字段清单（不与上面的 PR_FIELDS 常量对抄，
    // 防止两边同步把 baseRefOid 加回来）。gh 2.46.0 的 pr view/list --json
    // 不支持 baseRefOid（gh ≥ 2.76 才有），带上即整条命令失败（#30）。
    const fieldLists = fake
      .calls()
      .filter((call) => call.bin === 'gh' && call.argv.includes('--json'))
      .map((call) => (call.argv[call.argv.indexOf('--json') + 1] ?? '').split(','));
    assert.equal(fieldLists.length, 2, 'listOpenPrs 与 getPr 各请求一次');
    const mustHave = [
      'number',
      'title',
      'author',
      'url',
      'headRefOid',
      'baseRefName',
      'headRefName',
      'isDraft',
      'labels',
      'updatedAt',
      'state',
    ];
    for (const fields of fieldLists) {
      assert.ok(!fields.includes('baseRefOid'), `--json 字段不应含 baseRefOid（gh 2.46.0 不支持）：${fields.join(',')}`);
      for (const field of mustHave) {
        assert.ok(fields.includes(field), `--json 字段应保留 ${field}，防止误删：${fields.join(',')}`);
      }
    }
  } finally {
    tmp.cleanup();
    fake.remove();
  }
});

test('getPrBaseSha：argv 精确，REST 响应映射出 base.sha（gh 2.46.0 可用路径）', async () => {
  const fake = createFakeBin();
  const tmp = createTmpEnv('glm-review-github-prs');
  try {
    fake.rule('gh', {
      match: ['api', `repos/${REPO}/pulls/45`],
      stdout: JSON.stringify({ number: 45, base: { sha: SHA_B }, head: { sha: SHA_A } }),
    });
    const sha = await getPrBaseSha(fakeDeps(fake, tmp), REPO, 45);

    assert.equal(sha, SHA_B);
    const calls = fake.calls().filter((call) => call.bin === 'gh');
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0]?.argv, ['api', `repos/${REPO}/pulls/45`]);
  } finally {
    tmp.cleanup();
    fake.remove();
  }
});

test('getPrBaseSha：响应缺少 base.sha 抛 UnexpectedResponseError；PR 编号必须为正整数', async () => {
  const fake = createFakeBin();
  const tmp = createTmpEnv('glm-review-github-prs');
  try {
    fake.rule('gh', { match: ['api', `repos/${REPO}/pulls/45`], stdout: JSON.stringify({ number: 45 }) });
    await assert.rejects(
      getPrBaseSha(fakeDeps(fake, tmp), REPO, 45),
      (err: unknown) => err instanceof UnexpectedResponseError && /base\.sha/.test(err.message),
    );

    await assert.rejects(getPrBaseSha(fakeDeps(fake, tmp), REPO, 0), /PR 编号/);
  } finally {
    tmp.cleanup();
    fake.remove();
  }
});

test('getDiff：argv 精确、diff 文本原样返回', async () => {
  const fake = createFakeBin();
  const tmp = createTmpEnv('glm-review-github-prs');
  try {
    const diffText = readFileSync(path.join(fixturesDir, 'diff.sample.diff'), 'utf8');
    fake.rule('gh', { mode: 'prefix', match: ['pr', 'diff'], stdout: diffText });
    const diff = await getDiff(fakeDeps(fake, tmp), REPO, 45);

    assert.equal(diff, diffText);
    const calls = fake.calls().filter((call) => call.bin === 'gh');
    assert.deepEqual(calls[0]?.argv, ['pr', 'diff', '45', '--repo', REPO]);
  } finally {
    tmp.cleanup();
    fake.remove();
  }
});

test('getDiff：超过 maxBytes 抛 DiffTooLargeError（默认 2 MB，可自定义）', async () => {
  const tmp = createTmpEnv('glm-review-github-prs');
  try {
    // 超大 diff 不经子进程管道（假 gh 立即退出会丢弃未刷出的缓冲），
    // 直接注入 exec 桩返回大 stdout，同时记录 argv。
    const argvSeen: string[][] = [];
    let stdoutFor: string;
    const deps: GithubDeps = {
      exec: async (cmd, args) => {
        argvSeen.push([cmd, ...args]);
        return { code: 0, stdout: stdoutFor, stderr: '', timedOut: false, durationMs: 1 };
      },
      clock: fixedClock('2026-10-12T00:00:00Z'),
      env: tmp.env,
      paths: resolvePaths(tmp.env),
      log: nullLogger,
    };

    // 默认上限 2 MB：多一个字节也抛。
    stdoutFor = 'x'.repeat(DEFAULT_MAX_DIFF_BYTES + 1);
    await assert.rejects(
      getDiff(deps, REPO, 45),
      (err: unknown) => {
        assert.ok(err instanceof DiffTooLargeError);
        assert.equal(err.name, 'DiffTooLargeError');
        assert.equal(err.maxBytes, DEFAULT_MAX_DIFF_BYTES);
        assert.equal(err.bytes, DEFAULT_MAX_DIFF_BYTES + 1);
        assert.match(err.message, /diff 太大/);
        return true;
      },
    );

    // 恰好等于自定义上限不抛；超过自定义上限抛。
    stdoutFor = 'y'.repeat(2048);
    const atLimit = await getDiff(deps, REPO, 45, { maxBytes: 2048 });
    assert.equal(atLimit, stdoutFor);
    await assert.rejects(getDiff(deps, REPO, 45, { maxBytes: 2047 }), DiffTooLargeError);

    assert.deepEqual(argvSeen, [
      ['gh', 'pr', 'diff', '45', '--repo', REPO],
      ['gh', 'pr', 'diff', '45', '--repo', REPO],
      ['gh', 'pr', 'diff', '45', '--repo', REPO],
    ]);
  } finally {
    tmp.cleanup();
  }
});

test('getPrComments：argv 精确，多页拼接输出被摊平，字段映射', async () => {
  const fake = createFakeBin();
  const tmp = createTmpEnv('glm-review-github-prs');
  try {
    // `gh api --paginate` 的多页形态：多个 JSON 数组依次输出。
    const pages = [
      `[
        {"id": 101, "user": {"login": "Jackeyhan-JH"}, "body": "/glm-review 重审", "created_at": "2026-10-10T08:00:00Z"},
        {"id": 102, "user": {"login": "alice"}, "body": "看起来不错", "created_at": "2026-10-10T09:00:00Z"}
      ]`,
      `[
        {"id": 103, "user": null, "body": "第二条页", "created_at": "2026-10-11T10:00:00Z"}
      ]`,
    ].join('\n');
    fake.rule('gh', { mode: 'prefix', match: ['api'], stdout: pages });
    const comments = await getPrComments(fakeDeps(fake, tmp), REPO, 45);

    assert.deepEqual(comments, [
      { id: 101, author: 'Jackeyhan-JH', body: '/glm-review 重审', createdAt: '2026-10-10T08:00:00Z' },
      { id: 102, author: 'alice', body: '看起来不错', createdAt: '2026-10-10T09:00:00Z' },
      { id: 103, author: '', body: '第二条页', createdAt: '2026-10-11T10:00:00Z' },
    ]);

    const calls = fake.calls().filter((call) => call.bin === 'gh');
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0]?.argv, ['api', `repos/${REPO}/issues/45/comments`, '--paginate']);
  } finally {
    tmp.cleanup();
    fake.remove();
  }
});
