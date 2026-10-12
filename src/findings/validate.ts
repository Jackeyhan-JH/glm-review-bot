/**
 * 模型输出的校验与归一化（#9）：把 `claude` 的结构化输出变成可信的发现列表。
 * diff 与模型输出都是不可信输入，这里逐条校验，坏条目丢弃并记录原因，不抛错。
 *
 * 丢弃：结构不合法（缺字段、类型不对、严重度认不出）、文件被忽略规则排除、
 * 文件不在本块 diff 中。
 * 修正：行号用 `nearestCommentable` 落到可评论行（RIGHT 侧），落不到则
 * `inline: false`（只进总评）；`endLine < line` 交换；多行范围跨 hunk 或
 * 落不到可评论行时降为单行；title / body 超长截断。
 */
import { commentableLines, nearestCommentable } from '../diff/linemap.ts';
import type { DiffFile, Hunk } from '../diff/types.ts';
import { BODY_MAX_LENGTH, SUGGESTION_MAX_LENGTH, TITLE_MAX_LENGTH } from './schema.ts';
import { SEVERITY_ENUM, type DroppedFinding, type NormalizedFinding, type Severity } from './types.ts';

/** 严重度别名 → 规范值（大小写不敏感；含中文习惯叫法）。 */
const SEVERITY_ALIASES: Record<string, Severity> = {
  critical: 'blocker',
  严重: 'blocker',
  high: 'major',
  重要: 'major',
  medium: 'minor',
  一般: 'minor',
  low: 'nit',
  info: 'nit',
  建议: 'nit',
};

/** 严重度归一化：规范值原样接受，别名映射，认不出返回 null。 */
export function normalizeSeverity(raw: unknown): Severity | null {
  if (typeof raw !== 'string') return null;
  const key = raw.trim().toLowerCase();
  if (key === '') return null;
  if ((SEVERITY_ENUM as readonly string[]).includes(key)) return key as Severity;
  return SEVERITY_ALIASES[key] ?? null;
}

/** 行号解析：整数，或纯数字字符串（模型偶发输出字符串数字）；其余 null。 */
function parseLineNumber(raw: unknown): number | null {
  if (typeof raw === 'number' && Number.isInteger(raw)) return raw;
  if (typeof raw === 'string' && /^[0-9]+$/.test(raw.trim())) return Number.parseInt(raw.trim(), 10);
  return null;
}

/** 按字（Unicode 码点）截断到上限：截断时留一位给省略号，总长恰为 max。 */
function clip(text: string, max: number): string {
  const chars = Array.from(text);
  if (chars.length <= max) return text;
  return `${chars.slice(0, max - 1).join('')}…`;
}

/** 错误信息里的值预览：截到 40 字，避免把整段输出带进日志。 */
function preview(value: unknown, max = 40): string {
  let text: string;
  if (typeof value === 'string') text = value;
  else if (value === undefined) text = '未提供';
  else {
    try {
      text = JSON.stringify(value) ?? String(value);
    } catch {
      text = String(value);
    }
  }
  return clip(text, max);
}

/** suggestion 可省略；非字符串或空白视为未提供，超长截断。 */
function suggestionOf(record: Record<string, unknown>): { suggestion?: string } {
  if (typeof record.suggestion !== 'string' || record.suggestion.trim() === '') return {};
  return { suggestion: clip(record.suggestion.trim(), SUGGESTION_MAX_LENGTH) };
}

/** 行号所在的新侧 hunk（行号来自 commentableLines 时必有）。 */
function hunkOfNewLine(file: DiffFile, line: number): Hunk | undefined {
  return file.hunks.find((hunk) => line >= hunk.newStart && line <= hunk.newStart + hunk.newLines - 1);
}

/**
 * 多行范围的终点是否可用：必须 > 起点、在可评论集合内、且与起点同处一个
 * hunk（跨 hunk 的范围 GitHub 挂不了评论，降为单行）。
 */
function fitEndLine(file: DiffFile, start: number, end: number): number | null {
  if (end <= start) return null;
  if (!commentableLines(file).has(end)) return null;
  const hunk = hunkOfNewLine(file, start);
  if (hunk === undefined) return null;
  return end <= hunk.newStart + hunk.newLines - 1 ? end : null;
}

export interface NormalizeOptions {
  /** 被忽略规则排除的文件路径（`filterFiles` 的 ignored 清单），命中即丢弃。 */
  ignoredPaths?: readonly string[];
}

