/**
 * 单 PR 审查流水线（#11，#1「数据流」的第一个端到端实现）：
 *
 *     getPr → 去重（状态库 / PR 标记）→ 高峰闸门 / 并发闸门 → 仓库配置（默认分支）
 *   → getDiff → parseDiff → filterFiles → changedLines → pickModel → chunkDiff
 *   → ensureCheckout → 每块 buildPrompt → runClaude（只读检出，就地重试）→ normalizeFindings
 *   → mergeChunkReviews → applyThreshold → buildReview → publishReview → markDone
 *
 * 结果用 ReviewOutcome 联合类型表达（不抛「业务异常」）：superseded / already-reviewed /
 * deferred / waiting / skipped / failed / reviewed 都是一次正常收尾，命令层据此排版；
 * gh / git / 配置加载等基础设施错误仍然抛出，由调用方（CLI / #13 守护进程）兜底。
 *
 * 状态库由调用方打开并经 deps.state 注入（命令层负责生命周期）；任务行在 getPr 与
 * superseded 检查之后创建（同键去重，已存在则复用），之后所有状态变更（defer /
 * markSkipped / markFailed / markDone）都落在这行上。每次 claude 调用（含失败与
 * 就地重试的每一次）都写 calls 表。
 */
import { loadGlobalConfig, type GlobalConfig } from '../config/global.ts';
import { isIgnoredByRepoConfig, loadRepoConfig, type RepoConfigResult } from '../config/repo.ts';
import { changedLines, chunkDiff } from '../diff/chunk.ts';
import { filterFiles } from '../diff/filter.ts';
import { parseDiff } from '../diff/parse.ts';
import { renderFileSlice, type FileSlice } from '../diff/render.ts';
import type { DiffFile } from '../diff/types.ts';
import { mergeChunkReviews, applyThreshold, type ChunkReview } from '../findings/merge.ts';
import { buildPrompt, loadPromptTemplate, truncatePrBody } from '../findings/prompt.ts';
import { REVIEW_JSON_SCHEMA } from '../findings/schema.ts';
import { normalizeFindings } from '../findings/validate.ts';
import {
  asString,
  ensureCheckout,
  findBotMarker,
  getDiff,
  getPr,
  listReviews,
  parseRepoSlug,
  parseSingleObject,
  runGh,
  type GithubDeps,
} from '../github/index.ts';
import { checkGate } from '../llm/gate.ts';
import { runClaude, type ClaudeCallRecord } from '../llm/claude.ts';
import { pickModel } from '../llm/model.ts';
import { withRetry, type RetryOptions } from '../llm/retry.ts';
import type { PrInfo, RepoSlug } from '../lib/types.ts';
import type { ExecFn } from '../lib/exec.ts';
import type { Logger } from '../lib/log.ts';
import type { Paths } from '../lib/paths.ts';
import { buildReview } from '../publish/build.ts';
import { publishReview } from '../publish/post.ts';
import { recordCall } from '../state/calls.ts';
import type { StateDb } from '../state/db.ts';
import { defer, enqueue, isReviewed, markDone, markFailed, markSkipped } from '../state/jobs.ts';
import { deferUntil, isPeak } from '../peak/peak.ts';

/** reviewPr 的输入（与 issue #11 约定一致）。 */
export interface ReviewPrInput {
  repo: RepoSlug;
  pr: number;
  /** 期望的 head SHA；与当前 head 不同 → superseded（守护进程防止审到旧提交）。 */
  headSha?: string;
  /** 跳过去重检查（状态库与 PR 标记都不看，直接重审）。 */
  force?: boolean;
  /** 只预览将要发布的 review，不发送；也不把任务标记为 done。 */
  dryRun?: boolean;
}

