/**
 * 组装 review（#10）：#9 的分流结果（inline / overflow / belowThreshold）+
 * 审查元信息 → #6 `postReview` 的入参形态（`{ commitId, body, comments }`）。
 * 纯函数，不发任何请求；排版细节都在 format.ts。
 */
import type { NormalizedFinding } from '../findings/types.ts';
import type { InlineComment } from '../github/reviews.ts';
import { formatInlineComment, formatSummary } from './format.ts';
import type { BuildReviewInput, BuiltReview, Lang } from './types.ts';

/**
 * 一条发现 → 一条行内评论：多行发现（`endLine > line`）映射为
 * `start_line = line`、`line = endLine`（#6 会统一补 side: RIGHT 并要求
 * start_line < line）；`endLine` 缺失或不合法时按单行发布。
 */
function toInlineComment(finding: NormalizedFinding, model: string, lang: Lang): InlineComment {
  const multi = finding.endLine !== undefined && finding.endLine > finding.line;
  return {
    path: finding.file,
    line: multi ? (finding.endLine as number) : finding.line,
    ...(multi ? { startLine: finding.line } : {}),
    body: formatInlineComment(finding, model, lang),
  };
}

/** 组装一条完整的 COMMENT review（正文与评论都已完成长度控制与排版）。 */
export function buildReview(input: BuildReviewInput): BuiltReview {
  const lang = input.lang ?? 'zh';
  const headSha = (input.headSha ?? input.pr.headSha).trim();
  return {
    commitId: headSha,
    body: formatSummary({
      headSha,
      inline: input.inline,
      overflow: input.overflow,
      belowThreshold: input.belowThreshold ?? [],
      meta: input.meta,
      lang,
    }),
    comments: input.inline.map((finding) => toInlineComment(finding, input.meta.model, lang)),
    lang,
  };
}
