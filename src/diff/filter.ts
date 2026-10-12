/**
 * 文件过滤（#7）：按调用方传入的忽略规则（来自仓库 `.glm-review.yml`，由
 * `src/config` 解析后以 `isIgnored(path)` 回调传入——本模块不 import config）
 * 与模块内置规则过滤，产出参与审查的文件与被排除清单。
 */
import type { DiffFile } from './types.ts';

/** 生成文件标记：新文件可见的前几行含任一标记即视为生成文件（大小写敏感，按惯例全大写/小写）。 */
export const GENERATED_MARKERS: readonly string[] = ['@generated', 'DO NOT EDIT'];

/** 生成文件判定的采样行数：diff 里新文件侧（新增 + 上下文行）的前 5 行。 */
const GENERATED_SCAN_LINES = 5;

/** 被排除的文件与原因（原因用于日志与审查总评说明）。 */
export interface IgnoredFile {
  path: string;
  reason: string;
}

export interface FilterResult {
  /** 保留下来参与审查的文件，保持原顺序。 */
  kept: DiffFile[];
  /** 被排除的文件，保持原顺序。 */
  ignored: IgnoredFile[];
}

/**
 * 是否生成文件：取 diff 中新文件侧可见的前 `5` 行（新增 + 上下文行，按出现顺序），
 * 任一行含 `@generated` 或 `DO NOT EDIT` 即判定为生成文件。改动不在文件头部时
 * 采样到的是 hunk 附近的上下文行——头部标记不在 diff 里时无法识别，属预期折衷。
 */
export function isGeneratedFile(file: DiffFile): boolean {
  const scanned: string[] = [];
  for (const hunk of file.hunks) {
    for (const line of hunk.lines) {
      if (line.kind === '-') continue;
      scanned.push(line.text);
      if (scanned.length >= GENERATED_SCAN_LINES) break;
    }
    if (scanned.length >= GENERATED_SCAN_LINES) break;
  }
  return scanned.some((text) =>
    GENERATED_MARKERS.some((marker) => text.includes(marker)),
  );
}

/**
 * 过滤文件：依次套用忽略规则（调用方）、二进制、纯删除文件、生成文件标记。
 * 命中即排除并记录原因，不做其他处理。
 */
export function filterFiles(
  files: DiffFile[],
  isIgnored: (path: string) => boolean,
): FilterResult {
  const kept: DiffFile[] = [];
  const ignored: IgnoredFile[] = [];
  for (const file of files) {
    if (isIgnored(file.path)) {
      ignored.push({ path: file.path, reason: '命中忽略规则' });
    } else if (file.binary) {
      ignored.push({ path: file.path, reason: '二进制文件' });
    } else if (file.status === 'deleted') {
      ignored.push({ path: file.path, reason: '纯删除文件' });
    } else if (isGeneratedFile(file)) {
      ignored.push({ path: file.path, reason: '生成文件标记' });
    } else {
      kept.push(file);
    }
  }
  return { kept, ignored };
}
