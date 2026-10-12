/**
 * normalizeFindings 的验收标准：文件不存在 / 行号越界可修正 / 不可修正 /
 * 严重度别名 / 多行范围跨 hunk 等情况各有测试；丢弃原因记录在 dropped。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeFindings, normalizeSeverity } from '../../src/findings/validate.ts';
import { CALC_DIFF, GRID_DIFF, SHRINK_DIFF, filesOf, rawFinding } from './helpers.ts';

test('合法发现原样通过：字段、行号（本就可评论）不变', () => {
  const result = normalizeFindings(
    { summary: '有一处问题。', findings: [rawFinding()] },
    filesOf(CALC_DIFF),
  );
  assert.deepEqual(result.dropped, []);
  assert.equal(result.findings.length, 1);
  assert.deepEqual(result.findings[0], {
    severity: 'major',
    file: 'src/calc.ts',
    line: 2,
    title: '空指针未判断',
    body: 'a 可能为 null，直接取属性会崩溃。',
    inline: true,
  });
});

test('文件不在本块 diff 中 → 丢弃并记录原因', () => {
  const result = normalizeFindings(
    { summary: '', findings: [rawFinding({ file: 'src/other.ts' })] },
    filesOf(CALC_DIFF),
  );
  assert.deepEqual(result.findings, []);
  assert.equal(result.dropped.length, 1);
  assert.match(result.dropped[0]?.reason ?? '', /文件不在本块 diff 中.*src\/other\.ts/);
  assert.deepEqual(result.dropped[0]?.raw, rawFinding({ file: 'src/other.ts' }));
});

test('文件在忽略清单里 → 丢弃并记录原因（优先于「不在本块」）', () => {
  const result = normalizeFindings(
    { summary: '', findings: [rawFinding()] },
    filesOf(CALC_DIFF),
    { ignoredPaths: ['src/calc.ts'] },
  );
  assert.deepEqual(result.findings, []);
  assert.match(result.dropped[0]?.reason ?? '', /文件被忽略规则排除.*src\/calc\.ts/);
});

test('行号越界可修正：报了删除行的旧侧行号 → 修正到最近的可评论行', () => {
  // shrink.ts 只有一行可评论（新侧 1）；旧侧 2/3/4 都是删除行
  const result = normalizeFindings(
    { summary: '', findings: [rawFinding({ file: 'src/shrink.ts', line: 3 })] },
    filesOf(SHRINK_DIFF),
  );
  assert.deepEqual(result.dropped, []);
  assert.equal(result.findings[0]?.line, 1);
  assert.equal(result.findings[0]?.inline, true);
});

test('行号不可修正：落在 hunk 区间之外 → inline=false，保留原始行号只进总评', () => {
  const result = normalizeFindings(
    { summary: '', findings: [rawFinding({ file: 'src/shrink.ts', line: 99 })] },
    filesOf(SHRINK_DIFF),
  );
  assert.deepEqual(result.dropped, []);
  assert.deepEqual(
    result.findings.map((f) => ({ line: f.line, inline: f.inline })),
    [{ line: 99, inline: false }],
  );
  // 两个 hunk 之间的空档（grid.txt 的 5..10）同样落不进行内评论
  const gap = normalizeFindings(
    { summary: '', findings: [rawFinding({ file: 'grid.txt', line: 7 })] },
    filesOf(GRID_DIFF),
  );
  assert.deepEqual(gap.findings.map((f) => f.inline), [false]);
});

test('严重度别名归一化：英文别名、大小写、中文名', () => {
  assert.equal(normalizeSeverity('critical'), 'blocker');
  assert.equal(normalizeSeverity('严重'), 'blocker');
  assert.equal(normalizeSeverity('high'), 'major');
  assert.equal(normalizeSeverity('MAJOR'), 'major');
  assert.equal(normalizeSeverity('重要'), 'major');
  assert.equal(normalizeSeverity('medium'), 'minor');
  assert.equal(normalizeSeverity('一般'), 'minor');
  assert.equal(normalizeSeverity('low'), 'nit');
  assert.equal(normalizeSeverity('info'), 'nit');
  assert.equal(normalizeSeverity('建议'), 'nit');
  assert.equal(normalizeSeverity(' Nit '), 'nit');
  // 规范值原样通过；认不出的返回 null
  assert.equal(normalizeSeverity('blocker'), 'blocker');
  assert.equal(normalizeSeverity('urgent'), null);
  assert.equal(normalizeSeverity(3), null);
  assert.equal(normalizeSeverity(''), null);

  const result = normalizeFindings(
    {
      summary: '',
      findings: [rawFinding({ severity: 'critical' }), rawFinding({ severity: '建议', file: 'grid.txt', line: 11 })],
    },
    [...filesOf(CALC_DIFF), ...filesOf(GRID_DIFF)],
  );
  assert.deepEqual(result.findings.map((f) => f.severity), ['blocker', 'nit']);
});

test('结构不合法的发现被丢弃：缺字段 / 类型不对 / 不是对象', () => {
  const bad = [
    rawFinding({ title: undefined }), // 缺标题
    rawFinding({ body: '   ' }), // 说明为空白
    rawFinding({ line: 'abc' }), // 行号不是数字
    rawFinding({ line: 12.5 }), // 行号不是整数
    rawFinding({ line: 0 }), // 行号小于 1
    rawFinding({ severity: 'urgent' }), // 严重度认不出
    rawFinding({ file: '  ' }), // 文件路径为空白
    '不是对象',
    null,
  ];
  const result = normalizeFindings({ summary: '', findings: bad }, filesOf(CALC_DIFF));
  assert.deepEqual(result.findings, []);
  assert.equal(result.dropped.length, bad.length);
  for (const dropped of result.dropped) {
    assert.match(dropped.reason, /结构不合法/);
  }
  assert.equal(result.dropped[7]?.raw, '不是对象');
});

test('整体输出结构不对：不是对象 / 缺 findings 数组 → 全部丢弃', () => {
  for (const raw of ['一段文本', null, 42, [], { summary: '缺 findings' }, { findings: 'nope' }]) {
    const result = normalizeFindings(raw, filesOf(CALC_DIFF));
    assert.deepEqual(result.findings, [], `${JSON.stringify(raw)} 不应产出发现`);
    assert.equal(result.dropped.length, 1);
    assert.match(result.dropped[0]?.reason ?? '', /不是 JSON 对象|缺少 findings 数组/);
  }
});

test('行号容错：模型输出纯数字字符串也能解析', () => {
  const result = normalizeFindings(
    { summary: '', findings: [rawFinding({ line: '3' })] },
    filesOf(CALC_DIFF),
  );
  assert.deepEqual(result.dropped, []);
  assert.equal(result.findings[0]?.line, 3);
});

test('多行范围：同 hunk 内 line/endLine 顺序颠倒时交换', () => {
  const result = normalizeFindings(
    { summary: '', findings: [rawFinding({ file: 'grid.txt', line: 4, endLine: 1 })] },
    filesOf(GRID_DIFF),
  );
  assert.deepEqual(result.dropped, []);
  assert.deepEqual(
    result.findings.map((f) => ({ line: f.line, endLine: f.endLine })),
    [{ line: 1, endLine: 4 }],
  );
});

test('多行范围：跨 hunk 时降为单行（去掉 endLine）', () => {
  const result = normalizeFindings(
    { summary: '', findings: [rawFinding({ file: 'grid.txt', line: 2, endLine: 12 })] },
    filesOf(GRID_DIFF),
  );
  assert.equal(result.findings[0]?.line, 2);
  assert.equal(result.findings[0]?.endLine, undefined);
  assert.equal(result.findings[0]?.inline, true);
});

test('多行范围：endLine 落在 hunk 间空档（不可评论）时降为单行', () => {
  const result = normalizeFindings(
    { summary: '', findings: [rawFinding({ file: 'grid.txt', line: 4, endLine: 7 })] },
    filesOf(GRID_DIFF),
  );
  assert.equal(result.findings[0]?.line, 4);
  assert.equal(result.findings[0]?.endLine, undefined);
});

test('多行范围：endLine 与 line 相同、或行号修正后越过 endLine 时降为单行', () => {
  const same = normalizeFindings(
    { summary: '', findings: [rawFinding({ file: 'grid.txt', line: 12, endLine: 12 })] },
    filesOf(GRID_DIFF),
  );
  assert.equal(same.findings[0]?.endLine, undefined);

  // shrink.ts 的 line=3（旧侧删除行）修正到 1，越过 endLine=2 → 单行
  const overrun = normalizeFindings(
    { summary: '', findings: [rawFinding({ file: 'src/shrink.ts', line: 3, endLine: 2 })] },
    filesOf(SHRINK_DIFF),
  );
  assert.equal(overrun.findings[0]?.line, 1);
  assert.equal(overrun.findings[0]?.endLine, undefined);
});

test('多行范围：endLine 给了但读不出合法值 → 当作未提供', () => {
  const result = normalizeFindings(
    { summary: '', findings: [rawFinding({ file: 'grid.txt', line: 2, endLine: 'many' })] },
    filesOf(GRID_DIFF),
  );
  assert.deepEqual(result.dropped, []);
  assert.equal(result.findings[0]?.line, 2);
  assert.equal(result.findings[0]?.endLine, undefined);
});

test('落不进可评论行的发现不保留 endLine（只进总评）', () => {
  const result = normalizeFindings(
    { summary: '', findings: [rawFinding({ file: 'src/shrink.ts', line: 99, endLine: 120 })] },
    filesOf(SHRINK_DIFF),
  );
  assert.deepEqual(
    result.findings.map((f) => ({ line: f.line, endLine: f.endLine, inline: f.inline })),
    [{ line: 99, endLine: undefined, inline: false }],
  );
});

test('title / body / suggestion 超长截断与空值处理', () => {
  const longTitle = '题'.repeat(100);
  const longBody = '文'.repeat(1000);
  const result = normalizeFindings(
    {
      summary: '',
      findings: [
        rawFinding({ title: longTitle, body: longBody, suggestion: 'x'.repeat(5000) }),
        rawFinding({ suggestion: '   ' }), // 空白 suggestion 视为未提供
      ],
    },
    filesOf(CALC_DIFF),
  );
  const [first, second] = result.findings;
  assert.equal(Array.from(first?.title ?? '').length, 60);
  assert.ok(first?.title.endsWith('…'));
  assert.equal(Array.from(first?.body ?? '').length, 800);
  assert.ok(first?.body.endsWith('…'));
  assert.equal(Array.from(first?.suggestion ?? '').length, 2000);
  assert.ok(first?.suggestion?.endsWith('…'));
  assert.equal(second?.suggestion, undefined);
});

test('空 findings 与多条发现：正常路径', () => {
  const empty = normalizeFindings({ summary: '没问题', findings: [] }, filesOf(CALC_DIFF));
  assert.deepEqual(empty.findings, []);
  assert.deepEqual(empty.dropped, []);

  const multi = normalizeFindings(
    {
      summary: '两处问题。',
      findings: [rawFinding({ line: 2 }), rawFinding({ file: 'grid.txt', line: 12, severity: 'nit', title: '另一个标题', body: '另一个说明。' })],
    },
    [...filesOf(CALC_DIFF), ...filesOf(GRID_DIFF)],
  );
  assert.equal(multi.findings.length, 2);
  assert.deepEqual(multi.dropped, []);
});
