/**
 * parseReviewCommands 的测试（验收标准）：/glm-review 与 /glm-review full 的识别、
 * 非 owner 不认、引用块与代码块里不认、同一评论只触发一次。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DEFAULT_COMMAND_OWNERS,
  parseReviewCommands,
} from '../../src/triggers/commands.ts';
import { makeComment } from './helpers.ts';

test('/glm-review 单独一行 → 触发重审（full=false）', () => {
  const r = parseReviewCommands([makeComment({ body: '帮我重审一下\n/glm-review\n谢谢' })]);
  assert.equal(r.commands.length, 1);
  assert.equal(r.commands[0]?.full, false);
  assert.equal(r.commands[0]?.commentId, 1001);
});

test('/glm-review full → full=true（其余相同）', () => {
  const r = parseReviewCommands([makeComment({ body: '/glm-review full' })]);
  assert.equal(r.commands.length, 1);
  assert.equal(r.commands[0]?.full, true);
});

test('大小写与词间空白宽松：/GLM-REVIEW FULL、双空格都认', () => {
  assert.equal(parseReviewCommands([makeComment({ body: '/GLM-REVIEW FULL' })]).commands[0]?.full, true);
  assert.equal(parseReviewCommands([makeComment({ body: '  /glm-review   full  ' })]).commands[0]?.full, true);
  assert.equal(parseReviewCommands([makeComment({ body: '/GLM-Review' })]).commands.length, 1);
});

test('不是整行命令的不认：句子中提及、带多余参数、行内代码', () => {
  for (const body of [
    '请 /glm-review 一下',
    '/glm-review foo bar',
    '/glm-review --force',
    '`/glm-review`',
    '看 `/glm-review` 的用法',
    '/glm-reviewful',
  ]) {
    assert.equal(parseReviewCommands([makeComment({ body })]).commands.length, 0, `正文 "${body}" 不应触发`);
  }
});

test('非 owner 发的不认（默认只认 Jackeyhan-JH）', () => {
  assert.deepEqual(DEFAULT_COMMAND_OWNERS, ['Jackeyhan-JH']);
  const r = parseReviewCommands([
    makeComment({ id: 1, author: 'contributor', body: '/glm-review' }),
    makeComment({ id: 2, author: 'jackeyhan-jh', body: '/glm-review' }), // 登录名不区分大小写
  ]);
  assert.equal(r.commands.length, 1);
  assert.equal(r.commands[0]?.commentId, 2);
});

test('owners 可配置（如换仓库 owner）', () => {
  const comments = [
    makeComment({ id: 1, author: 'alice', body: '/glm-review' }),
    makeComment({ id: 2, author: 'Jackeyhan-JH', body: '/glm-review' }),
  ];
  const r = parseReviewCommands(comments, undefined, { owners: ['alice'] });
  assert.deepEqual(r.commands.map((c) => c.commentId), [1]);
});

test('引用块里的 > /glm-review 不认', () => {
  for (const body of ['> /glm-review', '> /glm-review full', '  > /glm-review', '>/glm-review', '> 引用\n> /glm-review']) {
    assert.equal(parseReviewCommands([makeComment({ body })]).commands.length, 0, `正文 "${body}" 不应触发`);
  }
});

test('围栏代码块（``` / ~~~）里的命令不认，块外的照常认', () => {
  const fenced = ['```', '/glm-review', '/glm-review full', '```'].join('\n');
  assert.equal(parseReviewCommands([makeComment({ body: fenced })]).commands.length, 0);
  const tilde = ['~~~bash', '/glm-review', '~~~'].join('\n');
  assert.equal(parseReviewCommands([makeComment({ body: tilde })]).commands.length, 0);
  const mixed = ['/glm-review', '```', '/glm-review full', '```'].join('\n');
  const r = parseReviewCommands([makeComment({ body: mixed })]);
  assert.equal(r.commands.length, 1);
  assert.equal(r.commands[0]?.full, false);
  // 未闭合围栏：围栏之后全部是代码。
  const unclosed = ['```md', '/glm-review'].join('\n');
  assert.equal(parseReviewCommands([makeComment({ body: unclosed })]).commands.length, 0);
});

test('缩进代码块（4 空格 / Tab）里的命令不认', () => {
  assert.equal(parseReviewCommands([makeComment({ body: '    /glm-review' })]).commands.length, 0);
  assert.equal(parseReviewCommands([makeComment({ body: '\t/glm-review' })]).commands.length, 0);
  assert.equal(parseReviewCommands([makeComment({ body: '  \t/glm-review' })]).commands.length, 0);
});

test('同一评论只触发一次：processedCommentIds 里的 id 不再触发', () => {
  const comment = makeComment({ id: 42, body: '/glm-review' });
  const first = parseReviewCommands([comment]);
  assert.deepEqual(first.commands.map((c) => c.commentId), [42]);
  assert.deepEqual(first.processedCommentIds, [42]);
  // 再次轮询看到同一条评论（甚至重复出现在列表里）不再触发。
  const second = parseReviewCommands([comment, comment], undefined, {
    processedCommentIds: first.processedCommentIds,
  });
  assert.equal(second.commands.length, 0);
  assert.deepEqual(second.processedCommentIds, [42]);
});

test('processedCommentIds 返回旧集合 ∪ 本次新触发，升序去重', () => {
  const r = parseReviewCommands(
    [makeComment({ id: 30, createdAt: '2026-10-12T03:00:00Z', body: '/glm-review' })],
    undefined,
    { processedCommentIds: [50, 10, 10] },
  );
  assert.deepEqual(r.processedCommentIds, [10, 30, 50]);
});

test('since 水位线：早于 since 的评论不扫，之后的照常', () => {
  const comments = [
    makeComment({ id: 1, createdAt: '2026-10-12T00:30:00Z', body: '/glm-review' }),
    makeComment({ id: 2, createdAt: '2026-10-12T01:30:00Z', body: '/glm-review' }),
  ];
  const r = parseReviewCommands(comments, '2026-10-12T01:00:00Z');
  assert.deepEqual(r.commands.map((c) => c.commentId), [2]);
  // Date 也可以；等于水位线的算新评论（精确去重交给 processedCommentIds）。
  assert.deepEqual(
    parseReviewCommands(comments, new Date('2026-10-12T00:30:00Z')).commands.map((c) => c.commentId),
    [1, 2],
  );
  // 水位线兜底失效（状态库丢失）时，靠 processedCommentIds 防重复触发。
  const again = parseReviewCommands(comments, undefined, { processedCommentIds: [1, 2] });
  assert.equal(again.commands.length, 0);
});

test('多条命令按时间升序返回，full 与普通并存', () => {
  const comments = [
    makeComment({ id: 3, createdAt: '2026-10-12T03:00:00Z', body: '/glm-review full' }),
    makeComment({ id: 1, createdAt: '2026-10-12T01:00:00Z', body: '/glm-review' }),
    makeComment({ id: 2, createdAt: '2026-10-12T02:00:00Z', body: '无关评论' }),
  ];
  const r = parseReviewCommands(comments);
  assert.deepEqual(
    r.commands.map((c) => ({ id: c.commentId, full: c.full })),
    [{ id: 1, full: false }, { id: 3, full: true }],
  );
  assert.deepEqual(r.processedCommentIds, [1, 3]);
});

test('一条评论里同时出现普通与 full 命令行 → 按最强的算 full', () => {
  const body = ['先来一次', '/glm-review', '再来一次全量', '/glm-review full'].join('\n');
  const r = parseReviewCommands([makeComment({ body })]);
  assert.equal(r.commands.length, 1);
  assert.equal(r.commands[0]?.full, true);
});

test('空列表 / 无命令 → 空结果，processedCommentIds 原样返回', () => {
  assert.deepEqual(parseReviewCommands([]), { commands: [], processedCommentIds: [] });
  const r = parseReviewCommands([makeComment({ body: '普通讨论' })], undefined, {
    processedCommentIds: [7],
  });
  assert.deepEqual(r, { commands: [], processedCommentIds: [7] });
});
