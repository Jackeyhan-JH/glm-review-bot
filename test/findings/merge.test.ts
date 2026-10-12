/**
 * 合并去重 / 排序 / applyThreshold 的验收标准：同文件相近行号且标题相似的
 * 发现去重（保留严重度高者）、按严重度 → 文件 → 行号排序、
 * minSeverity=major & maxComments=2 下的分流结果。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  applyThreshold,
  dedupeFindings,
  mergeChunkReviews,
  normalizeTitle,
  sortFindings,
  titlesSimilar,
} from '../../src/findings/merge.ts';
import { normFinding } from './helpers.ts';

test('标题归一化：去空白标点、统一小写，只留字母数字与 CJK 字符', () => {
  assert.equal(normalizeTitle('Fix: Null-Pointer! 修复'), 'fixnullpointer修复');
  assert.equal(normalizeTitle('  A_b-c D  '), 'abcd');
  assert.equal(normalizeTitle('，，。。'), '');
});

test('标题相似：归一化后相同或一方包含另一方', () => {
  assert.ok(titlesSimilar('修复空指针崩溃', '修复空指针崩溃！'));
  assert.ok(titlesSimilar('空指针崩溃', '请修复空指针崩溃的问题'));
  assert.ok(titlesSimilar('Fix: Null Pointer', 'fix null pointer'));
  assert.ok(!titlesSimilar('空指针崩溃', '未处理的 Promise 拒绝'));
  assert.ok(!titlesSimilar('缺输入校验', '')); // 归一化为空不判相似
});

test('去重：同文件、行号相距 ≤ 2、标题相似 → 合并为一条，保留严重度高者', () => {
  const findings = [
    normFinding({ file: 'a.ts', line: 10, severity: 'minor', title: '空指针崩溃' }),
    normFinding({ file: 'a.ts', line: 12, severity: 'blocker', title: '修复空指针崩溃！' }),
  ];
  const deduped = dedupeFindings(findings);
  assert.equal(deduped.length, 1);
  // 保留严重度高者的内容（行号、标题随内容一起换成 blocker 那条）
  assert.deepEqual(
    { severity: deduped[0]?.severity, line: deduped[0]?.line, title: deduped[0]?.title },
    { severity: 'blocker', line: 12, title: '修复空指针崩溃！' },
  );
});

test('去重：严重度并列时保留先出现者；行号相距 3 不算重复', () => {
  const tie = dedupeFindings([
    normFinding({ file: 'a.ts', line: 10, severity: 'major', title: '空指针', body: '第一条' }),
    normFinding({ file: 'a.ts', line: 11, severity: 'major', title: '空指针崩溃', body: '第二条' }),
  ]);
  assert.equal(tie.length, 1);
  assert.equal(tie[0]?.body, '第一条');

  const apart = dedupeFindings([
    normFinding({ file: 'a.ts', line: 10, title: '空指针崩溃' }),
    normFinding({ file: 'a.ts', line: 13, title: '空指针崩溃' }),
  ]);
  assert.equal(apart.length, 2);
});

test('去重：不同文件、或标题不相似的不去重', () => {
  const kept = dedupeFindings([
    normFinding({ file: 'a.ts', line: 10, title: '空指针崩溃' }),
    normFinding({ file: 'b.ts', line: 10, title: '空指针崩溃' }),
    normFinding({ file: 'a.ts', line: 11, title: '未处理的 Promise 拒绝' }),
  ]);
  assert.equal(kept.length, 3);
});

test('排序：严重度降序 → 文件路径升序 → 行号升序；不改入参', () => {
  const input = [
    normFinding({ severity: 'nit', file: 'a.ts', line: 1 }),
    normFinding({ severity: 'blocker', file: 'b.ts', line: 99 }),
    normFinding({ severity: 'major', file: 'b.ts', line: 1 }),
    normFinding({ severity: 'major', file: 'a.ts', line: 30 }),
    normFinding({ severity: 'major', file: 'a.ts', line: 5 }),
    normFinding({ severity: 'blocker', file: 'a.ts', line: 2 }),
  ];
  const sorted = sortFindings(input);
  assert.deepEqual(
    sorted.map((f) => `${f.severity}:${f.file}:${f.line}`),
    ['blocker:a.ts:2', 'blocker:b.ts:99', 'major:a.ts:5', 'major:a.ts:30', 'major:b.ts:1', 'nit:a.ts:1'],
  );
  // 返回新数组，入参顺序不变
  assert.deepEqual(
    input.map((f) => `${f.severity}:${f.file}:${f.line}`),
    ['nit:a.ts:1', 'blocker:b.ts:99', 'major:b.ts:1', 'major:a.ts:30', 'major:a.ts:5', 'blocker:a.ts:2'],
  );
});

test('mergeChunkReviews：summary 去重拼接、findings 去重排序', () => {
  const merged = mergeChunkReviews([
    {
      summary: '整体尚可，第 1 块问题不多。',
      findings: [
        normFinding({ file: 'a.ts', line: 10, severity: 'minor', title: '空指针崩溃' }),
        normFinding({ file: 'a.ts', line: 20, severity: 'nit', title: '命名建议' }),
      ],
    },
    {
      summary: '整体尚可，第 1 块问题不多。', // 与上一块相同，只留一份
      findings: [normFinding({ file: 'a.ts', line: 11, severity: 'blocker', title: '修复空指针崩溃' })],
    },
    {
      summary: '第 2 块是测试文件，问题集中在错误处理。',
      findings: [],
    },
    { summary: '', findings: [] },
  ]);
  assert.equal(merged.summary, '整体尚可，第 1 块问题不多。\n\n第 2 块是测试文件，问题集中在错误处理。');
  assert.deepEqual(
    merged.findings.map((f) => `${f.severity}:${f.file}:${f.line}`),
    ['blocker:a.ts:11', 'nit:a.ts:20'],
  );
});

test('mergeChunkReviews：空输入返回空结果，不编造总结', () => {
  assert.deepEqual(mergeChunkReviews([]), { summary: '', findings: [] });
  assert.deepEqual(mergeChunkReviews([{ findings: [] }, { summary: '  ', findings: [] }]), {
    summary: '',
    findings: [],
  });
});

test('applyThreshold：minSeverity=major、maxComments=2 的分流', () => {
  const findings = [
    normFinding({ severity: 'blocker', file: 'a.ts', line: 1, title: '问题 A' }), // 占第 1 个行内名额
    normFinding({ severity: 'major', file: 'a.ts', line: 2, title: '问题 B' }), // 占第 2 个行内名额
    normFinding({ severity: 'major', file: 'a.ts', line: 3, title: '问题 C', inline: false }), // 挂不了行 → 总评
    normFinding({ severity: 'minor', file: 'a.ts', line: 4, title: '问题 D' }), // 低于阈值
    normFinding({ severity: 'nit', file: 'a.ts', line: 5, title: '问题 E' }), // 低于阈值
    normFinding({ severity: 'major', file: 'a.ts', line: 6, title: '问题 F' }), // 名额用尽 → 总评
  ];
  const result = applyThreshold(findings, 'major', 2);
  assert.deepEqual(result.inline.map((f) => f.title), ['问题 A', '问题 B']);
  assert.deepEqual(result.overflow.map((f) => f.title), ['问题 C', '问题 F']);
  assert.deepEqual(result.belowThreshold.map((f) => f.title), ['问题 D', '问题 E']);
});

test('applyThreshold：minSeverity=nit、maxComments 大于全部时全部行内（inline=false 的除外）', () => {
  const findings = [
    normFinding({ severity: 'nit', file: 'a.ts', line: 1, title: '问题 A' }),
    normFinding({ severity: 'nit', file: 'a.ts', line: 2, title: '问题 B', inline: false }),
    normFinding({ severity: 'blocker', file: 'a.ts', line: 3, title: '问题 C' }),
  ];
  const result = applyThreshold(findings, 'nit', 20);
  assert.deepEqual(result.inline.map((f) => f.title), ['问题 A', '问题 C']);
  assert.deepEqual(result.overflow.map((f) => f.title), ['问题 B']);
  assert.deepEqual(result.belowThreshold, []);
});

test('applyThreshold：minSeverity=blocker 时 major 及以下全部不发；maxComments=0 时全部并入总评', () => {
  const findings = [
    normFinding({ severity: 'blocker', file: 'a.ts', line: 1, title: '问题 A' }),
    normFinding({ severity: 'major', file: 'a.ts', line: 2, title: '问题 B' }),
  ];
  const strict = applyThreshold(findings, 'blocker', 10);
  assert.deepEqual(strict.inline.map((f) => f.title), ['问题 A']);
  assert.deepEqual(strict.belowThreshold.map((f) => f.title), ['问题 B']);

  // 配额为 0：过阈值的都挂不了行内评论，全部并入总评
  const noQuota = applyThreshold(findings, 'nit', 0);
  assert.deepEqual(noQuota.inline, []);
  assert.deepEqual(noQuota.overflow.map((f) => f.title), ['问题 A', '问题 B']);
  assert.deepEqual(noQuota.belowThreshold, []);
});
