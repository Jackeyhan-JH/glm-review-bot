/**
 * parseDiff 的夹具对照测试：13 份真实 `git diff` 夹具（见 fixtures/README.md）
 * 加一组合成边界用例。期望值全部人工核对自夹具原文。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseDiff } from '../../src/diff/parse.ts';
import { loadFixture } from './helpers.ts';

test('added.diff：新增文件（new file mode、/dev/null、行号从 1 起）', () => {
  const [file] = parseDiff(loadFixture('added'));
  assert.deepEqual(file, {
    path: 'src/parse.ts',
    oldPath: undefined,
    status: 'added',
    binary: false,
    hunks: [
      {
        header: '@@ -0,0 +1,4 @@',
        oldStart: 0,
        oldLines: 0,
        newStart: 1,
        newLines: 4,
        lines: [
          { kind: '+', text: 'export function parseAmount(input: string): number {', newLine: 1 },
          { kind: '+', text: "  const value = Number(input.replace(/[,$]/g, ''));", newLine: 2 },
          { kind: '+', text: '  return value;', newLine: 3 },
          { kind: '+', text: '}', newLine: 4 },
        ],
      },
    ],
    additions: 4,
    deletions: 0,
  });
});

test('modified.diff：修改文件（上下文/增/删行号分配、空上下文行）', () => {
  const [file] = parseDiff(loadFixture('modified'));
  assert.equal(file.path, 'src/calc.ts');
  assert.equal(file.status, 'modified');
  assert.equal(file.oldPath, undefined);
  assert.deepEqual(
    file.hunks[0].lines.map((l) => [l.kind, l.oldLine, l.newLine, l.text]),
    [
      [' ', 1, 1, 'export function add(a: number, b: number): number {'],
      ['+', undefined, 2, '  if (!Number.isFinite(a) || !Number.isFinite(b)) {'],
      ['+', undefined, 3, "    throw new Error('参数必须是数字');"],
      ['+', undefined, 4, '  }'],
      [' ', 2, 5, '  return a + b;'],
      [' ', 3, 6, '}'],
      // 夹具末尾的 “ ” 行：空上下文行，旧 4 / 新 7。
      [' ', 4, 7, ''],
    ],
  );
  assert.equal(file.additions, 3);
  assert.equal(file.deletions, 0);
  assert.deepEqual(
    [file.hunks[0].oldStart, file.hunks[0].oldLines, file.hunks[0].newStart, file.hunks[0].newLines],
    [1, 4, 1, 7],
  );
});

test('deleted.diff：删除文件（+++ /dev/null、全删行、末行无换行标记）', () => {
  const [file] = parseDiff(loadFixture('deleted'));
  assert.equal(file.path, 'doomed.txt');
  assert.equal(file.status, 'deleted');
  assert.equal(file.binary, false);
  assert.equal(file.hunks.length, 1);
  assert.equal(file.additions, 0);
  assert.equal(file.deletions, 2);
  const lines = file.hunks[0].lines;
  assert.deepEqual(
    lines.map((l) => [l.kind, l.oldLine, l.newLine]),
    [['-', 1, undefined], ['-', 2, undefined]],
  );
  assert.equal(lines[1].noNewline, true, '末行 \\ No newline 标记应挂在最后一个删除行上');
  assert.equal(lines[0].noNewline, undefined);
});

test('renamed.diff：纯重命名（similarity index 100%、无 hunk）', () => {
  const [file] = parseDiff(loadFixture('renamed'));
  assert.deepEqual(
    { path: file.path, oldPath: file.oldPath, status: file.status, hunks: file.hunks.length },
    { path: 'ten-renamed.txt', oldPath: 'ten.txt', status: 'renamed', hunks: 0 },
  );
  assert.equal(file.additions + file.deletions, 0);
});

test('renamed-modified.diff：重命名 + 修改（rename from/to 与 hunk 并存）', () => {
  const [file] = parseDiff(loadFixture('renamed-modified'));
  assert.equal(file.path, 'ten-edited.txt');
  assert.equal(file.oldPath, 'ten-renamed.txt');
  assert.equal(file.status, 'renamed');
  assert.equal(file.hunks.length, 2);
  assert.equal(file.additions, 2);
  assert.equal(file.deletions, 1);
  // 第二个 hunk：@@ -8,3 +8,4 @@，末尾 +line11。
  const second = file.hunks[1];
  assert.deepEqual([second.oldStart, second.oldLines, second.newStart, second.newLines], [8, 3, 8, 4]);
  assert.equal(second.lines.at(-1)?.text, 'line11');
  assert.equal(second.lines.at(-1)?.newLine, 11);
});

test('binary.diff：二进制文件（Binary files differ，无 ---/+++，路径取 diff --git b 侧）', () => {
  const [file] = parseDiff(loadFixture('binary'));
  assert.deepEqual(
    { path: file.path, status: file.status, binary: file.binary, hunks: file.hunks.length },
    { path: 'logo.bin', status: 'modified', binary: true, hunks: 0 },
  );
});

test('no-newline.diff：新旧两侧的 \\ No newline 标记各归各行', () => {
  const [file] = parseDiff(loadFixture('no-newline'));
  const lines = file.hunks[0].lines;
  assert.equal(lines.length, 4);
  assert.deepEqual(
    lines.map((l) => [l.kind, l.oldLine, l.newLine, l.noNewline === true]),
    [
      [' ', 1, 1, false],
      [' ', 2, 2, false],
      ['-', 3, undefined, true],
      ['+', undefined, 3, true],
    ],
  );
});

test('spaces.diff：文件名含空格（---/+++ 行的行尾 TAB 去掉）', () => {
  const [file] = parseDiff(loadFixture('spaces'));
  assert.equal(file.path, 'my lib/util helpers.ts');
  assert.equal(file.status, 'modified');
  assert.equal(file.additions, 2);
  assert.equal(file.deletions, 1);
});

test('multi-hunk.diff：同一文件多个 hunk，行号区间不连续', () => {
  const [file] = parseDiff(loadFixture('multi-hunk'));
  assert.equal(file.hunks.length, 2);
  assert.deepEqual(
    file.hunks.map((h) => [h.oldStart, h.oldLines, h.newStart, h.newLines]),
    [
      [2, 7, 2, 7],
      [52, 7, 52, 7],
    ],
  );
  assert.equal(file.hunks[0].lines[4].text, 'row 5 edited'); // + 行（index 3 是 - 行）
  assert.equal(file.hunks[1].lines[4].text, 'row 55 edited');
});

test('crlf.diff：CRLF 正文行的行尾 \\r 归一去掉', () => {
  const [file] = parseDiff(loadFixture('crlf'));
  assert.deepEqual(
    file.hunks[0].lines.map((l) => [l.kind, l.text]),
    [
      [' ', 'crlf one'],
      ['-', 'crlf two'],
      ['+', 'crlf two EDITED'],
      [' ', 'crlf three'],
    ],
  );
  assert.ok(file.hunks.every((h) => !h.header.includes('\r')), 'hunk 头不应带 \\r');
});

test('quoted-path.diff：非 ASCII 路径的八进制转义解码', () => {
  const [file] = parseDiff(loadFixture('quoted-path'));
  assert.equal(file.path, 'src/组件.ts');
  assert.equal(file.status, 'modified');
  assert.equal(file.additions, 2);
  assert.equal(file.deletions, 1);
});

test('rename-spaces.diff：rename from/to 行内含空格的路径', () => {
  const [file] = parseDiff(loadFixture('rename-spaces'));
  assert.deepEqual(
    { path: file.path, oldPath: file.oldPath, status: file.status },
    { path: 'docs/new name with space.md', oldPath: 'docs/old name with space.md', status: 'renamed' },
  );
});

test('combined.diff：一次 diff 多个文件，顺序与状态正确', () => {
  const files = parseDiff(loadFixture('combined'));
  assert.deepEqual(
    files.map((f) => [f.path, f.status]),
    [
      ['blank.txt', 'modified'],
      ['pkg/one.ts', 'modified'],
      ['pkg/three.ts', 'added'],
      ['pkg/two.ts', 'deleted'],
    ],
  );
  // blank.txt 里有两个空上下文行（“ ” 行）。
  assert.deepEqual(
    files[0].hunks[0].lines.map((l) => [l.kind, l.text]),
    [['-', 'alpha'], ['+', 'alpha!'], [' ', ''], [' ', 'beta'], [' ', '']],
  );
});

// ---------- 合成边界用例 ----------

test('空 diff 与杂项文本返回空数组', () => {
  assert.deepEqual(parseDiff(''), []);
  assert.deepEqual(parseDiff('\n\n'), []);
  assert.deepEqual(parseDiff('不是 diff 的文本\n'), []);
});

test('diff 文本本身没有结尾换行也能解析', () => {
  const text = loadFixture('added').trimEnd();
  const [file] = parseDiff(text);
  assert.equal(file.path, 'src/parse.ts');
  assert.equal(file.hunks[0].lines.length, 4);
});

test('整份 diff 用 CRLF 行尾（含头部行）不影响解析', () => {
  const text = loadFixture('modified').split('\n').join('\r\n');
  const [file] = parseDiff(text);
  assert.equal(file.path, 'src/calc.ts');
  assert.equal(file.hunks[0].lines.at(-1)?.text, '');
  assert.ok(file.hunks.every((h) => !h.header.includes('\r')));
});

test('仅权限变化的文件：modified、无 hunk', () => {
  const text = [
    'diff --git a/script.sh b/script.sh',
    'old mode 100644',
    'new mode 100755',
    '',
  ].join('\n');
  const [file] = parseDiff(text);
  assert.deepEqual(
    { path: file.path, status: file.status, hunks: file.hunks.length },
    { path: 'script.sh', status: 'modified', hunks: 0 },
  );
});

test('单行计数省略形态 @@ -3 +3 @@ 按行数 1 解析', () => {
  const text = [
    'diff --git a/a.txt b/a.txt',
    '--- a/a.txt',
    '+++ b/a.txt',
    '@@ -3 +3 @@',
    '-x',
    '+y',
    '',
  ].join('\n');
  const [file] = parseDiff(text);
  const hunk = file.hunks[0];
  assert.deepEqual([hunk.oldStart, hunk.oldLines, hunk.newStart, hunk.newLines], [3, 1, 3, 1]);
  assert.deepEqual(
    hunk.lines.map((l) => [l.kind, l.oldLine, l.newLine]),
    [['-', 3, undefined], ['+', undefined, 3]],
  );
});

test('copy from/to 按重命名处理（oldPath 取 copy from）', () => {
  const text = [
    'diff --git a/orig.ts b/copy.ts',
    'similarity index 100%',
    'copy from orig.ts',
    'copy to copy.ts',
    '',
  ].join('\n');
  const [file] = parseDiff(text);
  assert.deepEqual(
    { path: file.path, oldPath: file.oldPath, status: file.status },
    { path: 'copy.ts', oldPath: 'orig.ts', status: 'renamed' },
  );
});

test('GIT binary patch 形态也识别为二进制，数据行被跳过', () => {
  const text = [
    'diff --git a/a.png b/a.png',
    'index 1234567..89abcde 100644',
    'GIT binary patch',
    'literal 10',
    'zcmZex=aaaaa0',
    '',
  ].join('\n');
  const [file] = parseDiff(text);
  assert.deepEqual(
    { path: file.path, binary: file.binary, hunks: file.hunks.length },
    { path: 'a.png', binary: true, hunks: 0 },
  );
  assert.equal(parseDiff(text).length, 1, '数据行不应被当成第二个文件');
});

test('坏 hunk 头与孤儿行不影响后续文件解析', () => {
  const text = [
    'diff --git a/one.txt b/one.txt',
    '--- a/one.txt',
    '+++ b/one.txt',
    '@@ 长得像 hunk 头但解析失败 @@',
    '垃圾行',
    'diff --git a/two.txt b/two.txt',
    '--- a/two.txt',
    '+++ b/two.txt',
    '@@ -1 +1 @@',
    '-a',
    '+b',
    '',
  ].join('\n');
  const files = parseDiff(text);
  assert.equal(files.length, 2);
  assert.equal(files[1].path, 'two.txt');
  assert.equal(files[1].hunks[0].lines.length, 2);
});
