/**
 * PR review 的读取与发布（见 #6）。
 * - listReviews：`gh api repos/<repo>/pulls/<n>/reviews --paginate`；
 * - findBotMarker：识别 #1 规定的隐藏标记 `<!-- glm-review-bot:sha=<SHA> -->`，
 *   状态库丢失时据此恢复「同一 commit 绝不重复审」的判断；
 * - postReview：`gh api --method POST …/reviews --input -`（JSON 经 stdin），
 *   `event` 固定为 COMMENT（本机器人不 approve / request changes），
 *   行内评论统一 side: RIGHT，多行评论带 start_line / start_side；
 *   HTTP 422 抛 ReviewRejectedError（常见原因：行内评论的行号不在 diff 里），供 #11 降级重试。
 */
import type { RepoSlug } from '../lib/types.ts';
import { ReviewRejectedError, UnexpectedResponseError, summarize } from './errors.ts';
import {
  asNumber,
  asRecord,
  asString,
  assertPositiveInt,
  parsePaginatedObjects,
  parseSingleObject,
  runGh,
  type GithubDeps,
} from './run.ts';

/** 一条已有 review（`gh api …/reviews` 的元素）。 */
export interface ReviewSummary {
  id: number;
  body: string;
  commitId: string;
  submittedAt: string;
  author: string;
}

export async function listReviews(deps: GithubDeps, repo: RepoSlug, number: number): Promise<ReviewSummary[]> {
  assertPositiveInt(number, 'PR 编号');
  const result = await runGh(deps, ['api', `repos/${repo}/pulls/${number}/reviews`, '--paginate']);
  return parsePaginatedObjects(result.stdout).map((raw) => ({
    id: asNumber(raw.id),
    body: asString(raw.body),
    commitId: asString(raw.commit_id),
    submittedAt: asString(raw.submitted_at),
    author: asString(asRecord(raw.user)?.login),
  }));
}

/** #1 规定的「已审过该 commit」隐藏标记。 */
export function botMarker(sha: string): string {
  return `<!-- glm-review-bot:sha=${sha} -->`;
}

/**
 * 在已有 review 里找标记了指定 head SHA 的那条；找不到返回 undefined。
 * 标记里嵌的是完整 SHA，别的 SHA 一律不匹配。
 */
export function findBotMarker(reviews: ReviewSummary[], headSha: string): ReviewSummary | undefined {
  const marker = botMarker(headSha);
  return reviews.find((review) => review.body.includes(marker));
}

/** 一条行内评论（发布前形态；side 统一 RIGHT，与 #1 的发布规则一致）。 */
export interface InlineComment {
  path: string;
  line: number;
  body: string;
  /** 多行评论的起始行；省略 = 单行评论。非法（>= line）时按单行发布。 */
  startLine?: number;
}

/** postReview 入参；`event` 字段仅为兼容调用方，恒被忽略（只发 COMMENT）。 */
export interface PostReviewInput {
  commitId: string;
  body: string;
  comments?: InlineComment[];
  event?: string;
}

/** gh api 的行内评论载荷（snake_case，side/start_side 固定 RIGHT）。 */
interface ApiInlineComment {
  path: string;
  line: number;
  side: 'RIGHT';
  start_line?: number;
  start_side?: 'RIGHT' | 'LEFT';
  body: string;
}

function toApiComment(comment: InlineComment): ApiInlineComment {
  const api: ApiInlineComment = {
    path: comment.path,
    line: comment.line,
    side: 'RIGHT',
    body: comment.body,
  };
  if (comment.startLine !== undefined && comment.startLine >= 1 && comment.startLine < comment.line) {
    api.start_line = comment.startLine;
    api.start_side = 'RIGHT';
  }
  return api;
}

/** 发布一条 COMMENT review，返回 review 的 html_url。 */
export async function postReview(
  deps: GithubDeps,
  repo: RepoSlug,
  number: number,
  input: PostReviewInput,
): Promise<string> {
  assertPositiveInt(number, 'PR 编号');
  const payload = {
    commit_id: input.commitId,
    body: input.body,
    // #1：只发 COMMENT，即使调用方传了别的 event 也忽略。
    event: 'COMMENT' as const,
    comments: (input.comments ?? []).map(toApiComment),
  };
  const result = await runGh(deps, ['api', '--method', 'POST', `repos/${repo}/pulls/${number}/reviews`, '--input', '-'], {
    input: JSON.stringify(payload),
    classify: (failure) => {
      const combined = `${failure.stderr}\n${failure.stdout}`;
      if (combined.toLowerCase().includes('http 422')) {
        return new ReviewRejectedError(
          `GitHub 拒绝了这条 review（HTTP 422，常见原因：某条行内评论的行号不在 diff 中）：${summarize(combined)}`,
          combined.trim(),
        );
      }
      return undefined;
    },
  });
  const parsed = parseSingleObject(result.stdout, 'gh api 发布 review 的响应');
  const htmlUrl = asString(parsed.html_url);
  if (htmlUrl === '') {
    throw new UnexpectedResponseError('发布 review 成功，但响应里没有 html_url 字段');
  }
  return htmlUrl;
}
