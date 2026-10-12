/**
 * chunkDiff / changedLines：预算按渲染后文本行数计（含文件间空行）。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { changedLines, chunkDiff } from '../../src/diff/chunk.ts';
import { parseDiff } from '../../src/diff/parse.ts';
import type { DiffFile } from '../../src/diff/types.ts';
import { loadFixture } from './helpers.ts';

/** 每个文件渲染后的行数（### 头 + 状态行 + Σ(1 + hunk 正文行数)）。 */
function renderedLines(file: DiffFile): number {
  return 2 + file.hunks.reduce((n, h) => n + 1 + h.lines.length, 0);
}

test('总行数不超过预算时切成 1 块，text 与行数一致', () => {
  const files = [...parseDiff(loadFixture('added')), ...parseDiff(loadFixture('modified'))];
  // added 渲染 7 行、modified 10 行，中间空 1 行 → 18 行。
  assert.deepEqual(files.map(renderedLines), [7, 10]);
  const plan = chunkDiff(files, { maxChunkLines: 18, maxChunks: 5 });
  assert.deepEqual(plan.truncated, []);
  assert.equal(plan.chunks.length, 1);
  const chunk = plan.chunks[0];
  assert.equal(chunk.lines, 18);
  assert.equal(chunk.oversized, false);
  assert.equal(chunk.parts.length, 2);
  assert.equal(chunk.text.split('\n').length - 1, 18, 'text 行数（去掉结尾换行的空尾）');
  assert.ok(chunk.text.endsWith('\n'));
  // 两个文件之间空一行。
  assert.equal(chunk.text.split('\n')[7], '');
});

test('恰好等于预算也算装得下（闭区间）', () => {
  const files = parseDiff(loadFixture('added'));
  assert.equal(renderedLines(files[0]), 7);
  const plan = chunkDiff(files, { maxChunkLines: 7, maxChunks: 3 });
  assert.equal(plan.chunks.length, 1);
  assert.equal(plan.chunks[0].lines, 7);
});

test('单个文件超预算时按 hunk 切分，每块 ≤ 预算', () => {
  const [file] = parseDiff(loadFixture('renamed-modified'));
  assert.equal(renderedLines(file), 14, '头 2 行 + 两个 hunk（7 + 5）');
  // 预算 11：整文件 14 超预算 → hunk1 段 3+7=10、hunk2 段 3+5=8，两块。
  const plan = chunkDiff([file], { maxChunkLines: 11, maxChunks: 10 });
  assert.deepEqual(plan.truncated, []);
  assert.equal(plan.chunks.length, 2);
  assert.ok(plan.chunks.every((c) => c.lines <= 11 && !c.oversized));
  assert.equal(plan.chunks[0].parts[0].part?.index, 1);
  assert.equal(plan.chunks[0].parts[0].part?.total, 2);
  assert.equal(plan.chunks[1].parts[0].part?.index, 2);
  // 每块文本都带文件头与分段说明。
  assert.ok(plan.chunks[0].text.startsWith('### 文件: ten-edited.txt\n'));
  assert.ok(plan.chunks[0].text.includes('第 1/2 段'));
  assert.ok(plan.chunks[1].text.includes('第 2/2 段'));
});

test('两个 hunk 段可以装进同一块（分段只是切分，不强制一块一段）', () => {
  const [file] = parseDiff(loadFixture('renamed-modified'));
  // 预算 19：整文件 14 ≤ 19，直接一整块，无需分段。
  const whole = chunkDiff([file], { maxChunkLines: 19, maxChunks: 10 });
  assert.equal(whole.chunks.length, 1);
  assert.equal(whole.chunks[0].parts[0].part, undefined);

  // 预算 12 无法整装（14 > 12），分段后 10 + 8 + 1 空行 = 19 > 12 → 两块。
  const split = chunkDiff([file], { maxChunkLines: 12, maxChunks: 10 });
  assert.equal(split.chunks.length, 2);
});

test('单个 hunk 超预算时允许单独成块并标记 oversized', () => {
  const [file] = parseDiff(loadFixture('renamed-modified'));
  // 预算 6：任一 hunk 段（3 头 + 至少 5 行）都超 → 每段单独成块且 oversized。
  const plan = chunkDiff([file], { maxChunkLines: 6, maxChunks: 10 });
  assert.equal(plan.chunks.length, 2);
  assert.ok(plan.chunks.every((c) => c.oversized));
  assert.ok(plan.chunks.every((c) => c.lines > 6));
  assert.ok(plan.chunks.every((c) => c.parts.length === 1), 'oversized 块不与其他切片混装');
});

