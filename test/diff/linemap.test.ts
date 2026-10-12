/**
 * commentableLines / nearestCommentable 的对照测试：每个夹具的期望行号集合
 * 均人工核对自夹具原文（见 fixtures/README.md）。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { commentableLines, nearestCommentable } from '../../src/diff/linemap.ts';
import { parseDiff } from '../../src/diff/parse.ts';
import type { DiffFile } from '../../src/diff/types.ts';
import { loadFixture } from './helpers.ts';

function range(from: number, to: number): number[] {
  return Array.from({ length: to - from + 1 }, (_, i) => from + i);
}

test('每个夹具的 commentableLines 与人工核对一致', () => {
  const cases: Array<[string, number[][]]> = [
    // [夹具, 按文件顺序的可评论行号]
    ['added', [range(1, 4)]],
    ['modified', [range(1, 7)]],
    ['deleted', [[]]],
    ['renamed', [[]]],
    ['renamed-modified', [range(1, 5).concat(range(8, 11))]],
    ['binary', [[]]],
    ['no-newline', [range(1, 3)]],
    ['spaces', [range(1, 3)]],
    ['multi-hunk', [range(2, 8).concat(range(52, 58))]],
    ['crlf', [range(1, 3)]],
    ['quoted-path', [range(1, 2)]],
    ['rename-spaces', [[]]],
    ['combined', [range(1, 4), range(1, 2), range(1, 1), []]],
  ];
  for (const [name, expectedPerFile] of cases) {
    const files = parseDiff(loadFixture(name));
    assert.equal(files.length, expectedPerFile.length, `${name} 文件数`);
    files.forEach((file, index) => {
      assert.deepEqual(
        [...commentableLines(file)].sort((a, b) => a - b),
        expectedPerFile[index],
        `${name} 第 ${index} 个文件（${file.path}）`,
      );
    });
  }
});

test('commentableLines 返回 Set，删除行与纯删除文件不在其中', () => {
  const [deleted] = parseDiff(loadFixture('deleted'));
  assert.ok(commentableLines(deleted) instanceof Set);
  assert.equal(commentableLines(deleted).size, 0);

  const [noNewline] = parseDiff(loadFixture('no-newline'));
  const set = commentableLines(noNewline);
  assert.equal(set.size, 3);
});

test('nearestCommentable：行号本身可评论时原样返回', () => {
  const [multi] = parseDiff(loadFixture('multi-hunk'));
  assert.equal(nearestCommentable(multi, 5), 5);
  assert.equal(nearestCommentable(multi, 52), 52);
  assert.equal(nearestCommentable(multi, 2), 2);
});

test('nearestCommentable：hunk 区间之外（hunk 之间 / diff 之外）返回 null，绝不跨 hunk', () => {
  const [multi] = parseDiff(loadFixture('multi-hunk'));
  assert.equal(nearestCommentable(multi, 30), null, '两个 hunk 之间');
  assert.equal(nearestCommentable(multi, 1), null, '第一个 hunk 之前');
  assert.equal(nearestCommentable(multi, 9), null, '紧邻第一个 hunk 之后也不跨');
  assert.equal(nearestCommentable(multi, 59), null, '最后一个 hunk 之后');
  assert.equal(nearestCommentable(multi, 10_000), null);
});

test('nearestCommentable：非法输入返回 null', () => {
  const [multi] = parseDiff(loadFixture('multi-hunk'));
  assert.equal(nearestCommentable(multi, 0), null);
  assert.equal(nearestCommentable(multi, -3), null);
  assert.equal(nearestCommentable(multi, 2.5), null);
  assert.equal(nearestCommentable(multi, Number.NaN), null);
});

test('nearestCommentable：报了删除行的旧侧行号，落到同一 hunk 新侧最近的可评论行', () => {
  // 旧侧 1-6、新侧 1-3：删了 two/three/four，模型报 4（four 的旧行号）→ 新侧 3。
  const text = [
    'diff --git a/t.txt b/t.txt',
    '--- a/t.txt',
    '+++ b/t.txt',
    '@@ -1,6 +1,3 @@',
    ' one',
    '-two',
    '-three',
    '-four',
    ' five',
    ' six',
    '',
  ].join('\n');
  const [file] = parseDiff(text);
  assert.deepEqual([...commentableLines(file)].sort((a, b) => a - b), [1, 2, 3]);
  assert.equal(nearestCommentable(file, 4), 3);
  assert.equal(nearestCommentable(file, 6), 3, '旧侧最后一个行号也落在新侧最近的行');
  assert.equal(nearestCommentable(file, 7), null, '超出旧/新侧区间 → null');
});

test('nearestCommentable：纯删除文件与无 hunk 文件一律 null', () => {
  const [deleted] = parseDiff(loadFixture('deleted'));
  assert.equal(nearestCommentable(deleted, 1), null);
  assert.equal(nearestCommentable(deleted, 2), null);

  const [renamed] = parseDiff(loadFixture('renamed'));
  assert.equal(nearestCommentable(renamed, 1), null);
});

test('nearestCommentable：同一 hunk 内距离并列时取行号小的', () => {
  // 手工构造不一致的行号（可评论行 {1,3}，2 落在区间内但不可评论）来测并列取舍。
  const file: DiffFile = {
    path: 't.txt',
    status: 'modified',
    binary: false,
    additions: 1,
    deletions: 1,
    hunks: [
      {
        header: '@@ -1,3 +1,3 @@',
        oldStart: 1,
        oldLines: 3,
        newStart: 1,
        newLines: 3,
        lines: [
          { kind: ' ', text: 'one', oldLine: 1, newLine: 1 },
          { kind: '-', text: 'two', oldLine: 2 },
          { kind: ' ', text: 'three', oldLine: 3, newLine: 3 },
        ],
      },
    ],
  };
  assert.equal(nearestCommentable(file, 2), 1, '与 1、3 等距 → 取 1');
});
