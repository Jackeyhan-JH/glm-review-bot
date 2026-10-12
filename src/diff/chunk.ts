/**
 * 分块（#7）：把过滤后的文件按行数预算切成若干块交给 Claude。
 *
 * 预算按「渲染后的文本行数」计（文件头、状态行、hunk 头、正文、文件间空行都算），
 * 因为那才是模型实际消费的长度。规则：
 * - 全部文件装得下（≤ `maxChunkLines`）→ 一块；
 * - 单个文件超预算 → 按 hunk 贪心分组连续切分，每段独立成切片参与装块；
 *   单个 hunk 加文件头就超预算时，允许它单独成块并标记 `oversized: true`；
 * - 块数超过 `maxChunks` → 不再开新块，未完整入块的文件列入 `truncated`
 *  （已入块的部分 hunk 保留，审查总评里说明截断）。
 */
import type { DiffFile, Hunk } from './types.ts';
import { renderFileSlice, sliceOf, type FileSlice } from './render.ts';

export interface ChunkOptions {
  /** 单块行数预算（渲染后文本行数，含文件间空行）。 */
  maxChunkLines: number;
  /** 最多切成多少块。 */
  maxChunks: number;
}

/** 一个分块：发给模型的一份文本。 */
export interface Chunk {
  /** 块内的文件切片，按输入顺序。 */
  parts: FileSlice[];
  /** 渲染后的完整文本（结尾带换行）。 */
  text: string;
  /** 渲染后文本的行数（≤ `maxChunkLines`，`oversized` 块除外）。 */
  lines: number;
  /** 单个 hunk 超预算、允许超限的块。 */
  oversized: boolean;
}

/** 被截断的文件与原因。 */
export interface TruncatedFile {
  path: string;
  reason: string;
}

export interface ChunkPlan {
  chunks: Chunk[];
  truncated: TruncatedFile[];
}

/** 装块单元：一个文件切片（整文件或按 hunk 切出的一段）。 */
interface Item {
  slice: FileSlice;
  lines: number;
  oversized: boolean;
  path: string;
}

/** 过滤后文件的改动行数（`+` 与 `-` 之和），用于模型选择（#8）。 */
export function changedLines(files: DiffFile[]): number {
  return files.reduce((sum, file) => sum + file.additions + file.deletions, 0);
}

/** 单个 hunk 渲染后的行数：hunk 头 1 行 + 正文。 */
function hunkLines(hunk: Hunk): number {
  return 1 + hunk.lines.length;
}

/** 文件按 hunk 分段时每组固定开销：文件头 + 状态行 + 分段说明行。 */
const SPLIT_HEADER_LINES = 3;

/**
 * 大文件按 hunk 贪心分组：每组从 `SPLIT_HEADER_LINES` 行头部开销起，连续装
 * hunk，装不下就开新组；第一个 hunk 本身超预算时单独成组（调用方标记 oversized）。
 */
function groupHunks(file: DiffFile, maxChunkLines: number): Hunk[][] {
  const groups: Hunk[][] = [];
  let current: Hunk[] = [];
  let used = SPLIT_HEADER_LINES;
  for (const hunk of file.hunks) {
    const size = hunkLines(hunk);
    if (current.length > 0 && used + size > maxChunkLines) {
      groups.push(current);
      current = [];
      used = SPLIT_HEADER_LINES;
    }
    current.push(hunk);
    used += size;
  }
  if (current.length > 0) groups.push(current);
  return groups;
}

/** 把文件列表摊成装块单元（整文件优先，超预算的按 hunk 分段）。 */
function buildItems(files: DiffFile[], maxChunkLines: number): Item[] {
  const items: Item[] = [];
  for (const file of files) {
    const whole = sliceOf(file);
    const wholeLines = renderFileSlice(whole).length;
    if (wholeLines <= maxChunkLines || file.hunks.length === 0) {
      // 无 hunk 的文件（纯重命名 / 二进制）渲染只有两三行，无法再切。
      items.push({ slice: whole, lines: wholeLines, oversized: wholeLines > maxChunkLines, path: file.path });
      continue;
    }
    const groups = groupHunks(file, maxChunkLines);
    const total = groups.length;
    groups.forEach((hunks, index) => {
      const slice = sliceOf(file, hunks, { index: index + 1, total });
      const lines = renderFileSlice(slice).length;
      items.push({ slice, lines, oversized: lines > maxChunkLines, path: file.path });
    });
  }
  return items;
}

/** 渲染整块文本：切片之间空一行，结尾带换行；同时返回行数。 */
function renderChunk(parts: FileSlice[]): { text: string; lines: number } {
  const lines: string[] = [];
  for (const part of parts) {
    if (lines.length > 0) lines.push('');
    lines.push(...renderFileSlice(part));
  }
  return { text: `${lines.join('\n')}\n`, lines: lines.length };
}

/**
 * 分块主入口：纯函数，输入过滤后的文件与预算，输出块列表与截断清单。
 * `maxChunks` 限制块数：装不下的文件不删已入块的部分 hunk，只列入 `truncated`。
 */
export function chunkDiff(files: DiffFile[], options: ChunkOptions): ChunkPlan {
  const { maxChunkLines, maxChunks } = options;
  const items = buildItems(files, maxChunkLines);

  // 每个文件摊成的单元总数（截断判断用），先于装块统计完整值。
  const totals = new Map<string, number>();
  for (const item of items) totals.set(item.path, (totals.get(item.path) ?? 0) + 1);

  const placed = new Map<string, number>();
  const drafts: { parts: FileSlice[]; lines: number; oversized: boolean }[] = [];
  for (const item of items) {
    const last = drafts.at(-1);
    const separator = last !== undefined && last.parts.length > 0 ? 1 : 0;
    const fits =
      last !== undefined &&
      !last.oversized &&
      !item.oversized &&
      last.lines + separator + item.lines <= maxChunkLines;
    if (fits) {
      last.parts.push(item.slice);
      last.lines += separator + item.lines;
    } else {
      if (drafts.length >= maxChunks) break; // 不再开新块：余下单元不入块
      drafts.push({ parts: [item.slice], lines: item.lines, oversized: item.oversized });
    }
    placed.set(item.path, (placed.get(item.path) ?? 0) + 1);
  }

  const truncated: TruncatedFile[] = [];
  for (const file of files) {
    const total = totals.get(file.path) ?? 0;
    const got = placed.get(file.path) ?? 0;
    if (got < total) {
      truncated.push({
        path: file.path,
        reason: `块数超过上限（maxChunks=${maxChunks}），仅包含 ${got}/${total} 段`,
      });
    }
  }

  const chunks: Chunk[] = drafts.map((draft) => ({
    parts: draft.parts,
    oversized: draft.oversized,
    ...renderChunk(draft.parts),
  }));
  return { chunks, truncated };
}
