/**
 * Diff 模块的共享类型（#7）。按约定只在本目录内定义，不改 src/lib/types.ts。
 */

/** 文件变更类型：新增 / 修改 / 删除 / 重命名。 */
export type FileStatus = 'added' | 'modified' | 'deleted' | 'renamed';

/** hunk 内的一行内容（行尾换行符已去掉，CRLF 的 `\r` 一并归一）。 */
export interface DiffLine {
  /** 行种类：上下文行、新增行、删除行。 */
  kind: '+' | '-' | ' ';
  /** 行文本（不含种类前缀与换行符）。 */
  text: string;
  /** 旧文件行号（从 1 起；`+` 行没有）。 */
  oldLine?: number;
  /** 新文件行号（从 1 起；`-` 行没有）。 */
  newLine?: number;
  /** 该行是文件最后一行且其后没有换行符（对应 `\ No newline at end of file`）。 */
  noNewline?: boolean;
}

/** 一个 hunk：`@@ -oldStart,oldLines +newStart,newLines @@ …`。 */
export interface Hunk {
  /** hunk 头原始文本（去掉行尾换行符后的整行）。 */
  header: string;
  /** 旧文件起始行号（新文件为空时为 0）。 */
  oldStart: number;
  /** 旧文件侧行数（上下文 + 删除）。 */
  oldLines: number;
  /** 新文件起始行号（旧文件为空时为 0）。 */
  newStart: number;
  /** 新文件侧行数（上下文 + 新增）。 */
  newLines: number;
  /** hunk 内的行，按出现顺序。 */
  lines: DiffLine[];
}

/** diff 中的一个文件。 */
export interface DiffFile {
  /** 新文件路径（删除文件为旧路径）。 */
  path: string;
  /** 旧文件路径，仅重命名（含复制）文件有。 */
  oldPath?: string;
  /** 变更类型。 */
  status: FileStatus;
  /** 是否二进制文件（无 hunk 内容）。 */
  binary: boolean;
  /** hunk 列表（纯重命名 / 二进制 / 仅权限变化时为空）。 */
  hunks: Hunk[];
  /** 新增行数（`+` 行数）。 */
  additions: number;
  /** 删除行数（`-` 行数）。 */
  deletions: number;
}
