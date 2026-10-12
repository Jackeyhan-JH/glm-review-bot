/**
 * 评论正文与总评的排版（#10）。
 *
 * 排版输入（标题、说明、suggestion、文件路径、各块 summary）都来自模型输出与
 * diff，属不可信文本，这里统一做三道防护：
 * - 剥离伪造成的去重标记（防止模型输出里混入 `<!-- glm-review-bot:sha=… -->`
 *   伪造「已审过」）；
 * - 代码围栏自适应加长（内容里出现 ``` 时围栏多一个反引号，避免提前闭合）；
 * - 超长截断并注明（总评 ≤ 60000 字符、单条行内评论 ≤ 8000 字符），截断时
 *   优先保留去重标记与页脚，不破坏去重与署名。
 *
 * 固定文案随 `lang` 切换（`language: en` 时全英文），技术名词（严重度枚举、
 * 模型名、suggestion）不翻译。
 */
import type { NormalizedFinding, Severity } from '../findings/types.ts';
import { botMarker, type InlineComment } from '../github/reviews.ts';
import { SEVERITY_LABEL } from '../lib/types.ts';
import type { Lang, ReviewMeta } from './types.ts';

/** 总评正文长度上限（字符，按 Unicode 码点计）。 */
export const BODY_MAX_CHARS = 60_000;

/** 单条行内评论正文长度上限（字符，按 Unicode 码点计）。 */
export const COMMENT_MAX_CHARS = 8_000;

/** 去重标记的形态（与 #6 botMarker 一致，仅用于识别与保留，不在这里拼 SHA）。 */
const MARKER_IN_TEXT = /<!--\s*glm-review-bot:sha=[0-9a-fA-F]+\s*-->/;

/** 不可信文本里可能出现的任何 glm-review-bot 隐藏标记（含伪造变体）。 */
const FORGED_MARKER = /<!--\s*glm-review-bot:[^>]*?-->/g;

/** 行内评论页脚（截断时保留；合并进总评时全部剥掉）。 */
const COMMENT_FOOTER = /<sub>🤖 glm-review-bot · [^\n]*<\/sub>/g;

const EN_SEVERITY: Record<Severity, string> = {
  blocker: 'blocker',
  major: 'major',
  minor: 'minor',
  nit: 'nit',
};

const SEVERITY_EMOJI: Record<Severity, string> = {
  blocker: '🔴',
  major: '🟠',
  minor: '🟡',
  nit: '⚪',
};

const SEVERITIES_HIGH_TO_LOW: Severity[] = ['blocker', 'major', 'minor', 'nit'];

/** 严重度显示名（zh 用 lib 的中文标签，en 用枚举原词）。 */
export function severityLabel(severity: Severity, lang: Lang): string {
  return lang === 'zh' ? SEVERITY_LABEL[severity] : EN_SEVERITY[severity];
}

/** 剥离不可信文本里的 glm-review-bot 隐藏标记（防伪造去重标记）。 */
export function stripBotMarkers(text: string): string {
  return text.replace(FORGED_MARKER, '');
}

/** 压成一行（去注释标记 + 折叠空白）：标题、文件路径等单行字段统一走这里，
 *  防止不可信文本里的换行把列表项 / 加粗行撑破、注入别的 markdown 结构。 */
function oneLine(text: string): string {
  return stripBotMarkers(text).replace(/\s+/g, ' ').trim();
}

/** 取最后一个匹配（页脚 / 标记取最后一个：我们自己追加的才在最后，
 *  不可信文本里伪造的同形片段排在前面，不该被当成要保留的结尾）。 */
function lastMatch(text: string, pattern: RegExp): string | undefined {
  const global = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`);
  let last: string | undefined;
  for (const match of text.matchAll(global)) last = match[0];
  return last;
}

/** 字符数按 Unicode 码点计（emoji / CJK 不会被拆成半个）。 */
function cpLength(text: string): number {
  return Array.from(text).length;
}

/** 按码点截取前 max 个字符。 */
function clipCp(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length <= max ? text : chars.slice(0, max).join('');
}

/** 代码围栏：比内容里最长的反引号串多一个，最少 3 个。 */
export function fenceOf(code: string): string {
  let longest = 0;
  let run = 0;
  for (const ch of code) {
    if (ch === '`') {
      run += 1;
      if (run > longest) longest = run;
    } else {
      run = 0;
    }
  }
  return '`'.repeat(Math.max(3, longest + 1));
}

