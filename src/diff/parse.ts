/**
 * unified diff 解析：`git diff` / `gh pr diff` 的输出 → `DiffFile[]`（#7）。
 *
 * 覆盖的形态（夹具见 test/diff/fixtures/，全部取自真实 `git diff` 输出）：
 * - 新增（`new file mode`、`--- /dev/null`）/ 删除（`deleted file mode`、`+++ /dev/null`）；
 * - 重命名（`rename from/to` + `similarity index`，含纯重命名与重命名+修改）、复制；
 * - 二进制（`Binary files … differ` / `GIT binary patch`，无 hunk）；
 * - `\ No newline at end of file`（挂在上一行的 `noNewline` 标记上，不计行数）；
 * - 文件名含空格（`---`/`+++` 行 git 会补一个行尾 TAB，这里去掉）；
 * - 含特殊字符的路径（`core.quotepath` 的 C 风格引用，含八进制 `\NNN` UTF-8 字节）；
 * - CRLF（行内容归一为不含行尾 `\r`）；空 diff（返回 `[]`）。
 *
 * 行号分配：` ` 行同时占旧/新行号，`+` 行只占新行号，`-` 行只占旧行号；
 * `\ No newline` 行不占行号。hunk 体按头部的行数配额读满即止，空上下文行
 * 既可能是 `" "`（git 的输出）也可能是 `""`（被剥掉前导空格的形态），都按上下文处理。
 */
import type { DiffFile, DiffLine, FileStatus, Hunk } from './types.ts';

/** hunk 头：`@@ -1,4 +1,7 @@ 可选上下文`，行数省略时按 1 处理。 */
const HUNK_HEADER_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;

/** `diff --git a/x b/x` 的路径对；路径含空格时在最后一个 ` b/` 处切分（贪婪匹配）。 */
const DIFF_GIT_PLAIN_RE = /^a\/(.*) b\/(.*)$/;

/** 两个 C 风格引用字符串（`"a/…"` `"b/…"`）。 */
const DIFF_GIT_QUOTED_RE = /^("(?:[^"\\]|\\.)*") ("(?:[^"\\]|\\.)*")$/;

/** 单个 C 风格引用字符串。 */
const QUOTED_RE = /^"(?:[^"\\]|\\.)*"$/;

/** 文件解析中的中间态：各来源的路径与标记，收尾时归并成 DiffFile。 */
interface FileBuilder {
  /** `diff --git` a 侧路径（兜底用）。 */
  aPath?: string;
  /** `diff --git` b 侧路径（兜底用）。 */
  bPath?: string;
  /** `--- ` 行的路径（`/dev/null` 表示新增）。 */
  oldHeaderPath?: string;
  /** `+++ ` 行的路径（`/dev/null` 表示删除）。 */
  newHeaderPath?: string;
  renameFrom?: string;
  renameTo?: string;
  newFile: boolean;
  deletedFile: boolean;
  binary: boolean;
  hunks: Hunk[];
  additions: number;
  deletions: number;
}

function newBuilder(): FileBuilder {
  return { newFile: false, deletedFile: false, binary: false, hunks: [], additions: 0, deletions: 0 };
}

/** C 风格转义解码：`\n` `\t` `\\` `\"` 与八进制 `\NNN`（UTF-8 字节序列）。 */
function unquotePath(quoted: string): string {
  const inner = quoted.slice(1, -1);
  const bytes: number[] = [];
  const pushText = (text: string): void => {
    for (const byte of Buffer.from(text, 'utf8')) bytes.push(byte);
  };
  const SIMPLE_ESCAPES: Record<string, string> = {
    a: '\x07',
    b: '\x08',
    f: '\x0c',
    n: '\n',
    r: '\r',
    t: '\t',
    v: '\x0b',
    '\\': '\\',
    '"': '"',
    "'": "'",
  };
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i] as string;
    if (ch !== '\\') {
      pushText(ch);
      continue;
    }
    const next = inner[i + 1];
    if (next === undefined) break;
    if (next >= '0' && next <= '7') {
      let octet = next;
      while (octet.length < 3) {
        const digit = inner[i + 2];
        if (digit === undefined || digit < '0' || digit > '7') break;
        octet += digit;
        i++;
      }
      bytes.push(Number.parseInt(octet, 8));
    } else {
      pushText(SIMPLE_ESCAPES[next] ?? next);
    }
    i++;
  }
  return Buffer.from(bytes).toString('utf8');
}

