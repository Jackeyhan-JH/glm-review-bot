/**
 * 可评论行映射（#7）：GitHub 行内评论挂在 RIGHT 侧（新文件）diff 行上，
 * 且该行必须出现在 diff 里——即新增行与上下文行；删除行不能挂（要挂得用 LEFT 侧，
 * 本项目不发 LEFT 侧评论）。
 */
import type { DiffFile, Hunk } from './types.ts';

/**
 * 新文件中可挂行内评论的行号集合（side RIGHT）：全部 `'+'` 与 `' `' 行的
 * `newLine`。纯删除文件 / 二进制文件 / 纯重命名返回空集合。
 */
export function commentableLines(file: DiffFile): Set<number> {
  const lines = new Set<number>();
  for (const hunk of file.hunks) {
    for (const line of hunk.lines) {
      if (line.kind !== '-' && line.newLine !== undefined) lines.add(line.newLine);
    }
  }
  return lines;
}

/** hunk 在某一侧覆盖的行号区间 `[start, start + count - 1]`（count ≤ 0 时为 null）。 */
function span(start: number, count: number): { from: number; to: number } | null {
  if (count <= 0) return null;
  return { from: start, to: start + count - 1 };
}

function inSpan(span: { from: number; to: number } | null, line: number): boolean {
  return span !== null && line >= span.from && line <= span.to;
}

/** 单个 hunk 内的可评论行号，升序。 */
function commentableInHunk(hunk: Hunk): number[] {
  const lines: number[] = [];
  for (const line of hunk.lines) {
    if (line.kind !== '-' && line.newLine !== undefined) lines.push(line.newLine);
  }
  return lines;
}

/**
 * 把模型给的行号修正到可评论行上：
 * - 行号本身可评论 → 原样返回；
 * - 行号落在某个 hunk 的新侧或旧侧区间内（典型：报了删除行的旧侧行号，删除行
 *   不能挂 RIGHT 侧评论）→ 该 hunk 新侧距离最近的可评论行（并列取行号小的）；
 * - 行号不在任何 hunk 的区间内（hunk 之间、diff 范围外），或所在 hunk 没有
 *   可评论行（纯删除 hunk）→ `null`。绝不跨 hunk 兜底——宁可落不进行内评论。
 */
export function nearestCommentable(file: DiffFile, line: number): number | null {
  if (!Number.isInteger(line) || line <= 0) return null;
  if (commentableLines(file).has(line)) return line;
  for (const hunk of file.hunks) {
    if (!inSpan(span(hunk.newStart, hunk.newLines), line) && !inSpan(span(hunk.oldStart, hunk.oldLines), line)) {
      continue;
    }
    let best: number | null = null;
    for (const candidate of commentableInHunk(hunk)) {
      if (
        best === null ||
        Math.abs(candidate - line) < Math.abs(best - line) ||
        (Math.abs(candidate - line) === Math.abs(best - line) && candidate < best)
      ) {
        best = candidate;
      }
    }
    return best;
  }
  return null;
}
