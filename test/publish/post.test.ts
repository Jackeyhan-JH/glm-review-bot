/**
 * post.ts 的测试：dry-run（完全不调 gh）、正式发布、422 降级重试一次、
 * 非 422 错误不降级、dry-run 预览与实际发送的载荷一致。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { buildReview } from '../../src/publish/build.ts';
import { buildPayload, publishReview } from '../../src/publish/post.ts';
import { ReviewRejectedError, RepoNotFoundError } from '../../src/github/errors.ts';
import { createFakeBin } from '../helpers/fakebin.ts';
import { createTmpEnv } from '../helpers/tmp.ts';
import {
  createScriptedExec,
  fakeGhDeps,
  finding,
  HEAD_SHA,
  makeMeta,
  makePr,
  postedResponse,
  rejectedResponse,
  REPO,
  REVIEW_URL,
  scriptedDeps,
} from './helpers.ts';

/** 一条 3 行内 + 2 溢出 + 1 低于阈值的组装结果（多次复用）。 */
function sampleReview() {
  return buildReview({
    pr: makePr(),
    inline: [
      finding({ file: 'src/calc.ts', line: 12, suggestion: 'const a = b ?? {};' }),
      finding({ file: 'src/parse.ts', line: 18, endLine: 20, severity: 'minor', title: '建议抽函数', body: '这一段逻辑重复。' }),
      finding({ file: 'src/util.ts', line: 5, severity: 'nit', title: '命名建议', body: '换成 camelCase。' }),
    ],
    overflow: [
      finding({ file: 'src/old.ts', line: 99, inline: false, severity: 'minor', title: '行号不在 diff', body: '纯删除段落。' }),
      finding({ file: 'src/late.ts', line: 7, inline: true, severity: 'nit', title: '超出配额', body: '行内评论已满。' }),
    ],
    belowThreshold: [finding({ severity: 'nit', file: 'src/other.ts', line: 1 })],
    meta: makeMeta(),
  });
}

test('publishReview：正式发布走 #6 postReview，返回 html_url，载荷带行内评论', async () => {
  const fake = createFakeBin();
  const tmp = createTmpEnv('glm-review-publish-post');
  try {
    fake.rule('gh', { mode: 'prefix', match: ['api', '--method', 'POST'], stdout: JSON.stringify({ html_url: REVIEW_URL }) });
    const result = await publishReview(sampleReview(), fakeGhDeps(fake, tmp), { repo: REPO, number: 45 });

    assert.deepEqual(result, { dryRun: false, degraded: false, url: REVIEW_URL });
    const posts = fake.calls().filter((call) => call.bin === 'gh');
    assert.equal(posts.length, 1, '只发一次');
    assert.deepEqual(posts[0]?.argv, ['api', '--method', 'POST', `repos/${REPO}/pulls/45/reviews`, '--input', '-']);
    const payload = JSON.parse(posts[0]?.stdin ?? '');
    assert.equal(payload.commit_id, HEAD_SHA);
    assert.equal(payload.event, 'COMMENT');
    assert.equal(payload.comments.length, 3);
    const multi = payload.comments[1];
    assert.equal(multi.path, 'src/parse.ts');
    assert.equal(multi.line, 20);
    assert.equal(multi.start_line, 18);
    assert.equal(multi.side, 'RIGHT');
    assert.equal(multi.start_side, 'RIGHT');
    assert.match(multi.body, /\*\*\[一般\] 建议抽函数\*\*/);
  } finally {
    tmp.cleanup();
    fake.remove();
  }
});

