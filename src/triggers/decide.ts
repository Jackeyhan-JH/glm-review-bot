/**
 * 触发判定（#12）：`decide(pr, repoConfig, state)` 决定轮询到的 PR 当前 head
 * 该「入队（enqueue）/ 跳过（skip）/ 忽略（ignore）」，供守护进程 #13 调用。
 *
 * 纯函数约定：不调 exec、不读写状态库——同键既有任务的信息由调用方从状态库
 * 查好，放进 `state.existingJob` 传入，本模块只做规则判断。
 *
 * reason 短码（入状态库 reason 字段，状态页可另映射中文；detail 是即取即用的中文说明）：
 * - ignore：`merged` / `closed`（PR 已合并 / 已关闭）、`duplicate`（同键已有任务）；
 * - skip：`draft` / `disabled` / `label:<标签名>` / `author:<登录名>` / `title`；
 * - enqueue：`new`（新 head）、`ready`（草稿转正后重新入队）、`manual`（/glm-review 手动重审）。
 */
import type { RepoConfig } from '../config/repo.ts';
import type { JobStatus, PrInfo } from '../lib/types.ts';

export type TriggerAction = 'enqueue' | 'skip' | 'ignore';

/** 草稿跳过的 reason 短码：skipped(draft) 不算「已审」，转正后同一 sha 可重新入队。 */
export const SKIP_REASON_DRAFT = 'draft';
export const SKIP_REASON_DISABLED = 'disabled';
export const SKIP_REASON_LABEL = 'label';
export const SKIP_REASON_AUTHOR = 'author';
export const SKIP_REASON_TITLE = 'title';

/** 与状态库里同键 (repo, pr, headSha) 既有任务对照所需的最小信息。 */
export interface ExistingJobSummary {
  status: JobStatus;
  reason: string | null;
}

/** decide 需要的触发上下文，由调用方（守护进程）组装传入。 */
export interface TriggerState {
  /** 该 (repo, pr, headSha) 已有的任务（任意状态）；没有则 null / 缺省。 */
  existingJob?: ExistingJobSummary | null;
  /**
   * true = `/glm-review` 手动重审：忽略去重与各跳过规则（已关闭 / 合并的 PR 仍忽略）。
   * 仓库 owner 明确下达的命令是最强信号，优先于一切自动规则；跳过规则命中的历史
   * 记录由调用方按需要重置（见 PR 描述给 #13 的组装说明）。
   */
  force?: boolean;
}

export interface TriggerDecision {
  action: TriggerAction;
  /** 机器可读短码，写状态库 reason 字段。 */
  reason: string;
  /** 中文说明（日志与状态页显示）。 */
  detail: string;
}

/**
 * 标题跳过标记：`[skip review]` / `[no review]`，大小写不敏感；中英文方括号
 * （`[]` / `【】`）均可，可混用（如 `[skip review】`），标记内允许任意空白。
 */
const TITLE_SKIP_MARKER = /[[【]\s*(?:skip\s+review|no\s+review)\s*[\]】]/i;

/** 既有任务是否是「草稿跳过」且 PR 已转正——这种记录不算已审，同一 sha 需要能重新审。 */
function isRequeueableDraftSkip(existing: ExistingJobSummary, pr: PrInfo): boolean {
  return existing.status === 'skipped' && existing.reason === SKIP_REASON_DRAFT && !pr.isDraft;
}

/**
 * 判定规则（按序短路）：
 * 1. 已合并 / 已关闭 → ignore（gh 的 state 为 MERGED / CLOSED 等，只有 OPEN 继续往下）；
 * 2. `force`（/glm-review 手动重审）→ enqueue，忽略去重与跳过规则；
 * 3. 同 (repo, pr, headSha) 已有任务 → ignore；唯一例外是「只有 skipped(draft) 记录
 *    且 PR 已转正」——继续走跳过规则，通常落到 enqueue（草稿 → 转正后重新入队）；
 * 4. 仓库配置 `enabled: false` → skip；
 * 5. 草稿 PR 且 `skipDrafts` → skip（reason 固定为 `draft`，配合上面的例外）；
 * 6. 带 `skipLabels` 中的标签（默认 `no-review`，比较不区分大小写）→ skip；
 * 7. 作者在 `skipAuthors`（登录名比较不区分大小写）→ skip；
 * 8. 标题含跳过标记（见 TITLE_SKIP_MARKER）→ skip；
 * 9. 其余 → enqueue。
 */
export function decide(pr: PrInfo, repoConfig: RepoConfig, state: TriggerState = {}): TriggerDecision {
  const prState = pr.state.toUpperCase();
  if (prState === 'MERGED') {
    return { action: 'ignore', reason: 'merged', detail: 'PR 已合并，不再审查' };
  }
  if (prState !== 'OPEN') {
    return { action: 'ignore', reason: 'closed', detail: 'PR 已关闭，不再审查' };
  }

  if (state.force === true) {
    return { action: 'enqueue', reason: 'manual', detail: '/glm-review 手动重审：忽略去重与跳过规则' };
  }

  const existing = state.existingJob ?? null;
  if (existing !== null && !isRequeueableDraftSkip(existing, pr)) {
    return {
      action: 'ignore',
      reason: 'duplicate',
      detail: `该 (repo, pr, headSha) 已有任务（status=${existing.status}）`,
    };
  }

  if (!repoConfig.enabled) {
    return { action: 'skip', reason: SKIP_REASON_DISABLED, detail: '仓库配置 enabled: false，审查关闭' };
  }
  if (pr.isDraft && repoConfig.skipDrafts) {
    return { action: 'skip', reason: SKIP_REASON_DRAFT, detail: '草稿 PR（skipDrafts: true）' };
  }
  const label = pr.labels.find((name) =>
    repoConfig.skipLabels.some((configured) => configured.toLowerCase() === name.toLowerCase()),
  );
  if (label !== undefined) {
    return { action: 'skip', reason: `${SKIP_REASON_LABEL}:${label}`, detail: `带跳过标签 ${label}` };
  }
  if (repoConfig.skipAuthors.some((login) => login.toLowerCase() === pr.author.toLowerCase())) {
    return {
      action: 'skip',
      reason: `${SKIP_REASON_AUTHOR}:${pr.author}`,
      detail: `作者 ${pr.author} 在 skipAuthors 名单`,
    };
  }
  if (TITLE_SKIP_MARKER.test(pr.title)) {
    return {
      action: 'skip',
      reason: SKIP_REASON_TITLE,
      detail: '标题带 [skip review] / [no review] 标记',
    };
  }

  if (existing !== null) {
    // 能走到这里说明既有任务是 skipped(draft) 且 PR 已转正：不算已审，重新入队。
    return { action: 'enqueue', reason: 'ready', detail: '草稿转正后重新入队（skipped(draft) 不算已审）' };
  }
  return { action: 'enqueue', reason: 'new', detail: '新 PR / 新 head，入队审查' };
}