export interface NormalizeResult {
  findings: NormalizedFinding[];
  dropped: DroppedFinding[];
}

/** 从整体输出里取 findings 数组；整体结构不对时记一条丢弃并返回 null。 */
function readFindingList(raw: unknown, dropped: DroppedFinding[]): unknown[] | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    dropped.push({ reason: '输出不是 JSON 对象', raw });
    return null;
  }
  const findings = (raw as Record<string, unknown>).findings;
  if (!Array.isArray(findings)) {
    dropped.push({ reason: '输出缺少 findings 数组', raw });
    return null;
  }
  return findings;
}

/**
 * 校验并归一化一块审查输出。`diffFiles` 是本块的文件（过滤与分块之后的），
 * 行号修正、跨 hunk 判断都只针对这些文件；文件不在其中的发现直接丢弃。
 */
export function normalizeFindings(
  raw: unknown,
  diffFiles: DiffFile[],
  options: NormalizeOptions = {},
): NormalizeResult {
  const dropped: DroppedFinding[] = [];
  const findings: NormalizedFinding[] = [];

  const list = readFindingList(raw, dropped);
  if (list === null) return { findings, dropped };

  const byPath = new Map<string, DiffFile>();
  for (const file of diffFiles) byPath.set(file.path, file);
  const ignored = new Set(options.ignoredPaths ?? []);

  for (const item of list) {
    const one = normalizeOne(item, byPath, ignored);
    if (typeof one === 'string') dropped.push({ reason: one, raw: item });
    else findings.push(one);
  }
  return { findings, dropped };
}

/** 校验单条发现：返回归一化结果，或丢弃原因（字符串）。 */
function normalizeOne(
  item: unknown,
  byPath: Map<string, DiffFile>,
  ignored: ReadonlySet<string>,
): NormalizedFinding | string {
  if (item === null || typeof item !== 'object' || Array.isArray(item)) {
    return '结构不合法：不是对象';
  }
  const record = item as Record<string, unknown>;

  const severity = normalizeSeverity(record.severity);
  if (severity === null) {
    return `结构不合法：严重度无法识别（收到 ${preview(record.severity)}）`;
  }

  if (typeof record.file !== 'string' || record.file.trim() === '') {
    return `结构不合法：缺少文件路径（收到 ${preview(record.file)}）`;
  }
  const file = record.file.trim();
  if (ignored.has(file)) {
    return `文件被忽略规则排除（${file}）`;
  }
  const diffFile = byPath.get(file);
  if (diffFile === undefined) {
    return `文件不在本块 diff 中（${file}）`;
  }

  const parsedLine = parseLineNumber(record.line);
  if (parsedLine === null || parsedLine < 1) {
    return `结构不合法：行号不合法（收到 ${preview(record.line)}）`;
  }
  if (typeof record.title !== 'string' || record.title.trim() === '') {
    return `结构不合法：缺少标题（收到 ${preview(record.title)}）`;
  }
  if (typeof record.body !== 'string' || record.body.trim() === '') {
    return `结构不合法：缺少说明（收到 ${preview(record.body)}）`;
  }

  // endLine 可省略；提供了但读不出合法值时当作未提供（提示词已要求整数）。
  const parsedEnd = parseLineNumber(record.endLine);
  const hasEnd =
    record.endLine !== undefined && record.endLine !== null && parsedEnd !== null && parsedEnd >= 1;
  let start = parsedLine;
  let end = hasEnd ? parsedEnd : undefined;
  if (end !== undefined && end < start) {
    [start, end] = [end, start];
  }

  const title = clip(record.title.trim(), TITLE_MAX_LENGTH);
  const body = clip(record.body.trim(), BODY_MAX_LENGTH);
  const suggestion = suggestionOf(record);

  const corrected = nearestCommentable(diffFile, start);
  if (corrected === null) {
    // 落不到任何可评论行（hunk 之间的行、diff 范围外、纯删除 hunk）：保留
    // 原始行号，只进总评。
    return { severity, file, line: start, title, body, ...suggestion, inline: false };
  }

  const endLine = end === undefined ? null : fitEndLine(diffFile, corrected, end);
  return {
    severity,
    file,
    line: corrected,
    ...(endLine !== null ? { endLine } : {}),
    title,
    body,
    ...suggestion,
    inline: true,
  };
}
