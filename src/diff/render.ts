/**
 * 给模型看的 diff 渲染（#7）：每个文件以 `### 文件: <path>` 开头，正文每行
 * 前缀新文件行号（右侧对齐，宽度 5），形如：
 *
 * ```
 * ### 文件: src/calc.ts
 * （修改，+3 行 -0 行）
 * @@ -1,4 +1,7 @@
 *    1   export function add(a: number, b: number): number {
 *    2 +   if (!Number.isFinite(a) || !Number.isFinite(b)) {
 *    3 +     throw new Error('参数必须是数字');
 *    4 +   }
 *    5   return a + b;
 * ```
 *
 * 删除行没有新文件行号，行号区留空（4 个空格 + 分隔空格），模型仍能从 `-`
 * 前缀识别。保留原始 hunk 头（`@@ … @@`），让模型看得到 hunk 边界与旧侧范围。
 */
import type { DiffFile, DiffLine, FileStatus, Hunk } from './types.ts';

/** 行号区宽度：`String(行号).padStart(4)`，无行号时 4 个空格；行号超过 4 位自然加宽。 */
export const LINE_NUMBER_WIDTH = 4;

/** 状态中文显示名（渲染头部说明用）。 */
export const STATUS_LABEL: Record<FileStatus, string> = {
  added: '新增文件',
  modified: '修改',
  deleted: '删除文件',
  renamed: '重命名',
};

/** 文件切片：整个文件或按 hunk 切出的一段（大文件分块用）。 */
export interface FileSlice {
  path: string;
  status: FileStatus;
  oldPath?: string;
  binary: boolean;
  hunks: Hunk[];
  /** 本段新增行数（按所含 hunk 统计）。 */
  additions: number;
  /** 本段删除行数（按所含 hunk 统计）。 */
  deletions: number;
  /** 大文件按 hunk 切分时的分段信息。 */
  part?: { index: number; total: number };
}

/** 从 DiffFile 取切片：`hunks` 省略时取全部，`part` 标注分段信息。 */
export function sliceOf(
  file: DiffFile,
  hunks: Hunk[] = file.hunks,
  part?: { index: number; total: number },
): FileSlice {
  return {
    path: file.path,
    status: file.status,
    oldPath: file.oldPath,
    binary: file.binary,
    hunks,
    additions: hunks.reduce((n, hunk) => n + hunk.lines.filter((l) => l.kind === '+').length, 0),
    deletions: hunks.reduce((n, hunk) => n + hunk.lines.filter((l) => l.kind === '-').length, 0),
    part,
  };
}

/** 渲染一行：`<行号区5字符> <种类> <文本>`。 */
export function renderDiffLine(line: DiffLine): string {
  const num =
    line.newLine === undefined
      ? ' '.repeat(LINE_NUMBER_WIDTH)
      : String(line.newLine).padStart(LINE_NUMBER_WIDTH);
  return `${num} ${line.kind} ${line.text}`;
}

/** 头部说明行：状态 + 增删行数，如 `（修改，+3 行 -1 行）`。 */
function renderStatusLine(slice: FileSlice): string {
  if (slice.binary) return '（二进制文件）';
  const change = `+${slice.additions} 行 -${slice.deletions} 行`;
  switch (slice.status) {
    case 'added':
      return `（新增文件，+${slice.additions} 行）`;
    case 'deleted':
      return `（删除文件，-${slice.deletions} 行）`;
    case 'renamed':
      return `（由 ${slice.oldPath ?? '?'} 重命名为 ${slice.path}，${change}）`;
    default:
      return `（修改，${change}）`;
  }
}

/**
 * 渲染文件切片为行数组（不加结尾换行）：
 * `### 文件: <path>` + 状态行 +（有分段时）分段说明行 + 各 hunk。
 */
export function renderFileSlice(slice: FileSlice): string[] {
  const lines: string[] = [`### 文件: ${slice.path}`, renderStatusLine(slice)];
  if (slice.part !== undefined) {
    lines.push(`（文件较大，按 hunk 切分：第 ${slice.part.index}/${slice.part.total} 段，仅含本段改动）`);
  }
  for (const hunk of slice.hunks) {
    lines.push(hunk.header);
    for (const line of hunk.lines) lines.push(renderDiffLine(line));
  }
  return lines;
}