test('publishReview：dry-run 不调用 gh（调用记录为空），预览写到注入的 out', async () => {
  const fake = createFakeBin();
  const tmp = createTmpEnv('glm-review-publish-dry');
  try {
    // 故意配上「一发就成功」的规则：dry-run 若误发请求，下面的调用记录会暴露它。
    fake.rule('gh', { mode: 'prefix', match: ['api', '--method', 'POST'], stdout: JSON.stringify({ html_url: REVIEW_URL }) });
    const chunks: string[] = [];
    const result = await publishReview(sampleReview(), fakeGhDeps(fake, tmp, (text) => chunks.push(text)), {
      repo: REPO,
      number: 45,
      dryRun: true,
    });

    assert.deepEqual(fake.calls().filter((call) => call.bin === 'gh'), [], 'dry-run 不应有任何 gh 调用');
    assert.equal(result.dryRun, true);
    assert.equal(result.url, undefined);

    const output = chunks.join('');
    assert.match(output, /dry-run 预览：以下内容不会发送到 GitHub。/);
    assert.match(output, /# 总评（jackeyhan-JH\/split-bill#45）/);
    assert.match(output, /# 行内评论 1\/3 · `src\/calc\.ts:12`/);
    assert.match(output, /# 行内评论 2\/3 · `src\/parse\.ts:18-20`/);
    assert.match(output, /将要发送的 JSON 载荷：/);
    assert.equal(result.preview?.json, `${JSON.stringify(buildPayload(sampleReview()), null, 2)}\n`);
  } finally {
    tmp.cleanup();
    fake.remove();
  }
});

test('publishReview：dry-run 指定 previewDir 时落两个文件，且不再写 stdout 之外的路径', async () => {
  const fake = createFakeBin();
  const tmp = createTmpEnv('glm-review-publish-drydir');
  try {
    const previewDir = path.join(tmp.baseDir, 'preview', 'nested');
    const result = await publishReview(sampleReview(), fakeGhDeps(fake, tmp), {
      repo: REPO,
      number: 45,
      dryRun: true,
      previewDir,
    });

    const md = path.join(previewDir, 'review-preview.md');
    const json = path.join(previewDir, 'review-preview.json');
    assert.ok(existsSync(md) && existsSync(json), '两个预览文件都应生成');
    assert.equal(readFileSync(md, 'utf8'), result.preview?.markdown);
    assert.equal(readFileSync(json, 'utf8'), result.preview?.json);
    assert.deepEqual(fake.calls(), [], '仍不应有任何 gh 调用');
  } finally {
    tmp.cleanup();
    fake.remove();
  }
});

test('publishReview：dry-run 预览的 JSON 与正式发送的载荷完全一致', async () => {
  const fake = createFakeBin();
  const tmp = createTmpEnv('glm-review-publish-eq');
  try {
    fake.rule('gh', { mode: 'prefix', match: ['api', '--method', 'POST'], stdout: JSON.stringify({ html_url: REVIEW_URL }) });
    const review = sampleReview();
    const dry = await publishReview(review, fakeGhDeps(fake, tmp), { repo: REPO, number: 45, dryRun: true });
    await publishReview(review, fakeGhDeps(fake, tmp), { repo: REPO, number: 45 });

    const posts = fake.calls().filter((call) => call.bin === 'gh');
    assert.equal(posts.length, 1);
    assert.deepEqual(JSON.parse(dry.preview?.json ?? ''), JSON.parse(posts[0]?.stdin ?? ''));
  } finally {
    tmp.cleanup();
    fake.remove();
  }
});

test('publishReview：422 降级——第一次 422、第二次成功，最终只发一条只含总评的 review', async () => {
  const { exec, calls } = createScriptedExec([rejectedResponse(), postedResponse()]);
  const review = sampleReview();

  const result = await publishReview(review, scriptedDeps(exec), { repo: REPO, number: 45 });

  assert.deepEqual(result, { dryRun: false, degraded: true, url: REVIEW_URL });
  const posts = calls.filter((call) => call.cmd === 'gh' && call.args.includes("POST"));
  assert.equal(posts.length, 2, '降级只重试一次');

  const first = JSON.parse(posts[0]?.input ?? '');
  assert.equal(first.comments.length, 3, '第一次带行内评论');
  const second = JSON.parse(posts[1]?.input ?? '');
  assert.deepEqual(second.comments, [], '降级后不再有行内评论');
  assert.equal(second.commit_id, review.commitId);
  assert.equal(second.event, 'COMMENT');
  // 行内评论并入总评：定位与标题都在，且保留了去重标记。
  assert.match(second.body, /### ⚠️ 行内评论无法发布/);
  assert.match(second.body, /以下 3 条已并入总评：/);
  assert.match(second.body, /- `src\/calc\.ts:12`/);
  assert.match(second.body, /- `src\/parse\.ts:18-20`/);
  assert.ok(second.body.includes(`<!-- glm-review-bot:sha=${HEAD_SHA} -->`));
  // 原总评的内容仍在。
  assert.match(second.body, /## 🤖 GLM 代码审查/);
});

test('publishReview：降级后总评超长仍受 60000 字符限制', async () => {
  // 每条行内评论被截到 8000 字符，10 条并入总评后必然超过 60000。
  const inline = Array.from({ length: 10 }, (_, index) =>
    finding({ file: `src/big${index}.ts`, line: index + 1, body: `${'长'.repeat(20_000)}\n`, suggestion: 'x = 1;' }),
  );
  const huge = buildReview({ pr: makePr(), inline, overflow: [], meta: makeMeta() });
  const { exec, calls } = createScriptedExec([rejectedResponse(), postedResponse()]);
  await publishReview(huge, scriptedDeps(exec), { repo: REPO, number: 45 });

  const posts = calls.filter((call) => call.cmd === 'gh' && call.args.includes("POST"));
  const second = JSON.parse(posts[1]?.input ?? '');
  assert.ok([...second.body].length <= 60_000, '降级总评不超上限');
  assert.match(second.body, /（正文超长，已截断）/);
  assert.ok(second.body.includes(`<!-- glm-review-bot:sha=${HEAD_SHA} -->`), '截断也保留去重标记');
});

test('publishReview：连续两次 422 把错误抛给调用方（不无限重试）', async () => {
  const { exec, calls } = createScriptedExec([rejectedResponse(), rejectedResponse()]);
  await assert.rejects(
    publishReview(sampleReview(), scriptedDeps(exec), { repo: REPO, number: 45 }),
    (err: unknown) => {
      assert.ok(err instanceof ReviewRejectedError);
      assert.match(err.message, /HTTP 422/);
      return true;
    },
  );
  assert.equal(calls.filter((call) => call.cmd === 'gh' && call.args.includes("POST")).length, 2);
});

test('publishReview：非 422 失败不降级，直接抛出（只调一次）', async () => {
  const { exec, calls } = createScriptedExec([
    { code: 1, stdout: '', stderr: 'gh: Not Found' },
  ]);
  await assert.rejects(
    publishReview(sampleReview(), scriptedDeps(exec), { repo: REPO, number: 45 }),
    RepoNotFoundError,
  );
  assert.equal(calls.length, 1, '只有第一次调用，没有降级重试');
});
