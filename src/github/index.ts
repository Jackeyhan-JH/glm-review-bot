/**
 * GitHub 适配层（#6）对外入口：所有与 GitHub 的交互都经由本模块（只用 gh CLI）。
 * 上层模块（#10 发布、#11 流水线、#12 触发规则）从这里导入。
 */
export * from './errors.ts';
export type { GithubDeps, RunOptions } from './run.ts';
export {
  assertPositiveInt,
  parseConcatenatedJson,
  flattenPages,
  parsePaginatedObjects,
  parseSingleObject,
  parseObjectArray,
  asRecord,
  asString,
  asNumber,
  asBoolean,
  runGh,
  runGit,
} from './run.ts';
export {
  DEFAULT_MAX_DIFF_BYTES,
  listOpenPrs,
  getPr,
  getDiff,
  getPrComments,
  type GetDiffOptions,
  type PrComment,
} from './prs.ts';
export {
  listReviews,
  findBotMarker,
  botMarker,
  postReview,
  type ReviewSummary,
  type InlineComment,
  type PostReviewInput,
} from './reviews.ts';
export {
  ensureCheckout,
  pruneCheckouts,
  parseRepoSlug,
  assertValidSha,
  type PruneResult,
} from './checkout.ts';
