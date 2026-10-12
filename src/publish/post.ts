/**
 * 发布 review（#10）：dry-run 预览（不发任何请求）与正式发布（含 422 降级）。
 *
 * - dry-run：把将要发送的 JSON 载荷与 Markdown 预览写到 stdout（`deps.out`，
 *   通常是 `ctx.stdout`）和/或 `previewDir` 下的 `review-preview.json` /
 *   `review-preview.md`，完全不调用 `gh`；
 * - 正式发布：走 #6 的 `postReview`（`event` 恒为 COMMENT）。遇
 *   `ReviewRejectedError`（HTTP 422，常见于行号不在最新 diff 中）时降级重试
 *   一次：全部行内评论并入总评，只发总评。再失败就把错误抛给调用方（#11）。
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ReviewRejectedError } from '../github/errors.ts';
import { postReview } from '../github/reviews.ts';
import type { GithubDeps } from '../github/run.ts';
import type { RepoSlug } from '../lib/types.ts';
import { commentLocation, degradeBody, fenceOf } from './format.ts';
import type { BuiltReview } from './types.ts';

/** 发布依赖：#6 的依赖集合 + dry-run 预览输出函数。 */
export interface PublishDeps extends GithubDeps {
  /** dry-run 预览输出；缺省 `process.stdout.write`（CLI 里应传 `ctx.stdout`）。 */
  out?: (text: string) => void;
}

export interface PublishOptions {
  repo: RepoSlug;
  number: number;
  /** true = 只预览不发送。 */
  dryRun?: boolean;
  /** dry-run 预览额外写入的目录（不存在会创建），生成两个文件。 */
  previewDir?: string;
}

export interface PublishResult {
  /** true = dry-run，没有发送任何内容。 */
  dryRun: boolean;
  /** true = 发生了 422 降级（行内评论已并入总评）。 */
  degraded: boolean;
  /** 发布成功的 review 地址；dry-run 时缺省。 */
  url?: string;
  /** dry-run 时的预览内容（JSON 载荷 + Markdown）。 */
  preview?: DryRunPreview;
}

/** dry-run 预览：将要发给 `gh api --method POST` 的 JSON 与人读的 Markdown。 */
export interface DryRunPreview {
  json: string;
  markdown: string;
}

/**
 * 组装 `gh api` 的载荷（snake_case）。与 #6 `postReview` 内部的映射保持一致
 * （side 统一 RIGHT、单行评论不带 start_line），dry-run 预览与实际发送共用，
 * 保证「预览即所发」。
 */
export function buildPayload(review: BuiltReview): Record<string, unknown> {
  return {
    commit_id: review.commitId,
    body: review.body,
    event: 'COMMENT',
    comments: review.comments.map((comment) => {
      const api: Record<string, unknown> = {
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
    }),
  };
}

function renderPreviewMarkdown(review: BuiltReview, repo: RepoSlug, number: number): string {
  const zh = review.lang === 'zh';
  const lines: string[] = [
    zh ? '> 🧪 dry-run 预览：以下内容不会发送到 GitHub。' : '> 🧪 dry-run preview: nothing below is sent to GitHub.',
    '',
    zh ? `# 总评（${repo}#${number}）` : `# Summary (${repo}#${number})`,
    '',
    review.body,
  ];
  const total = review.comments.length;
  review.comments.forEach((comment, index) => {
    const label = zh
      ? `# 行内评论 ${index + 1}/${total} · ${commentLocation(comment)}`
      : `# Inline comment ${index + 1}/${total} · ${commentLocation(comment)}`;
    lines.push('', '---', '', label, '', comment.body);
  });
  lines.push('');
  return lines.join('\n');
}

function buildPreview(review: BuiltReview, repo: RepoSlug, number: number): DryRunPreview {
  const json = `${JSON.stringify(buildPayload(review), null, 2)}\n`;
  return { json, markdown: renderPreviewMarkdown(review, repo, number) };
}

/** dry-run 输出：Markdown 预览先走，JSON 载荷附在末尾；previewDir 另存整文件。 */
async function writePreview(
  preview: DryRunPreview,
  deps: PublishDeps,
  lang: BuiltReview['lang'],
  previewDir: string | undefined,
): Promise<void> {
  const out = deps.out ?? ((text: string) => process.stdout.write(text));
  const fence = fenceOf(preview.json);
  const note = lang === 'zh' ? '将要发送的 JSON 载荷：' : 'JSON payload to be sent:';
  out(`${preview.markdown}---\n\n${note}\n\n${fence}json\n${preview.json.trimEnd()}\n${fence}\n`);
  if (previewDir !== undefined) {
    await mkdir(previewDir, { recursive: true });
    await writeFile(path.join(previewDir, 'review-preview.md'), preview.markdown, 'utf8');
    await writeFile(path.join(previewDir, 'review-preview.json'), preview.json, 'utf8');
  }
}

/** 发布（或 dry-run 预览）一条组装好的 review。 */
export async function publishReview(
  review: BuiltReview,
  deps: PublishDeps,
  options: PublishOptions,
): Promise<PublishResult> {
  const { repo, number, dryRun = false, previewDir } = options;
  if (dryRun) {
    const preview = buildPreview(review, repo, number);
    await writePreview(preview, deps, review.lang, previewDir);
    return { dryRun: true, degraded: false, preview };
  }

  try {
    const url = await postReview(deps, repo, number, {
      commitId: review.commitId,
      body: review.body,
      comments: review.comments,
    });
    return { dryRun: false, degraded: false, url };
  } catch (err) {
    if (!(err instanceof ReviewRejectedError)) throw err;
    deps.log?.warn('review 被 GitHub 拒绝（HTTP 422），降级为只发总评', {
      repo,
      number,
      commit: review.commitId,
      inlineComments: review.comments.length,
      details: err.details,
    });
    const url = await postReview(deps, repo, number, {
      commitId: review.commitId,
      body: degradeBody(review.body, review.comments, review.lang),
      comments: [],
    });
    return { dryRun: false, degraded: true, url };
  }
}
