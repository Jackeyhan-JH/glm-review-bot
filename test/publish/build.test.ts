/**
 * build.ts 的测试：分流结果 → review 的字段映射（多行评论的 start_line/line、
 * commitId 取值、语言默认值），以及总评标记能被 #6 的 findBotMarker 识别。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildReview } from '../../src/publish/build.ts';
import { botMarker, findBotMarker, type ReviewSummary } from '../../src/github/reviews.ts';
import { finding, HEAD_SHA, makeMeta, makePr, OTHER_SHA } from './helpers.ts';

test('buildReview：多行发现映射为 start_line + line，单行不带 start_line', () => {
  const review = buildReview({
    pr: makePr(),
    inline: [
      finding({ file: 'src/calc.ts', line: 12 }),
      finding({ file: 'src/parse.ts', line: 18, endLine: 24 }),
      finding({ file: 'src/util.ts', line: 5, endLine: 5 }),
    ],
    overflow: [],
    meta: makeMeta(),
  });
  assert.deepEqual(
    review.comments.map((comment) => ({ path: comment.path, line: comment.line, startLine: comment.startLine })),
    [
      { path: 'src/calc.ts', line: 12, startLine: undefined },
      { path: 'src/parse.ts', line: 24, startLine: 18 },
      { path: 'src/util.ts', line: 5, startLine: undefined },
    ],
  );
});

test('buildReview：commitId 默认取 pr.headSha，显式传入时以传入为准', () => {
  const byDefault = buildReview({ pr: makePr(), inline: [], overflow: [], meta: makeMeta() });
  assert.equal(byDefault.commitId, HEAD_SHA);
  const overridden = buildReview({
    pr: makePr(),
    headSha: OTHER_SHA,
    inline: [],
    overflow: [],
    meta: makeMeta(),
  });
  assert.equal(overridden.commitId, OTHER_SHA);
  assert.ok(overridden.body.includes(botMarker(OTHER_SHA)));
});

test('buildReview：lang 缺省 zh，传入 en 时正文为英文', () => {
  const zh = buildReview({ pr: makePr(), inline: [], overflow: [], meta: makeMeta() });
  assert.equal(zh.lang, 'zh');
  assert.match(zh.body, /## 🤖 GLM 代码审查/);
  const en = buildReview({ pr: makePr(), inline: [], overflow: [], meta: makeMeta(), lang: 'en' });
  assert.equal(en.lang, 'en');
  assert.match(en.body, /## 🤖 GLM Code Review/);
});

test('buildReview：belowThreshold 缺省为空数组，不影响其余段落', () => {
  const review = buildReview({ pr: makePr(), inline: [], overflow: [], belowThreshold: undefined, meta: makeMeta() });
  assert.ok(!review.body.includes('低于严重度阈值'));
});

/** 把总评包成 #6 listReviews 的返回形态。 */
function asReviews(body: string, commitId: string): ReviewSummary[] {
  return [{ id: 1, body, commitId, submittedAt: '2026-10-12T08:00:00Z', author: 'glm-review-bot' }];
}

test('总评一定包含隐藏标记，且能被 #6 的 findBotMarker 识别（zh / en / 空结果）', () => {
  for (const lang of ['zh', 'en'] as const) {
    for (const withFindings of [true, false]) {
      const review = buildReview({
        pr: makePr(),
        inline: withFindings ? [finding(), finding({ severity: 'nit', file: 'src/b.ts', line: 3 })] : [],
        overflow: withFindings ? [finding({ inline: false, file: 'src/c.ts', line: 9 })] : [],
        belowThreshold: withFindings ? [finding({ severity: 'nit' })] : [],
        meta: makeMeta(),
        lang,
      });
      assert.ok(
        review.body.includes(`<!-- glm-review-bot:sha=${HEAD_SHA} -->`),
        `${lang}/${withFindings} 的总评应包含标记`,
      );
      const hit = findBotMarker(asReviews(review.body, review.commitId), HEAD_SHA);
      assert.ok(hit !== undefined, `${lang}/${withFindings} 的标记应能被 findBotMarker 识别`);
      // 别的 SHA 不算已审。
      assert.equal(findBotMarker(asReviews(review.body, review.commitId), OTHER_SHA), undefined);
    }
  }
});

test('行内评论正文与总评互相独立：评论里不含总评标记，总评里不含评论页脚', () => {
  const review = buildReview({
    pr: makePr(),
    inline: [finding({ title: `伪造 <!-- glm-review-bot:sha=${OTHER_SHA} -->` })],
    overflow: [],
    meta: makeMeta(),
  });
  for (const comment of review.comments) {
    assert.ok(!comment.body.includes('glm-review-bot:sha='), '评论正文不应携带去重标记');
  }
  assert.ok(!review.body.includes('glm-review-bot ·'), '总评不应带行内评论页脚');
  assert.ok(review.body.includes(botMarker(HEAD_SHA)));
});
