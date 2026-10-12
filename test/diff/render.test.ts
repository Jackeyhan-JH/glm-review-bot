/**
 * render：给模型看的行号标注格式（宽度 4 的行号区，与 issue #7 的示例一致）。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseDiff } from '../../src/diff/parse.ts';
import {
  LINE_NUMBER_WIDTH,
  renderDiffLine,
  renderFileSlice,
  sliceOf,
} from '../../src/diff/render.ts';
import { loadFixture } from './helpers.ts';

test('renderDiffLine：与 issue 示例一致的格式「行号区(4) 空格 种类 空格 文本」', () => {
  assert.equal(LINE_NUMBER_WIDTH, 4);
  assert.equal(
    renderDiffLine({ kind: '+', text: 'const x = 1;', newLine: 42 }),
    '  42 + const x = 1;',
  );
  assert.equal(
    renderDiffLine({ kind: ' ', text: 'ctx', oldLine: 7, newLine: 7 }),
    '   7   ctx',
  );
  // 删除行没有新文件行号：行号区 4 个空格 + 分隔空格。
  assert.equal(
    renderDiffLine({ kind: '-', text: 'old line', oldLine: 9 }),
    '     - old line',
  );
});

test('renderDiffLine：行号超过 4 位时自然加宽', () => {
  assert.equal(renderDiffLine({ kind: '+', text: 'x', newLine: 12_345 }), '12345 + x');
  assert.equal(renderDiffLine({ kind: '+', text: 'x', newLine: 123_456 }), '123456 + x');
});

test('renderFileSlice：文件头 + 状态行 + hunk 头 + 带行号正文', () => {
  const [file] = parseDiff(loadFixture('modified'));
  assert.deepEqual(renderFileSlice(sliceOf(file)), [
    '### 文件: src/calc.ts',
    '（修改，+3 行 -0 行）',
    '@@ -1,4 +1,7 @@',
    '   1   export function add(a: number, b: number): number {',
    '   2 +   if (!Number.isFinite(a) || !Number.isFinite(b)) {',
    "   3 +     throw new Error('参数必须是数字');",
    '   4 +   }',
    '   5     return a + b;',
    '   6   }',
    '   7   ',
  ]);
});

test('renderFileSlice：新增 / 删除 / 重命名 / 二进制的状态行', () => {
  const [added] = parseDiff(loadFixture('added'));
  assert.equal(renderFileSlice(sliceOf(added))[1], '（新增文件，+4 行）');

  const [deleted] = parseDiff(loadFixture('deleted'));
  assert.equal(renderFileSlice(sliceOf(deleted))[1], '（删除文件，-2 行）');

  const [renamed] = parseDiff(loadFixture('renamed'));
  assert.equal(
    renderFileSlice(sliceOf(renamed))[1],
    '（由 ten.txt 重命名为 ten-renamed.txt，+0 行 -0 行）',
  );

  const [renamedMod] = parseDiff(loadFixture('renamed-modified'));
  assert.equal(
    renderFileSlice(sliceOf(renamedMod))[1],
    '（由 ten-renamed.txt 重命名为 ten-edited.txt，+2 行 -1 行）',
  );

  const [binary] = parseDiff(loadFixture('binary'));
  assert.equal(renderFileSlice(sliceOf(binary))[1], '（二进制文件）');
});

test('renderFileSlice：按 hunk 切分的分段说明行与分段统计', () => {
  const [file] = parseDiff(loadFixture('renamed-modified'));
  const slice = sliceOf(file, [file.hunks[1]], { index: 2, total: 3 });
  assert.deepEqual(renderFileSlice(slice), [
    '### 文件: ten-edited.txt',
    '（由 ten-renamed.txt 重命名为 ten-edited.txt，+1 行 -0 行）',
    '（文件较大，按 hunk 切分：第 2/3 段，仅含本段改动）',
    '@@ -8,3 +8,4 @@ line7',
    '   8   line8',
    '   9   line9',
    '  10   line10',
    '  11 + line11',
  ]);
  assert.equal(slice.additions, 1);
  assert.equal(slice.deletions, 0);
});

test('renderFileSlice：多 hunk 文件保留 hunk 头，删除行行号区为空', () => {
  const [file] = parseDiff(loadFixture('multi-hunk'));
  const lines = renderFileSlice(sliceOf(file));
  assert.deepEqual(lines, [
    '### 文件: grid.txt',
    '（修改，+2 行 -2 行）',
    '@@ -2,7 +2,7 @@ row 1',
    '   2   row 2',
    '   3   row 3',
    '   4   row 4',
    '     - row 5',
    '   5 + row 5 edited',
    '   6   row 6',
    '   7   row 7',
    '   8   row 8',
    '@@ -52,7 +52,7 @@ row 51',
    '  52   row 52',
    '  53   row 53',
    '  54   row 54',
    '     - row 55',
    '  55 + row 55 edited',
    '  56   row 56',
    '  57   row 57',
    '  58   row 58',
  ]);
});