/** 流水线依赖，全部可注入（测试用 fakebin / 假时钟 / 内存状态库替换）。 */
export interface ReviewPipelineDeps extends GithubDeps {
  log: Logger;
  /** 状态库句柄（调用方负责打开与关闭）。 */
  state: StateDb;
  /** 全局配置；缺省从 paths.configFile 加载。 */
  config?: GlobalConfig;
  /** dry-run 预览输出（CLI 里传 ctx.stdout）；缺省走进程 stdout。 */
  out?: (text: string) => void;
  /** 阶段进度输出（各阶段开始时调用一次，中文一句话）。 */
  progress?: (text: string) => void;
  /** 单块 claude 失败的就地重试参数（默认试 2 次、不等待）。 */
  chunkRetry?: RetryOptions;
}

/** 跳过原因（任务行 reason 字段同值）。 */
export type SkipReason = 'disabled' | 'no-reviewable-changes';

/** 一次 reviewPr 的结果；除 failed 外都算正常收尾。 */
export type ReviewOutcome =
  | {
      status: 'reviewed';
      /** true = dry-run 预览，未发送任何内容。 */
      dryRun: boolean;
      /** 发布成功的 review 地址；dry-run 时缺省。 */
      url?: string;
      /** true = 发生了 422 降级（行内评论并入总评）。 */
      degraded: boolean;
      /** 发布的问题数（行内 + 并入总评，不含低于阈值的）。 */
      findingsCount: number;
      model: string;
      chunks: number;
      durationMs: number;
      jobId: number;
    }
  | { status: 'already-reviewed'; source: 'state' | 'marker'; jobId: number }
  | { status: 'superseded'; expected: string; current: string }
  | { status: 'deferred'; until: string; jobId: number }
  | { status: 'waiting'; reason: 'paused' | 'box-busy' | 'self-busy'; detail: string; jobId: number }
  | { status: 'skipped'; reason: SkipReason; jobId: number }
  | { status: 'failed'; error: string; requeued: boolean; jobId: number };

/** 阶段进度的中文标签（progress 回调与结构化日志共用）。 */
const STAGE_LABEL: Record<string, string> = {
  getPr: '获取 PR 信息',
  dedupe: '检查是否已审过',
  gate: '高峰期与并发闸门检查',
  repoConfig: '加载仓库配置（默认分支）',
  diff: '获取并解析 diff',
  checkout: '准备只读检出',
  publish: '组装并发布 review',
};

/** 单块审查的文件切片 → DiffFile（行号修正只针对本块实际送审的 hunk）。 */
function sliceToDiffFile(slice: FileSlice): DiffFile {
  return {
    path: slice.path,
    oldPath: slice.oldPath,
    status: slice.status,
    binary: slice.binary,
    hunks: slice.hunks,
    additions: slice.additions,
    deletions: slice.deletions,
  };
}

/** 提示词里的「涉及文件」清单：`- 路径（状态，+a 行 -d 行）`。 */
function renderFilesVar(parts: FileSlice[]): string {
  return parts.map((part) => `- ${part.path}${renderFileSlice(part)[1]}`).join('\n');
}

/** 模型输出里的 summary（非字符串或缺省 → undefined，合并时跳过）。 */
function summaryOf(raw: unknown): string | undefined {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const summary = (raw as Record<string, unknown>).summary;
  return typeof summary === 'string' && summary.trim() !== '' ? summary : undefined;
}

/** 取 PR 描述（getPr 的字段集不含 body，单独取一次）；失败不阻断审查，降级为空描述。 */
async function fetchPrBody(deps: GithubDeps, repo: RepoSlug, number: number, log: Logger): Promise<string> {
  try {
    const result = await runGh(deps, ['pr', 'view', String(number), '--repo', repo, '--json', 'body']);
    return asString(parseSingleObject(result.stdout, 'gh pr view --json body 输出').body);
  } catch (err) {
    log.warn('获取 PR 描述失败，按空描述继续审查', { repo, pr: number, err: String(err) });
    return '';
  }
}

