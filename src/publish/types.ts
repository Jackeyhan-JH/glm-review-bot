/**
 * publish 模块（#10）的共享类型：把 #9 的分流结果组装成 #6 能发布的 review。
 * 三个环节各管一段——format 排版、build 组装、post 发布（含 dry-run 与 422 降级）。
 */
import type { TruncatedFile } from '../diff/chunk.ts';
import type { IgnoredFile } from '../diff/filter.ts';
import type { NormalizedFinding } from '../findings/types.ts';
import type { InlineComment } from '../github/reviews.ts';
import type { PrInfo } from '../lib/types.ts';

/** 评论语言（与仓库配置 `.glm-review.yml` 的 language 一致）。 */
export type Lang = 'zh' | 'en';

/** 审查元信息：总评页脚与 dry-run 预览里展示的「这次是怎么审的」。 */
export interface ReviewMeta {
  /** 实际使用的模型（#8 pickModel 的结果）。 */
  model: string;
  /** 分块数（#7 chunkDiff 的块数）。 */
  chunks: number;
  /** 审查耗时毫秒（从开始调用模型到结果合并完成）。 */
  durationMs: number;
  /** 各块 summary 合并后的一句话结论（#9 mergeChunkReviews 的 summary）；可为空。 */
  summary?: string;
  /** 被忽略的文件清单（#7 filterFiles 的 ignored），非空时在总评里说明。 */
  ignoredFiles?: IgnoredFile[];
  /** 被截断的文件清单（#7 chunkDiff 的 truncated），非空时在总评里说明。 */
  truncatedFiles?: TruncatedFile[];
  /** 仓库配置错误（#3 parseRepoConfig 的 errors），非空时在总评里提示。 */
  configErrors?: string[];
}

/** buildReview 的输入：一次审查的全部产出 + PR 上下文。 */
export interface BuildReviewInput {
  /** 被审 PR 的元信息（`gh pr view` 的结果）。 */
  pr: PrInfo;
  /** 本次审查对应的 head SHA；缺省用 `pr.headSha`（审查期间 PR 又推进时应显式传入）。 */
  headSha?: string;
  /** 挂行内评论的发现（#9 applyThreshold 的 inline，按发送顺序）。 */
  inline: NormalizedFinding[];
  /** 并入总评的发现（挂不上行的 + 超出 maxComments 配额的，靠 `inline` 标志区分）。 */
  overflow: NormalizedFinding[];
  /** 低于 minSeverity 被省略的发现，只在总评里报数量。 */
  belowThreshold?: NormalizedFinding[];
  /** 审查元信息。 */
  meta: ReviewMeta;
  /** 评论语言，默认 zh。 */
  lang?: Lang;
}

/** 组装好的 review：字段与 #6 `postReview` 的入参一一对应（side 统一由 #6 补成 RIGHT）。 */
export interface BuiltReview {
  /** 审查对应的 commit（发布为 review 的 commit_id）。 */
  commitId: string;
  /** 总评正文（含隐藏去重标记）。 */
  body: string;
  /** 行内评论（多行评论用 start_line + line，均为新侧行号）。 */
  comments: InlineComment[];
  /** 排版语言；422 降级重排总评时仍要用它。 */
  lang: Lang;
}
