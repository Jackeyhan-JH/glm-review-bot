/**
 * PR 评论里的手动重审命令（#12）：`parseReviewCommands(comments, since, options)`，
 * 供守护进程 #13 在每次轮询后调用（评论列表经 github.getPrComments 取好传入）。
 *
 * 识别仓库 owner 在 PR 会话评论里**单独一行**发出的：
 * - `/glm-review` —— 重审当前 head，忽略去重；
 * - `/glm-review full` —— 同上，并忽略 maxComments 行内评论上限。
 *
 * 防误触发规则（均有测试）：
 * - 只认 owner 发的评论（默认 `Jackeyhan-JH`，可用 options.owners 配置，
 *   例如取仓库 owner，即 repo 标识里 `/` 之前的部分；登录名比较不区分大小写）；
 * - 引用块（`> /glm-review`）与围栏（``` / ~~~）、缩进代码块里的命令行不认；
 * - 每条评论 id 只触发一次：上次的已处理 id 经 options.processedCommentIds 传入，
 *   返回值的 processedCommentIds = 旧集合 ∪ 本次触发的评论 id，供写回状态库。
 *
 * 组装说明（给 #13）：processedCommentIds 与评论时间水位线需要持久化——状态库 v1
 * 已有 meta 键值表，但 src/state 尚无公开读写接口；见本 issue PR 描述里的迁移需求。
 */
import type { PrComment } from '../github/index.ts';

/** 默认只认的命令发布者（仓库 owner 的登录名）。 */
export const DEFAULT_COMMAND_OWNERS: readonly string[] = ['Jackeyhan-JH'];

/** 一条被识别出的重审命令。 */
export interface ReviewCommand {
  /** 触发命令的评论 id（记入状态库，防止重复触发）。 */
  commentId: number;
  author: string;
  /** 评论时间（ISO），命令按此升序返回。 */
  createdAt: string;
  /** true = `/glm-review full`：除忽略去重外，还忽略 maxComments 上限。 */
  full: boolean;
}

export interface ParseCommandsOptions {
  /** 允许发命令的作者登录名；缺省 ['Jackeyhan-JH']。 */
  owners?: readonly string[];
  /** 上次已处理的评论 id（上次返回的 processedCommentIds），这些评论不再触发。 */
  processedCommentIds?: readonly number[];
}

export interface ParsedReviewCommands {
  /** 本次新触发的命令，按评论时间升序。 */
  commands: ReviewCommand[];
  /** 旧的已处理 id ∪ 本次触发的评论 id（升序去重），写回状态库。 */
  processedCommentIds: number[];
}

/** 命令行（整行）：`/glm-review` 或 `/glm-review full`，大小写不敏感。 */
const COMMAND_LINE_RE = /^\/glm-review(?: full)?$/i;

/** 缩进代码块行：Tab，或 ≥ 4 个空格，或 1–3 个空格后接 Tab（Tab 按 4 列展开）。 */
const INDENTED_CODE_RE = /^(?:\t| {4}| {1,3}\t)/;

/** 行首至多 3 个空格 / Tab 之后的内容（Markdown 里这之后才是块级语法起点）。 */
function blockContent(rawLine: string): string {
  return rawLine.replace(/^[ \t]{0,3}/, '');
}

/** 归一化一行（去首尾空白、折叠词间空白）后判断是否命令行；返回命令种类。 */
function commandKind(rawLine: string): 'rerun' | 'full' | null {
  const normalized = rawLine.trim().split(/\s+/).filter(Boolean).join(' ');
  if (!COMMAND_LINE_RE.test(normalized)) return null;
  return normalized.toLowerCase() === '/glm-review full' ? 'full' : 'rerun';
}

/**
 * 扫描评论正文：存在单独一行的命令即算命中（`full` 强于 `rerun`）。
 * 围栏代码块（``` 或 ~~~，未闭合则到文末）、缩进代码块、引用块里的行一律不认。
 */
function scanBody(body: string): 'rerun' | 'full' | null {
  let result: 'rerun' | 'full' | null = null;
  let inFence = false;
  for (const rawLine of body.split('\n')) {
    const content = blockContent(rawLine);
    if (inFence) {
      // 围栏内：只有围栏行结束代码块，其余都是代码内容。
      if (content.startsWith('```') || content.startsWith('~~~')) inFence = false;
      continue;
    }
    if (content.startsWith('```') || content.startsWith('~~~')) {
      inFence = true;
      continue;
    }
    if (INDENTED_CODE_RE.test(rawLine) || content.startsWith('>')) continue;
    const kind = commandKind(rawLine);
    if (kind === 'full') return 'full';
    if (kind === 'rerun' && result === null) result = 'rerun';
  }
  return result;
}

/** string | Date → 毫秒时间戳；缺省或解析失败（NaN）返回 undefined，调用方按不过滤处理。 */
function toMillis(value: string | Date | undefined): number | undefined {
  if (value === undefined) return undefined;
  const ms = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isNaN(ms) ? undefined : ms;
}

function compareByCreatedAt(a: PrComment, b: PrComment): number {
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
  return a.id - b.id;
}

/**
 * 从 PR 会话评论里解析手动重审命令：
 * - `since` 是评论时间水位线（上次处理到的时刻），早于它的评论直接跳过，
 *   避免每轮全量扫描；精确去重仍以 processedCommentIds 为准（状态库丢失水位线时兜底）；
 * - 非 owner 评论与已处理过的评论不触发；
 * - 返回新触发的命令与合并后的已处理评论 id 集合。
 */
export function parseReviewCommands(
  comments: readonly PrComment[],
  since?: string | Date,
  options: ParseCommandsOptions = {},
): ParsedReviewCommands {
  const owners = new Set((options.owners ?? DEFAULT_COMMAND_OWNERS).map((login) => login.toLowerCase()));
  const processed = new Set(options.processedCommentIds ?? []);
  const sinceMs = toMillis(since);
  const commands: ReviewCommand[] = [];
  for (const comment of [...comments].sort(compareByCreatedAt)) {
    const createdMs = toMillis(comment.createdAt);
    if (sinceMs !== undefined && createdMs !== undefined && createdMs < sinceMs) continue;
    if (!owners.has(comment.author.toLowerCase())) continue;
    if (processed.has(comment.id)) continue;
    const kind = scanBody(comment.body);
    if (kind === null) continue;
    commands.push({
      commentId: comment.id,
      author: comment.author,
      createdAt: comment.createdAt,
      full: kind === 'full',
    });
    processed.add(comment.id);
  }
  return { commands, processedCommentIds: [...processed].sort((a, b) => a - b) };
}
