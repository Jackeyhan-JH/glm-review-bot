/**
 * 多块审查结果的合并、去重、排序与阈值分流（#9）。
 *
 * 分块审查（#7 chunkDiff）会对同一个文件的多段 hunk 各审一次，模型可能对
 * 同一处问题重复报告；合并时按「同文件、行号相距 ≤ 2、标题相似（归一化后
 * 相同或一方包含另一方）」判重，保留严重度高者。排序按严重度 → 文件 → 行号，
 * `applyThreshold` 在这个顺序上做阈值过滤与行内评论配额。
 */
import { SEVERITY_ORDER } from '../lib/types.ts';
import type { NormalizedFinding, Severity } from './types.ts';

/** 一块审查的归一化结果（normalizeFindings 的输出 + 该块的 summary）。 */
export interface ChunkReview {
  /** 该块的总体评价；可为空（空字符串在合并时跳过）。 */
  summary?: string;
  findings: NormalizedFinding[];
}

/** 合并后的审查结果。 */
export interface MergedReview {
  /** 各块非空 summary 去重后按块序拼接。 */
  summary: string;
  /** 去重、排序后的发现。 */
  findings: NormalizedFinding[];
}

/** 标题归一化：去空白与标点、统一小写，只留字母数字与 CJK 字符。 */
export function normalizeTitle(title: string): string {
  return Array.from(title)
    .filter((ch) => /\p{L}|\p{N}/u.test(ch))
    .join('')
    .toLowerCase();
}

/** 标题是否相似：归一化后非空且（相同 或 一方包含另一方）。 */
export function titlesSimilar(a: string, b: string): boolean {
  const na = normalizeTitle(a);
  const nb = normalizeTitle(b);
  if (na === '' || nb === '') return false;
  return na === nb || na.includes(nb) || nb.includes(na);
}

/** 两条发现是否视为同一处问题（判重条件见模块注释）。 */
function isDuplicate(a: NormalizedFinding, b: NormalizedFinding): boolean {
  return a.file === b.file && Math.abs(a.line - b.line) <= 2 && titlesSimilar(a.title, b.title);
}

/** 去重：保留先出现的位置，同处保留严重度高者（并列保留先出现者），顺序稳定。 */
export function dedupeFindings(findings: NormalizedFinding[]): NormalizedFinding[] {
  const kept: NormalizedFinding[] = [];
  for (const finding of findings) {
    const index = kept.findIndex((existing) => isDuplicate(existing, finding));
    if (index === -1) {
      kept.push(finding);
      continue;
    }
    const existing = kept[index] as NormalizedFinding;
    if (SEVERITY_ORDER[finding.severity] > SEVERITY_ORDER[existing.severity]) {
      kept[index] = finding;
    }
  }
  return kept;
}

/** 排序：严重度降序 → 文件路径升序 → 行号升序（返回新数组，不改入参）。 */
export function sortFindings(findings: NormalizedFinding[]): NormalizedFinding[] {
  return [...findings].sort((a, b) => {
    const bySeverity = SEVERITY_ORDER[b.severity] - SEVERITY_ORDER[a.severity];
    if (bySeverity !== 0) return bySeverity;
    if (a.file !== b.file) return a.file < b.file ? -1 : 1;
    return a.line - b.line;
  });
}

/**
 * 合并多块审查结果：summary 拼接去重，findings 去重后排序。
 * 空输入返回空结果（没有审查内容时不编造总结）。
 */
export function mergeChunkReviews(chunks: ChunkReview[]): MergedReview {
  const summaries = new Set<string>();
  for (const chunk of chunks) {
    const text = chunk.summary?.trim() ?? '';
    if (text !== '') summaries.add(text);
  }
  return {
    summary: [...summaries].join('\n\n'),
    findings: sortFindings(dedupeFindings(chunks.flatMap((chunk) => chunk.findings))),
  };
}

export interface ThresholdResult {
  /** 可以挂行内评论的发现（按输入顺序取前 maxComments 个 inline 发现）。 */
  inline: NormalizedFinding[];
  /** 超出行内配额、或行号落不到可评论行的发现：并入总评。 */
  overflow: NormalizedFinding[];
  /** 低于 minSeverity 的发现：不发。 */
  belowThreshold: NormalizedFinding[];
}

/**
 * 阈值分流：低于 `minSeverity` 的不发；其余里 `inline: true` 的按顺序占用
 * 行内评论配额（`maxComments`，配额用尽或本就不能挂行的并入总评）。
 * 输入应是排序后的列表（mergeChunkReviews 的输出），按传入顺序分配。
 */
export function applyThreshold(
  findings: NormalizedFinding[],
  minSeverity: Severity,
  maxComments: number,
): ThresholdResult {
  const inline: NormalizedFinding[] = [];
  const overflow: NormalizedFinding[] = [];
  const belowThreshold: NormalizedFinding[] = [];
  const floor = SEVERITY_ORDER[minSeverity];
  for (const finding of findings) {
    if (SEVERITY_ORDER[finding.severity] < floor) {
      belowThreshold.push(finding);
    } else if (finding.inline && inline.length < maxComments) {
      inline.push(finding);
    } else {
      overflow.push(finding);
    }
  }
  return { inline, overflow, belowThreshold };
}