test('多个小文件按预算装进尽量少的块', () => {
  const files = parseDiff(loadFixture('combined')).filter((f) => f.status !== 'deleted');
  // blank.txt 8 行、one.ts 6 行、three.ts 4 行；预算 13：
  // blank+one = 15 超预算 → 块1 = blank(8)；one+three = 6+1+4 = 11 → 块2。
  const plan = chunkDiff(files, { maxChunkLines: 13, maxChunks: 10 });
  assert.deepEqual(plan.truncated, []);
  assert.deepEqual(plan.chunks.map((c) => c.lines), [8, 11]);
  assert.deepEqual(
    plan.chunks.map((c) => c.parts.map((p) => p.path)),
    [['blank.txt'], ['pkg/one.ts', 'pkg/three.ts']],
  );
});

test('超过 maxChunks 时返回截断列表（整文件被截断）', () => {
  const files = parseDiff(loadFixture('combined'));
  // 预算 13：块1 = blank(8)、块2 = one+three(11)、块3 = two(4) → 3 块；
  // 上限 2 → two.ts 整文件截断。
  const plan = chunkDiff(files, { maxChunkLines: 13, maxChunks: 2 });
  assert.equal(plan.chunks.length, 2);
  assert.deepEqual(plan.truncated, [
    { path: 'pkg/two.ts', reason: '块数超过上限（maxChunks=2），仅包含 0/1 段' },
  ]);
});

test('截断列表标注部分入块的文件（仅包含 x/y 段）', () => {
  const [file] = parseDiff(loadFixture('renamed-modified'));
  // 预算 11（两段 10、8）+ maxChunks 1 → 只有第 1 段入块。
  const plan = chunkDiff([file], { maxChunkLines: 11, maxChunks: 1 });
  assert.equal(plan.chunks.length, 1);
  assert.equal(plan.chunks[0].parts[0].part?.index, 1);
  assert.deepEqual(plan.truncated, [
    { path: 'ten-edited.txt', reason: '块数超过上限（maxChunks=1），仅包含 1/2 段' },
  ]);
});

test('maxChunks 为 0 时全部截断、无块', () => {
  const files = parseDiff(loadFixture('combined'));
  const plan = chunkDiff(files, { maxChunkLines: 100, maxChunks: 0 });
  assert.deepEqual(plan.chunks, []);
  assert.deepEqual(
    plan.truncated.map((t) => t.path),
    ['blank.txt', 'pkg/one.ts', 'pkg/three.ts', 'pkg/two.ts'],
  );
});

test('空文件列表返回空计划', () => {
  assert.deepEqual(chunkDiff([], { maxChunkLines: 100, maxChunks: 3 }), {
    chunks: [],
    truncated: [],
  });
});

test('changedLines：+ 与 - 之和（模型选择用）', () => {
  const files = parseDiff(loadFixture('combined'));
  // blank +1 -1、one +2 -1、three +1 -0、two +0 -1。
  assert.equal(changedLines(files), 7);
  assert.equal(changedLines([]), 0);
  assert.equal(changedLines(parseDiff(loadFixture('binary'))), 0, '二进制不计行数');
});

test('块的不变量：非 oversized 块行数 ≤ 预算，text 行数与 lines 一致', () => {
  const files = [
    ...parseDiff(loadFixture('combined')),
    ...parseDiff(loadFixture('renamed-modified')),
    ...parseDiff(loadFixture('multi-hunk')),
  ];
  for (const maxChunkLines of [6, 10, 25, 100]) {
    const plan = chunkDiff(files, { maxChunkLines, maxChunks: 50 });
    for (const chunk of plan.chunks) {
      if (!chunk.oversized) {
        assert.ok(
          chunk.lines <= maxChunkLines,
          `预算 ${maxChunkLines} 下块行数 ${chunk.lines} 超限`,
        );
      }
      assert.equal(chunk.text.split('\n').length - 1, chunk.lines);
    }
  }
});

test('预算装得下所有文件时，块内切片顺序与输入文件顺序一致', () => {
  const files = [
    ...parseDiff(loadFixture('combined')),
    ...parseDiff(loadFixture('renamed-modified')),
    ...parseDiff(loadFixture('multi-hunk')),
  ];
  // 预算 ≥ 25 时所有文件整体入块（最大 grid.txt 18 行）。
  for (const maxChunkLines of [25, 100]) {
    const plan = chunkDiff(files, { maxChunkLines, maxChunks: 50 });
    assert.deepEqual(plan.truncated, []);
    const paths = plan.chunks.flatMap((c) => c.parts.map((p) => p.path));
    assert.deepEqual(paths, [
      'blank.txt',
      'pkg/one.ts',
      'pkg/three.ts',
      'pkg/two.ts',
      'ten-edited.txt',
      'grid.txt',
    ]);
    assert.ok(plan.chunks.every((c) => c.parts[0].part === undefined), '整体入块无分段说明');
  }
});