/** 可能被 C 风格引用的路径解码（未引用则原样返回）。 */
function maybeUnquote(path: string): string {
  return QUOTED_RE.test(path) ? unquotePath(path) : path;
}

/** 去掉 git 加的 `a/` / `b/` 前缀（git 总会加恰好一个）。 */
function stripAbPrefix(path: string): string {
  if (path.startsWith('a/') || path.startsWith('b/')) return path.slice(2);
  return path;
}

/**
 * 解析 `--- ` / `+++ ` 行的路径：去行尾 TAB（路径含空格时 git 会补）、去引用、
 * 去 `a/`/`b/` 前缀；`/dev/null` 原样保留，由调用方判断增删。
 */
function parseHeaderPath(rest: string): string {
  let raw = rest;
  if (raw.endsWith('\t')) raw = raw.slice(0, -1);
  if (QUOTED_RE.test(raw)) return stripAbPrefix(unquotePath(raw));
  return stripAbPrefix(raw);
}

/** 解析 `diff --git a/<old> b/<new>` 的两个路径；无法切分时返回空对象。 */
function parseDiffGitPaths(rest: string): { aPath?: string; bPath?: string } {
  if (rest.startsWith('"')) {
    const quoted = DIFF_GIT_QUOTED_RE.exec(rest);
    if (quoted !== null) {
      return {
        aPath: stripAbPrefix(unquotePath(quoted[1] as string)),
        bPath: stripAbPrefix(unquotePath(quoted[2] as string)),
      };
    }
  }
  const plain = DIFF_GIT_PLAIN_RE.exec(rest);
  if (plain !== null) {
    return { aPath: plain[1] as string, bPath: plain[2] as string };
  }
  return {};
}

/** `\ No newline at end of file`：给当前文件最后一个 hunk 的最后一行打标记。 */
function markNoNewline(builder: FileBuilder | null): void {
  const lastHunk = builder?.hunks.at(-1);
  const lastLine = lastHunk?.lines.at(-1);
  if (lastLine !== undefined) lastLine.noNewline = true;
}

/** 把构建态归并成 DiffFile：定状态、定路径、算增删行数。 */
function finalize(builder: FileBuilder | null): DiffFile | null {
  if (builder === null) return null;
  const renamed =
    builder.renameFrom !== undefined || builder.renameTo !== undefined;
  const oldIsNull = builder.oldHeaderPath === '/dev/null';
  const newIsNull = builder.newHeaderPath === '/dev/null';
  const status: FileStatus = renamed
    ? 'renamed'
    : builder.newFile || oldIsNull
      ? 'added'
      : builder.deletedFile || newIsNull
        ? 'deleted'
        : 'modified';

  const path =
    builder.renameTo ??
    (builder.newHeaderPath !== undefined && !newIsNull
      ? builder.newHeaderPath
      : undefined) ??
    builder.bPath ??
    (builder.oldHeaderPath !== undefined && !oldIsNull
      ? builder.oldHeaderPath
      : undefined) ??
    builder.aPath ??
    '';

  return {
    path,
    oldPath: status === 'renamed' ? builder.renameFrom : undefined,
    status,
    binary: builder.binary,
    hunks: builder.hunks,
    additions: builder.additions,
    deletions: builder.deletions,
  };
}

/** 把一行原始文本归一：去掉行尾 `\r`（CRLF 归一为 LF 语义）。 */
function stripCr(line: string): string {
  return line.endsWith('\r') ? line.slice(0, -1) : line;
}

/**
 * 解析 unified diff 文本。空 diff / 不含 `diff --git` 头的文本返回 `[]`；
 * 无法识别的行（index、mode、八进制数据等）一律跳过，不视为错误。
 */