/**
 * 审一个 PR。步骤与阶段见模块注释；除标注的返回点外，每个阶段开始时回调一次
 * progress、结束时写一条结构化日志（任务 id、仓库、PR、sha、阶段、耗时）。
 */
export async function reviewPr(input: ReviewPrInput, deps: ReviewPipelineDeps): Promise<ReviewOutcome> {
  const config = deps.config ?? loadGlobalConfig(deps.paths.configFile, { log: deps.log });
  const { state, log } = deps;
  const now = (): Date => deps.clock.now();

  /** 阶段包装：进度回调 + 结构化日志（base 里的字段逐阶段补全）。 */
  const stage = <T>(name: string, base: Record<string, unknown>, fn: () => Promise<T>): Promise<T> => {
    const label = STAGE_LABEL[name] ?? name;
    deps.progress?.(label);
    const startMs = now().getTime();
    return fn().finally(() => {
      log.info('审查阶段完成', { ...base, stage: name, ms: now().getTime() - startMs });
    });
  };

  parseRepoSlug(input.repo);

  // 1. PR 元信息；期望 head 与当前不同 → superseded（不碰任务队列）。
  const pr: PrInfo = await stage('getPr', { repo: input.repo, pr: input.pr }, () =>
    getPr(deps, input.repo, input.pr),
  );
  const base = { repo: input.repo, pr: input.pr, sha: pr.headSha };
  if (input.headSha !== undefined && input.headSha.toLowerCase() !== pr.headSha.toLowerCase()) {
    log.info('head 已变化，本次审查取消', { ...base, expected: input.headSha });
    return { status: 'superseded', expected: input.headSha, current: pr.headSha };
  }

  // 任务行：同键（repo, pr, head_sha）只此一行，之后的状态变更都在它上面。
  const { job } = enqueue(state, { repo: input.repo, pr: input.pr, headSha: pr.headSha, now: now() });
  const jobBase = { ...base, jobId: job.id };

  // 2. 去重：状态库已审过 / PR 上已有本 SHA 的标记 → already-reviewed（--force 跳过）。
  if (!input.force) {
    if (isReviewed(state, input.repo, input.pr, pr.headSha)) {
      deps.progress?.('该 commit 已审过（状态库记录），跳过');
      log.info('状态库显示已审过，跳过', jobBase);
      return { status: 'already-reviewed', source: 'state', jobId: job.id };
    }
    const marked = await stage('dedupe', jobBase, async () => {
      const reviews = await listReviews(deps, input.repo, input.pr);
      return findBotMarker(reviews, pr.headSha) !== undefined;
    });
    if (marked) {
      // 状态库丢失时按 PR 上的标记恢复去重键，之后的判断走状态库。
      markSkipped(state, job.id, 'already-reviewed', now());
      deps.progress?.('该 commit 已审过（PR 上的标记），跳过');
      log.info('PR 上已有本 SHA 的审查标记，跳过并恢复去重键', jobBase);
      return { status: 'already-reviewed', source: 'marker', jobId: job.id };
    }
  }

  // 3a. 高峰期：不调用 GLM，任务排队到本段高峰结束（not_before = 峰后时刻）。
  if (config.peak.enabled) {
    const until = deferUntil(now());
    if (until !== null) {
      const deferred = defer(state, job.id, until, 'peak', now());
      log.info('高峰期，任务已排队到峰后', { ...jobBase, notBefore: deferred.notBefore });
      deps.progress?.('高峰期，任务已排队到峰后');
      return { status: 'deferred', until: deferred.notBefore, jobId: job.id };
    }
  }

  // 3b. 启动前闸门（暂停文件 / 本机进程数 / 自身并发）；不通过 → waiting，任务保持排队。
  const gate = await stage('gate', jobBase, () => {
    // pgrep 不接受 env 注入，这里包一层让测试的 fakebin PATH 生效（生产行为不变）。
    const gateExec: ExecFn = (cmd, args, options = {}) => deps.exec(cmd, args, { ...options, env: deps.env });
    return checkGate(
      {
        pauseFile: config.pauseFile,
        boxClaudeLimit: config.boxClaudeLimit,
        maxConcurrent: config.maxConcurrent,
        mineRunning: 0,
      },
      { exec: gateExec },
    );
  });
  if (!gate.ok) {
    log.warn('闸门未通过，任务保持排队', { ...jobBase, reason: gate.reason, detail: gate.detail });
    deps.progress?.(`闸门未通过（${gate.reason}），任务保持排队`);
    return { status: 'waiting', reason: gate.reason, detail: gate.detail, jobId: job.id };
  }

  // 4. 仓库配置（默认分支的 .glm-review.yml；404 = 缺省配置）。
  const repoConfig: RepoConfigResult = await stage('repoConfig', jobBase, () =>
    loadRepoConfig(input.repo, { exec: deps.exec, env: deps.env }),
  );
  if (!repoConfig.config.enabled) {
    const skipped = markSkipped(state, job.id, 'disabled', now());
    log.info('仓库配置 enabled: false，跳过审查', jobBase);
    return { status: 'skipped', reason: 'disabled', jobId: skipped.id };
  }

  // 5. diff → 解析 → 过滤 → 模型选择 → 分块；过滤后为空 → skipped（不发评论）。
  const { kept, ignored } = await stage('diff', jobBase, async () => {
    const diffText = await getDiff(deps, input.repo, input.pr);
    const filtered = filterFiles(parseDiff(diffText), (p) => isIgnoredByRepoConfig(p, repoConfig.config));
    return filtered;
  });
  if (kept.length === 0) {
    const skipped = markSkipped(state, job.id, 'no-reviewable-changes', now());
    log.info('过滤后没有可审查的改动，跳过审查', { ...jobBase, ignored: ignored.length });
    return { status: 'skipped', reason: 'no-reviewable-changes', jobId: skipped.id };
  }
  const model = pickModel(changedLines(kept), config.models);
  const plan = chunkDiff(kept, {
    maxChunkLines: config.claude.maxChunkLines,
    maxChunks: config.claude.maxChunksPerReview,
  });
  log.info('diff 解析与分块完成', {
    ...jobBase,
    files: kept.length,
    ignoredFiles: ignored.length,
    changedLines: changedLines(kept),
    model,
    chunks: plan.chunks.length,
    truncatedFiles: plan.truncated.length,
  });

  // 6. 只读检出 + 逐块审查（失败就地重试，仍失败 → 整个任务失败，不发半截 review）。
  const checkoutDir = await stage('checkout', jobBase, () => ensureCheckout(deps, input.repo, pr.headSha));
  const prBody = truncatePrBody(await fetchPrBody(deps, input.repo, input.pr, log));
  const template = loadPromptTemplate(repoConfig.config.language);
  const ignoredPaths = ignored.map((file) => file.path);
  const chunkReviews: ChunkReview[] = [];
  const llmStartMs = now().getTime();
  for (const [index, chunk] of plan.chunks.entries()) {
    const chunkNo = index + 1;
    deps.progress?.(`调用模型审查（第 ${chunkNo}/${plan.chunks.length} 块）`);
    const chunkFiles = chunk.parts.map(sliceToDiffFile);
    const prompt = buildPrompt(template, {
      repo: input.repo,
      prTitle: pr.title,
      prBody,
      focus: repoConfig.config.focus ?? '',
      chunkIndex: String(chunkNo),
      chunkTotal: String(plan.chunks.length),
      files: renderFilesVar(chunk.parts),
      diff: chunk.text,
    });
    const result = await withRetry(
      () => {
        const startedAt = now();
        const onCall = (record: ClaudeCallRecord): void => {
          recordCall(state, {
            jobId: job.id,
            chunkIndex: index,
            model: record.model,
            startedAt,
            durationMs: record.durationMs,
            exitCode: record.exitCode,
            ok: record.ok,
            inputTokens: record.usage?.inputTokens ?? null,
            outputTokens: record.usage?.outputTokens ?? null,
            costUsd: record.usage?.totalCostUsd ?? null,
            peak: config.peak.enabled && isPeak(startedAt),
            error: record.error ?? null,
          });
        };
        return runClaude(
          {
            prompt,
            cwd: checkoutDir,
            model,
            effort: config.claude.effort,
            // schema.ts 导出的 schema 本身已不带 $schema 元键（#31：claude 的
            // --json-schema 校验器拒绝元 schema URI），无需再在调用边界剥离。
            jsonSchema: REVIEW_JSON_SCHEMA,
            timeoutMs: config.claude.timeoutSec * 1000,
          },
          { exec: deps.exec, env: deps.env, onCall },
        );
      },
      deps.chunkRetry,
    );
    if (!result.ok) {
      const error = result.error ?? 'claude 调用失败';
      const failed = markFailed(state, job.id, error, {
        now: now(),
        retry: { maxAttempts: config.retry.maxAttempts, backoffSeconds: config.retry.backoffSec },
      });
      log.error('块审查失败，任务按重试策略处理', { ...jobBase, chunk: chunkNo, err: error, status: failed.status });
      return { status: 'failed', error, requeued: failed.status === 'queued', jobId: failed.id };
    }
    const normalized = normalizeFindings(result.output, chunkFiles, { ignoredPaths });
    if (normalized.dropped.length > 0) {
      log.warn('块输出有被丢弃的发现', {
        ...jobBase,
        chunk: chunkNo,
        dropped: normalized.dropped.map((d) => d.reason),
      });
    }
    chunkReviews.push({ summary: summaryOf(result.output), findings: normalized.findings });
    log.info('块审查完成', {
      ...jobBase,
      chunk: chunkNo,
      ms: now().getTime() - llmStartMs,
      findings: normalized.findings.length,
    });
  }
  const durationMs = now().getTime() - llmStartMs;

  // 7. 合并 → 阈值 → 组装 → 发布（dry-run 只预览；422 降级由 #10 处理）。
  const merged = mergeChunkReviews(chunkReviews);
  const threshold = applyThreshold(merged.findings, repoConfig.config.minSeverity, repoConfig.config.maxComments);
  const review = buildReview({
    pr,
    headSha: pr.headSha,
    inline: threshold.inline,
    overflow: threshold.overflow,
    belowThreshold: threshold.belowThreshold,
    meta: {
      model,
      chunks: plan.chunks.length,
      durationMs,
      summary: merged.summary,
      ignoredFiles: ignored,
      truncatedFiles: plan.truncated,
      configErrors: repoConfig.errors,
    },
    lang: repoConfig.config.language,
  });
  const published = await stage('publish', jobBase, () =>
    publishReview(review, { ...deps, out: deps.out }, { repo: input.repo, number: input.pr, dryRun: input.dryRun }),
  );
  const findingsCount = threshold.inline.length + threshold.overflow.length;

  // 8. 收尾记账（dry-run 不标记 done：预览不该占用「审过」去重键）。
  if (input.dryRun) {
    log.info('dry-run 预览完成，未发送 review、未标记 done', { ...jobBase, findingsCount, model });
  } else {
    const done = markDone(state, job.id, {
      now: now(),
      reviewUrl: published.url,
      findingsCount,
      model,
    });
    log.info('审查完成', {
      ...jobBase,
      url: done.reviewUrl,
      findingsCount,
      model,
      degraded: published.degraded,
    });
  }
  return {
    status: 'reviewed',
    dryRun: input.dryRun === true,
    ...(published.url !== undefined ? { url: published.url } : {}),
    degraded: published.degraded,
    findingsCount,
    model,
    chunks: plan.chunks.length,
    durationMs,
    jobId: job.id,
  };
}
