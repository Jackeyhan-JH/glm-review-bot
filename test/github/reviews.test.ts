/**
 * reviews.ts 的测试：listReviews / findBotMarker / postReview（假 gh，断言 argv 与 stdin JSON）。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ReviewRejectedError, UnexpectedResponseError } from '../../src/github/errors.ts';
import { botMarker, findBotMarker, listReviews, postReview, type ReviewSummary } from '../../src/github/reviews.ts';
import { createFakeBin } from '../helpers/fakebin.ts';
import { createTmpEnv } from '../helpers/tmp.ts';
import { fakeDeps, REPO, SHA_A, SHA_B } from './helpers.ts';

function makeReviews(): ReviewSummary[] {
  return [
    { id: 1, body: '总体不错，两个小问题见行内。', commitId: 'old'.padEnd(40, '0'), submittedAt: '2026-10-09T08:00:00Z', author: 'glm-review-bot' },
    { id: 2, body: `审查完成 ${botMarker(SHA_A)}`, commitId: SHA_A, submittedAt: '2026-10-10T08:00:00Z', author: 'glm-review-bot' },
    { id: 3, body: `审查完成 ${botMarker(SHA_B)}\n再见`, commitId: SHA_B, submittedAt: '2026-10-11T08:00:00Z', author: 'glm-review-bot' },
    { id: 4, body: '人工审阅：LGTM', commitId: SHA_A, submittedAt: '2026-10-11T09:00:00Z', author: 'someone' },
  ];
}

test('findBotMarker：多条 review 中找到对应 SHA 的标记', () => {
  const reviews = makeReviews();
  const hit = findBotMarker(reviews, SHA_A);
  assert.equal(hit?.id, 2);
  assert.equal(findBotMarker(reviews, SHA_B)?.id, 3);
});

test('findBotMarker：别的 SHA（含同前缀、人工评论）不算已审', () => {
  const reviews = makeReviews();
  // 同前缀更长 / 更短的 SHA 都不匹配。
  assert.equal(findBotMarker(reviews, `${SHA_A}00`), undefined);
  assert.equal(findBotMarker(reviews, SHA_A.slice(0, 38)), undefined);
  // 完全没出现过的 SHA 不匹配；没有标记的人工评论不算。
  const other = 'fedcba9876543210fedcba9876543210fedcba98';
  assert.equal(findBotMarker(reviews, other), undefined);
  assert.equal(findBotMarker([], other), undefined);
});

test('listReviews：argv 精确，字段映射', async () => {
  const fake = createFakeBin();
  const tmp = createTmpEnv('glm-review-github-reviews');
  try {
    const stdout = `[
      {"id": 11, "body": "第一条", "commit_id": "${SHA_A}", "submitted_at": "2026-10-10T08:00:00Z", "user": {"login": "glm-review-bot"}},
      {"id": 12, "body": "", "commit_id": "${SHA_B}", "submitted_at": "2026-10-11T08:00:00Z", "user": null}
    ]`;
    fake.rule('gh', { mode: 'prefix', match: ['api'], stdout });
    const reviews = await listReviews(fakeDeps(fake, tmp), REPO, 45);

    assert.deepEqual(reviews, [
      { id: 11, body: '第一条', commitId: SHA_A, submittedAt: '2026-10-10T08:00:00Z', author: 'glm-review-bot' },
      { id: 12, body: '', commitId: SHA_B, submittedAt: '2026-10-11T08:00:00Z', author: '' },
    ]);

    const calls = fake.calls().filter((call) => call.bin === 'gh');
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0]?.argv, ['api', `repos/${REPO}/pulls/45/reviews`, '--paginate']);
  } finally {
    tmp.cleanup();
    fake.remove();
  }
});

test('postReview：argv 与 stdin JSON 精确，行内评论统一 RIGHT，返回 html_url', async () => {
  const fake = createFakeBin();
  const tmp = createTmpEnv('glm-review-github-reviews');
  try {
    const htmlUrl = `https://github.com/${REPO}/pull/45#pullrequestreview-99`;
    fake.rule('gh', { mode: 'prefix', match: ['api', '--method', 'POST'], stdout: JSON.stringify({ html_url: htmlUrl }) });
    const url = await postReview(fakeDeps(fake, tmp), REPO, 45, {
      commitId: SHA_A,
      body: '总评：整体清晰，有 3 条建议。',
      comments: [
        { path: 'src/calc.ts', line: 12, body: '这里没处理 n <= 0。' },
        { path: 'src/parse.ts', line: 20, startLine: 18, body: '这一段建议抽成函数。' },
        { path: 'src/util.ts', line: 5, startLine: 5, body: 'start_line 与 line 相同按单行发布。' },
      ],
    });

    assert.equal(url, htmlUrl);
    const calls = fake.calls().filter((call) => call.bin === 'gh');
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0]?.argv, [
      'api',
      '--method',
      'POST',
      `repos/${REPO}/pulls/45/reviews`,
      '--input',
      '-',
    ]);
    assert.deepEqual(JSON.parse(calls[0]?.stdin ?? ''), {
      commit_id: SHA_A,
      body: '总评：整体清晰，有 3 条建议。',
      event: 'COMMENT',
      comments: [
        { path: 'src/calc.ts', line: 12, side: 'RIGHT', body: '这里没处理 n <= 0。' },
        { path: 'src/parse.ts', line: 20, side: 'RIGHT', start_line: 18, start_side: 'RIGHT', body: '这一段建议抽成函数。' },
        { path: 'src/util.ts', line: 5, side: 'RIGHT', body: 'start_line 与 line 相同按单行发布。' },
      ],
    });
  } finally {
    tmp.cleanup();
    fake.remove();
  }
});

test('postReview：event 恒为 COMMENT，调用方传别的值也被忽略', async () => {
  const fake = createFakeBin();
  const tmp = createTmpEnv('glm-review-github-reviews');
  try {
    fake.rule('gh', { mode: 'prefix', match: ['api', '--method', 'POST'], stdout: '{"html_url":"https://x/1"}' });
    for (const event of ['APPROVE', 'REQUEST_CHANGES', 'COMMENT']) {
      fake.resetCalls();
      await postReview(fakeDeps(fake, tmp), REPO, 45, {
        commitId: SHA_A,
        body: '总评',
        comments: [],
        event,
      });
      const stdin = fake.calls()[0]?.stdin ?? '';
      assert.equal(JSON.parse(stdin).event, 'COMMENT', `传入 ${event} 时仍应为 COMMENT`);
    }
  } finally {
    tmp.cleanup();
    fake.remove();
  }
});

test('postReview：422 映射为 ReviewRejectedError，带 GitHub 返回的错误信息', async () => {
  const fake = createFakeBin();
  const tmp = createTmpEnv('glm-review-github-reviews');
  try {
    const ghError = `gh: HTTP 422: Validation Failed - https://api.github.com/repos/${REPO}/pulls/45/reviews\n{"message":"Validation Failed","errors":[{"message":"Invalid line number"}]}`;
    fake.rule('gh', { mode: 'prefix', match: ['api', '--method', 'POST'], stdout: '', stderr: ghError, code: 1 });
    await assert.rejects(
      postReview(fakeDeps(fake, tmp), REPO, 45, { commitId: SHA_A, body: '总评', comments: [{ path: 'a.ts', line: 999, body: '行号不在 diff 里' }] }),
      (err: unknown) => {
        assert.ok(err instanceof ReviewRejectedError);
        assert.equal(err.name, 'ReviewRejectedError');
        assert.match(err.message, /HTTP 422/);
        assert.match(err.message, /行内评论/);
        assert.ok(err.details.includes('Validation Failed'), 'details 保留 GitHub 原始信息');
        return true;
      },
    );
  } finally {
    tmp.cleanup();
    fake.remove();
  }
});

test('postReview：响应缺 html_url 抛 UnexpectedResponseError', async () => {
  const fake = createFakeBin();
  const tmp = createTmpEnv('glm-review-github-reviews');
  try {
    fake.rule('gh', { mode: 'prefix', match: ['api', '--method', 'POST'], stdout: '{"id": 1}' });
    await assert.rejects(
      postReview(fakeDeps(fake, tmp), REPO, 45, { commitId: SHA_A, body: '总评' }),
      UnexpectedResponseError,
    );
  } finally {
    tmp.cleanup();
    fake.remove();
  }
});
