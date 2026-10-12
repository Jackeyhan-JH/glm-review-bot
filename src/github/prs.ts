/**
 * PR 元信息 / diff / 评论查询（见 #6）：全部经由 gh CLI，不读 token、不发 HTTP。
 * - listOpenPrs / getPr：`gh pr list` / `gh pr view --json`，映射成共享的 PrInfo；
 * - getDiff：`gh pr diff` 的 unified diff 文本，超过 maxBytes（默认 2 MB）抛 DiffTooLargeError；
 * - getPrComments：`gh api repos/<repo>/issues/<n>/comments --paginate`（会话评论，
 *   供 #12 识别 `/glm-review` 重审命令）。
 */
import type { PrInfo, RepoSlug } from '../lib/types.ts';
import { DiffTooLargeError, UnexpectedResponseError } from './errors.ts';
import {
  asBoolean,
  asNumber,
  asRecord,
  asString,
  assertPositiveInt,
  parseObjectArray,
  parsePaginatedObjects,
  parseSingleObject,
  runGh,
  type GithubDeps,
} from './run.ts';

const PR_FIELDS =
  'number,title,author,url,headRefOid,baseRefOid,baseRefName,headRefName,isDraft,labels,updatedAt,state';

export const DEFAULT_MAX_DIFF_BYTES = 2 * 1024 * 1024;

/** 列出仓库的开放 PR（最多 100 条，与轮询页大小一致）。 */
export async function listOpenPrs(deps: GithubDeps, repo: RepoSlug): Promise<PrInfo[]> {
  const result = await runGh(deps, [
    'pr',
    'list',
    '--repo',
    repo,
    '--state',
    'open',
    '--limit',
    '100',
    '--json',
    PR_FIELDS,
  ]);
  return parseObjectArray(result.stdout, 'gh pr list 输出').map((raw) => toPrInfo(repo, raw));
}

/** 取单个 PR 的元信息。 */
export async function getPr(deps: GithubDeps, repo: RepoSlug, number: number): Promise<PrInfo> {
  assertPositiveInt(number, 'PR 编号');
  const result = await runGh(deps, ['pr', 'view', String(number), '--repo', repo, '--json', PR_FIELDS]);
  return toPrInfo(repo, parseSinglePr(result.stdout));
}

function parseSinglePr(text: string): Record<string, unknown> {
  return parseSingleObject(text, 'gh pr view 输出');
}

export interface GetDiffOptions {
  /** diff 最大字节数，超过抛 DiffTooLargeError；默认 2 MB。 */
  maxBytes?: number;
}

/** 取 PR 的 unified diff 文本。 */
export async function getDiff(
  deps: GithubDeps,
  repo: RepoSlug,
  number: number,
  options: GetDiffOptions = {},
): Promise<string> {
  assertPositiveInt(number, 'PR 编号');
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_DIFF_BYTES;
  const result = await runGh(deps, ['pr', 'diff', String(number), '--repo', repo], { timeoutMs: 180_000 });
  const bytes = Buffer.byteLength(result.stdout, 'utf8');
  if (bytes > maxBytes) {
    throw new DiffTooLargeError(
      `PR diff 太大（${bytes} 字节，超过上限 ${maxBytes} 字节），不予整体审查`,
      bytes,
      maxBytes,
    );
  }
  return result.stdout;
}

/** PR 会话评论（issue comments）。 */
export interface PrComment {
  id: number;
  author: string;
  body: string;
  createdAt: string;
}

export async function getPrComments(deps: GithubDeps, repo: RepoSlug, number: number): Promise<PrComment[]> {
  assertPositiveInt(number, 'PR 编号');
  const result = await runGh(deps, ['api', `repos/${repo}/issues/${number}/comments`, '--paginate']);
  return parsePaginatedObjects(result.stdout).map((raw) => ({
    id: asNumber(raw.id),
    author: asString(asRecord(raw.user)?.login),
    body: asString(raw.body),
    createdAt: asString(raw.created_at),
  }));
}

/** gh 的 PR JSON（author/labels 是对象）→ PrInfo（author/labels 是字符串）。 */
function toPrInfo(repo: RepoSlug, raw: Record<string, unknown>): PrInfo {
  const number = raw.number;
  if (typeof number !== 'number' || !Number.isInteger(number)) {
    throw new UnexpectedResponseError(`gh 返回的 PR 数据缺少数字型 number 字段：${JSON.stringify(raw).slice(0, 120)}`);
  }
  const headSha = asString(raw.headRefOid);
  if (headSha === '') {
    throw new UnexpectedResponseError(`PR #${number} 的 gh 数据缺少 headRefOid 字段`);
  }
  const labels = Array.isArray(raw.labels)
    ? raw.labels.map((label) => asString(asRecord(label)?.name)).filter((name) => name !== '')
    : [];
  return {
    repo,
    number,
    title: asString(raw.title),
    author: asString(asRecord(raw.author)?.login),
    url: asString(raw.url),
    headSha,
    baseSha: asString(raw.baseRefOid),
    baseRef: asString(raw.baseRefName),
    headRef: asString(raw.headRefName),
    isDraft: asBoolean(raw.isDraft),
    labels,
    state: asString(raw.state),
    updatedAt: asString(raw.updatedAt),
  };
}
