/**
 * 性能：解析 2 MB 合成 diff 用时 < 1 秒（宽松阈值，CI 慢机也留足余量）。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseDiff } from '../../src/diff/parse.ts';

/** 合成一份 ≥ 2 MB 的多文件、多 hunk unified diff。 */
function synthDiff(): string {
  const parts: string[] = [];
  const ctx = ' context line with some padding to mimic real code lines';
  for (let file = 0; file < 44; file++) {
    parts.push(`diff --git a/pkg/file${file}.ts b/pkg/file${file}.ts`);
    parts.push(`index ${1000 + file}0000..${2000 + file}0000 100644`);
    parts.push(`--- a/pkg/file${file}.ts`);
    parts.push(`+++ b/pkg/file${file}.ts`);
    for (let hunk = 0; hunk < 25; hunk++) {
      const start = hunk * 50 + 1;
      // 30 上下文 + 8 删除 + 18 新增：旧侧 38 行、新侧 48 行。
      parts.push(`@@ -${start},38 +${start},48 @@ ctx of hunk ${hunk}`);
      for (let i = 0; i < 30; i++) parts.push(` ${ctx} ${i}`);
      for (let i = 0; i < 8; i++) parts.push(`-old code line ${i} removed in hunk ${hunk}`);
      for (let i = 0; i < 18; i++) parts.push(`+new code line ${i} added in hunk ${hunk} with padding`);
    }
  }
  return `${parts.join('\n')}\n`;
}

test('解析 2 MB 合成 diff 用时 < 1 秒', () => {
  const text = synthDiff();
  const bytes = Buffer.byteLength(text, 'utf8');
  assert.ok(bytes >= 2 * 1024 * 1024, `合成 diff 应 ≥ 2 MB，实际 ${(bytes / 1024 / 1024).toFixed(2)} MB`);

  const started = process.hrtime.bigint();
  const files = parseDiff(text);
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;

  assert.equal(files.length, 44, '文件数');
  assert.equal(files[0].hunks.length, 25, '每文件 hunk 数');
  assert.equal(files[0].additions, 25 * 18);
  assert.equal(files[0].deletions, 25 * 8);
  const totalLines = files.reduce(
    (n, f) => n + f.hunks.reduce((m, h) => m + h.lines.length, 0),
    0,
  );
  assert.equal(totalLines, 44 * 25 * 56, 'hunk 正文总行数');

  assert.ok(elapsedMs < 1000, `解析 ${bytes} 字节用了 ${elapsedMs.toFixed(0)} ms，应 < 1000 ms`);
});