export function parseDiff(text: string): DiffFile[] {
  const rawLines = text.split('\n');
  const files: DiffFile[] = [];
  let cur: FileBuilder | null = null;

  for (let i = 0; i < rawLines.length; ) {
    const line = stripCr(rawLines[i] as string);

    if (line === '') {
      // 文件之间的空行或结尾残留。
      i++;
      continue;
    }

    if (line.startsWith('diff --git ')) {
      const done = finalize(cur);
      if (done !== null) files.push(done);
      cur = newBuilder();
      const paths = parseDiffGitPaths(line.slice('diff --git '.length));
      cur.aPath = paths.aPath;
      cur.bPath = paths.bPath;
      i++;
      continue;
    }

    if (line.startsWith('\\')) {
      // 配额已读满后残留的 `\ No newline at end of file`。
      markNoNewline(cur);
      i++;
      continue;
    }

    if (line.startsWith('--- ') && cur !== null && cur.hunks.length === 0) {
      cur.oldHeaderPath = parseHeaderPath(line.slice(4));
      i++;
      continue;
    }

    if (line.startsWith('+++ ') && cur !== null && cur.hunks.length === 0) {
      cur.newHeaderPath = parseHeaderPath(line.slice(4));
      i++;
      continue;
    }

    if (line.startsWith('new file mode')) {
      if (cur !== null) cur.newFile = true;
      i++;
      continue;
    }

    if (line.startsWith('deleted file mode')) {
      if (cur !== null) cur.deletedFile = true;
      i++;
      continue;
    }

    if (line.startsWith('rename from ') || line.startsWith('copy from ')) {
      if (cur !== null) {
        const rest = line.slice(line.startsWith('rename from ') ? 'rename from '.length : 'copy from '.length);
        cur.renameFrom = maybeUnquote(rest);
      }
      i++;
      continue;
    }

    if (line.startsWith('rename to ') || line.startsWith('copy to ')) {
      if (cur !== null) {
        const rest = line.slice(line.startsWith('rename to ') ? 'rename to '.length : 'copy to '.length);
        cur.renameTo = maybeUnquote(rest);
      }
      i++;
      continue;
    }

    if (line.startsWith('Binary files ') || line === 'GIT binary patch') {
      if (cur !== null) cur.binary = true;
      i++;
      continue;
    }

    if (line.startsWith('@@ ')) {
      const header = HUNK_HEADER_RE.exec(line);
      if (header !== null && cur !== null) {
        const hunk: Hunk = {
          header: line,
          oldStart: Number(header[1]),
          oldLines: header[2] === undefined ? 1 : Number(header[2]),
          newStart: Number(header[3]),
          newLines: header[4] === undefined ? 1 : Number(header[4]),
          lines: [],
        };
        i = readHunkBody(rawLines, i + 1, hunk, cur);
        cur.hunks.push(hunk);
        continue;
      }
      i++;
      continue;
    }

    // index / similarity index / old mode / new mode / 二进制数据行等：跳过。
    i++;
  }

  const done = finalize(cur);
  if (done !== null) files.push(done);
  return files;
}

/**
 * 读 hunk 体：按头部配额（旧侧 oldLines 行、新侧 newLines 行）逐行消费，
 * 返回下一个未消费行的下标。遇到 `diff --git` / `@@` 或不认识的行即停（防
 * 坏输入吞掉后续文件头）。
 */
function readHunkBody(
  rawLines: string[],
  start: number,
  hunk: Hunk,
  builder: FileBuilder,
): number {
  let oldLeft = hunk.oldLines;
  let newLeft = hunk.newLines;
  let nextOld = hunk.oldStart;
  let nextNew = hunk.newStart;
  let i = start;

  while (i < rawLines.length) {
    if (oldLeft <= 0 && newLeft <= 0) break;
    const raw = rawLines[i] as string;
    if (raw.startsWith('diff --git ') || raw.startsWith('@@ ')) break;
    const line = stripCr(raw);

    if (line.startsWith('\\')) {
      // 标记打在当前 hunk（尚未压入 builder.hunks）的最后一行上。
      const last = hunk.lines.at(-1);
      if (last !== undefined) last.noNewline = true;
      i++;
      continue;
    }

    let kind: '+' | '-' | ' ';
    let text: string;
    if (line.startsWith(' ')) {
      kind = ' ';
      text = line.slice(1);
    } else if (line.startsWith('+')) {
      kind = '+';
      text = line.slice(1);
    } else if (line.startsWith('-')) {
      kind = '-';
      text = line.slice(1);
    } else if (line === '') {
      // 空上下文行：git 输出 `" "`，个别工具会剥成 `""`。
      kind = ' ';
      text = '';
    } else {
      break; // 形态不符：交给外层跳过，避免吞行。
    }

    const diffLine: DiffLine = { kind, text };
    if (kind === ' ') {
      diffLine.oldLine = nextOld++;
      diffLine.newLine = nextNew++;
      oldLeft--;
      newLeft--;
    } else if (kind === '+') {
      diffLine.newLine = nextNew++;
      newLeft--;
      builder.additions++;
    } else {
      diffLine.oldLine = nextOld++;
      oldLeft--;
      builder.deletions++;
    }
    hunk.lines.push(diffLine);
    i++;
  }
  return i;
}