/** 评论覆盖的行数（`endLine` 合法且大于 `line` 时为多行，否则单行）。 */
export function commentSpan(finding: NormalizedFinding): number {
  return finding.endLine !== undefined && finding.endLine > finding.line
    ? finding.endLine - finding.line + 1
    : 1;
}

/**
 * suggestion 能否用 GitHub 的一键替换语法：只有当代码行数与评论覆盖的行数
 * 一致时才可信（suggestion 会整段替换被评论的行；行数对不上时按普通代码块
 * 展示，避免一键应用后删掉 / 多出几行）。
 */
export function suggestionFits(finding: NormalizedFinding): boolean {
  const suggestion = finding.suggestion;
  if (suggestion === undefined || suggestion.trim() === '') return false;
  return suggestion.trimEnd().split('\n').length === commentSpan(finding);
}

/** 耗时显示：<1s 用毫秒，<1min 用秒（一位小数），再往上用分秒（先取整秒再拆，避免 1m60s）。 */
export function formatDuration(ms: number): string {
  if (ms < 1_000) return `${Math.max(0, Math.round(ms))}ms`;
  if (ms < 60_000) return `${(ms / 1_000).toFixed(1)}s`;
  const totalSeconds = Math.round(ms / 1_000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return seconds === 0 ? `${minutes}m` : `${minutes}m${seconds}s`;
}

/** 截断注明文案。 */
function truncationNote(lang: Lang): string {
  return lang === 'zh' ? '（正文超长，已截断）' : '(Body truncated due to length limit.)';
}

/** 行内评论页脚：模型名署名。 */
function commentFooter(model: string): string {
  return `<sub>🤖 glm-review-bot · ${model}</sub>`;
}

/**
 * 截断点若落在代码围栏内部，围栏后面的注明 / 页脚 / 标记会被 GitHub 当成
 * 代码内容渲染（行内评论里甚至会被并进一键替换的代码）。按 CommonMark 规则
 * 扫描未闭合的围栏，返回需要补上的闭合围栏（无则空串）。
 */
function unclosedFenceCloser(text: string): string {
  let open: { char: string; length: number } | undefined;
  for (const line of text.split('\n')) {
    const match = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (match === null) continue;
    const fence = match[1] as string;
    const info = match[2] ?? '';
    if (open === undefined) {
      // 反引号围栏的 info string 里不能出现反引号，否则这不是围栏。
      if (fence[0] === '`' && info.includes('`')) continue;
      open = { char: fence[0] as string, length: fence.length };
    } else if (fence[0] === open.char && fence.length >= open.length && info.trim() === '') {
      open = undefined;
    }
  }
  return open === undefined ? '' : open.char.repeat(open.length);
}

/**
 * 截断到 max 字符并注明；`tail` 是必须保留的结尾片段（去重标记 / 页脚），
 * 不在结尾或不存在时放弃保留。截断处补齐未闭合的代码围栏，截断后总长恒 ≤ max。
 */
function truncatePreserving(text: string, max: number, lang: Lang, tail?: string): string {
  if (cpLength(text) <= max) return text;
  const note = truncationNote(lang);
  const keep = tail !== undefined && text.endsWith(tail) ? `\n${tail}` : '';
  const assemble = (budget: number): string => {
    const clipped = clipCp(text, Math.max(budget, 0)).trimEnd();
    const closer = unclosedFenceCloser(clipped);
    return `${clipped}${closer === '' ? '' : `\n${closer}`}\n${note}${keep}`;
  };
  let budget = max - cpLength(note) - 1 - cpLength(keep);
  let candidate = assemble(budget);
  while (cpLength(candidate) > max && budget > 0) {
    // 补闭合围栏可能又超了一点：继续收缩预算直到装得下。
    budget -= Math.max(1, cpLength(candidate) - max);
    candidate = assemble(budget);
  }
  return candidate;
}

/** 总评截断（保留去重标记——它丢了去重就失效）。 */
export function enforceBodyLimit(body: string, max: number, lang: Lang): string {
  return truncatePreserving(body, max, lang, lastMatch(body, MARKER_IN_TEXT));
}

/** 行内评论截断（保留署名页脚；结尾的才是我们追加的，伪造的不算）。 */
export function enforceCommentLimit(text: string, max: number, lang: Lang): string {
  return truncatePreserving(text, max, lang, lastMatch(text, COMMENT_FOOTER));
}

/**
 * 一条行内评论的正文：`**[严重度] 标题**` + 说明 + 可选 suggestion 代码块
 * （行数与评论范围一致才用一键替换语法，否则普通代码块）+ 署名页脚。
 */
export function formatInlineComment(finding: NormalizedFinding, model: string, lang: Lang): string {
  const zh = lang === 'zh';
  const title = oneLine(finding.title);
  const body = stripBotMarkers(finding.body).trim();
  const suggestion = stripBotMarkers(finding.suggestion ?? '').trim();

  const parts: string[] = [`**[${severityLabel(finding.severity, lang)}] ${title}**`];
  if (body !== '') parts.push('', body);
  if (suggestion !== '') {
    const fence = fenceOf(suggestion);
    if (suggestionFits(finding)) {
      parts.push('', `${fence}suggestion`, suggestion, fence);
    } else {
      // 行数对不上：一键替换会破坏上下文，退化为普通代码块。
      parts.push('', zh ? '建议改为：' : 'Suggested change:', '', fence, suggestion, fence);
    }
  }
  parts.push('', commentFooter(model));
  return enforceCommentLimit(parts.join('\n'), COMMENT_MAX_CHARS, lang);
}

/** `文件:行`（多行发现显示 `文件:起-止`）。 */
function locationOf(file: string, line: number, endLine?: number): string {
  const range = endLine !== undefined && endLine > line ? `${line}-${endLine}` : `${line}`;
  return `\`${oneLine(file)}:${range}\``;
}

/** 列表项形态的发现：`文件:行` + 严重度标题 + 说明（标题与说明压成一行，避免打断列表）。 */
function findingItem(finding: NormalizedFinding, lang: Lang): string {
  const body = oneLine(finding.body);
  const head = `${locationOf(finding.file, finding.line, finding.endLine)} **[${severityLabel(finding.severity, lang)}] ${oneLine(finding.title)}**`;
  return body === '' ? `- ${head}` : `- ${head} — ${body}`;
}

/** formatSummary 的输入（buildReview 负责填默认值，这里收到的都是确定值）。 */
export interface SummaryInput {
  headSha: string;
  inline: NormalizedFinding[];
  overflow: NormalizedFinding[];
  belowThreshold: NormalizedFinding[];
  meta: ReviewMeta;
  lang: Lang;
}

/**
 * 总评正文：标题行 → 一句话结论（或「未发现需要处理的问题 ✅」）→ 严重度计数表
 * → 未挂到行的 / 超出配额的问题 → 低于阈值省略数量 → 忽略与截断的文件 → 仓库
 * 配置错误 → 元信息（commit 短 SHA、模型、分块数、耗时）→ 隐藏去重标记。
 */
export function formatSummary(input: SummaryInput): string {
  const zh = input.lang === 'zh';
  const published = [...input.inline, ...input.overflow];
  const parts: string[] = [zh ? '## 🤖 GLM 代码审查' : '## 🤖 GLM Code Review'];

  const summaryText = stripBotMarkers(input.meta.summary ?? '').trim();
  if (published.length === 0) {
    parts.push('', zh ? '未发现需要处理的问题 ✅' : 'No issues that need attention ✅');
  } else if (summaryText !== '') {
    parts.push('', summaryText);
  }

  if (published.length > 0) {
    const counts = SEVERITIES_HIGH_TO_LOW.map((severity) => ({
      severity,
      count: published.filter((finding) => finding.severity === severity).length,
    })).filter((row) => row.count > 0);
    parts.push(
      '',
      `| ${zh ? '严重度' : 'Severity'} | ${zh ? '数量' : 'Count'} |`,
      '| --- | --- |',
      ...counts.map((row) => `| ${SEVERITY_EMOJI[row.severity]} ${severityLabel(row.severity, input.lang)} | ${row.count} |`),
    );
  }

  // overflow 里挂不上行的是「行号落不进 diff」，inline=true 的则是配额用尽。
  const unanchored = input.overflow.filter((finding) => !finding.inline);
  if (unanchored.length > 0) {
    parts.push(
      '',
      zh ? '### 未能挂到行上的问题' : '### Issues not anchored to diff lines',
      '',
      zh
        ? `以下 ${unanchored.length} 条的行号不在可评论范围内，一并列在这里：`
        : `The following ${unanchored.length} finding(s) could not be anchored to a commentable diff line:`,
      '',
      ...unanchored.map((finding) => findingItem(finding, input.lang)),
    );
  }
  const overQuota = input.overflow.filter((finding) => finding.inline);
  if (overQuota.length > 0) {
    parts.push(
      '',
      zh ? '### 超出行内评论上限的问题' : '### Issues beyond the inline comment limit',
      '',
      zh
        ? `以下 ${overQuota.length} 条因行内评论数已达上限，未单独挂出：`
        : `The following ${overQuota.length} finding(s) were not posted inline because the comment limit was reached:`,
      '',
      ...overQuota.map((finding) => findingItem(finding, input.lang)),
    );
  }
  if (input.belowThreshold.length > 0) {
    parts.push(
      '',
      zh
        ? `另有 ${input.belowThreshold.length} 条低于严重度阈值的问题未列出。`
        : `Omitted ${input.belowThreshold.length} lower-severity finding(s) below the severity threshold.`,
    );
  }

  const ignored = input.meta.ignoredFiles ?? [];
  if (ignored.length > 0) {
    parts.push('', zh ? '### 未纳入审查的文件' : '### Files excluded from review', '');
    for (const file of ignored) parts.push(`- \`${file.path}\` — ${file.reason}`);
  }
  const truncated = input.meta.truncatedFiles ?? [];
  if (truncated.length > 0) {
    parts.push('', zh ? '### 审查范围截断' : '### Review scope truncated', '');
    for (const file of truncated) parts.push(`- \`${file.path}\` — ${file.reason}`);
  }
  const configErrors = input.meta.configErrors ?? [];
  if (configErrors.length > 0) {
    parts.push(
      '',
      zh ? '### ⚠️ 仓库配置有误' : '### ⚠️ Repository config errors',
      '',
      zh
        ? '`.glm-review.yml` 存在以下问题，本次已按默认配置审查：'
        : '`.glm-review.yml` has the following problems; defaults were used this time:',
      '',
      ...configErrors.map((error) => `- ${error}`),
    );
  }

  const shortSha = input.headSha.slice(0, 7);
  const meta = zh
    ? `🤖 commit \`${shortSha}\` · 模型 \`${input.meta.model}\` · 分块 ${input.meta.chunks} · 耗时 ${formatDuration(input.meta.durationMs)}`
    : `🤖 commit \`${shortSha}\` · model \`${input.meta.model}\` · ${input.meta.chunks} chunk(s) · ${formatDuration(input.meta.durationMs)}`;
  parts.push('', '---', '', meta, '', botMarker(input.headSha));
  return enforceBodyLimit(parts.join('\n'), BODY_MAX_CHARS, input.lang);
}

/** 行内评论的定位（`文件:起-止`，与 InlineComment 的行号对应；预览页复用）。 */
export function commentLocation(comment: InlineComment): string {
  const range =
    comment.startLine !== undefined && comment.startLine < comment.line
      ? `${comment.startLine}-${comment.line}`
      : `${comment.line}`;
  return `\`${oneLine(comment.path)}:${range}\``;
}

/** 422 降级时把行内评论并进总评的段落：逐条列出定位 + 评论正文（去掉全部页脚，含伪造的）。 */
export function degradeSection(comments: InlineComment[], lang: Lang): string {
  const zh = lang === 'zh';
  const items = comments.map((comment) => {
    const text = stripBotMarkers(comment.body).replace(COMMENT_FOOTER, '').trim();
    const indented = text
      .split('\n')
      .map((line) => (line === '' ? '' : `  ${line}`))
      .join('\n');
    return `- ${commentLocation(comment)}\n${indented}`;
  });
  return [
    zh ? '### ⚠️ 行内评论无法发布' : '### ⚠️ Inline comments could not be posted',
    '',
    zh
      ? `GitHub 拒绝了带行内评论的 review（通常是行号不在最新 diff 中），以下 ${comments.length} 条已并入总评：`
      : `GitHub rejected the review with inline comments (usually because a line is no longer in the diff); the following ${comments.length} are merged into this summary:`,
    '',
    ...items,
  ].join('\n');
}

/**
 * 422 降级后的总评：原总评 + 并入的行内评论段落。去重标记挪到最末，
 * 截断时优先保留。
 */
export function degradeBody(body: string, comments: InlineComment[], lang: Lang): string {
  if (comments.length === 0) return body;
  const marker = MARKER_IN_TEXT.exec(body)?.[0];
  const base = marker === undefined ? body.trimEnd() : body.replace(marker, '').trimEnd();
  const combined =
    marker === undefined
      ? `${base}\n\n---\n\n${degradeSection(comments, lang)}`
      : `${base}\n\n---\n\n${degradeSection(comments, lang)}\n${marker}`;
  return enforceBodyLimit(combined, BODY_MAX_CHARS, lang);
}
