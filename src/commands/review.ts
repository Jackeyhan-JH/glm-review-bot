/**
 * `glm-review review`（#11）：手动审查一个 PR——完整流水线的命令入口。
 *
 * glm-review review <owner/repo> <pr> [--dry-run] [--force] [--json]
 *
 * - 不在白名单的仓库直接报错（退出码 2，--force 也不放行）；
 * - 各阶段进度逐行输出（--json 时进度走 stderr，stdout 只留结果那一行 JSON）；
 * - 结果（review 链接 / 跳过原因 / 排队时间）中文输出；审查失败退出码 1。
 */
import { mkdirSync } from 'node:fs';
import { loadGlobalConfig } from '../config/global.ts';
import { ArgError, parseArgs } from '../lib/args.ts';
import type { CliContext, Command } from '../lib/types.ts';
import { reviewPr, type ReviewOutcome } from '../pipeline/review.ts';
import { openState } from '../state/db.ts';

const USAGE = [
  '用法：glm-review review <owner/repo> <pr> [--dry-run] [--force] [--json]',
  '  手动审查一个 PR：去重 / 高峰与闸门 / diff 过滤分块 / 模型审查 / 发布 review。',
  '  --dry-run   只预览将要发布的 review（含 JSON 载荷），不发送',
  '  --force     跳过去重检查（同一 commit 已审过也重审）',
  '  --json      结果以一行 JSON 输出到 stdout（阶段进度走 stderr）',
].join('\n');

/** 毫秒 → 中文时长（复用各命令的口径：<60s 用秒，再往上用分秒）。 */
function formatDuration(ms: number): string {
  const totalSeconds = Math.round(Math.max(0, ms) / 1000);
  if (totalSeconds < 60) return `${totalSeconds} 秒`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return seconds === 0 ? `${minutes} 分` : `${minutes} 分 ${seconds} 秒`;
}

/** 按指定时区格式化时刻（北京时间 / 美东时间双时区展示用）。 */
function formatInZone(iso: string, timeZone: string, label: string): string {
  const text = new Intl.DateTimeFormat('zh-CN', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(new Date(iso));
  return `${text}（${label}）`;
}

const SKIP_LABEL: Record<string, string> = {
  disabled: '仓库配置 .glm-review.yml 设为 enabled: false，未审查',
  'no-reviewable-changes': '过滤后没有可审查的改动（全部被忽略规则 / 生成文件等排除），未发布评论',
};

/** 结果 → 中文文案（一行到几行；退出码由调用处决定）。 */
function renderOutcome(outcome: ReviewOutcome): string {
  switch (outcome.status) {
    case 'reviewed':
      if (outcome.dryRun) {
        return (
          `dry-run 预览完成（未发送任何内容）：${outcome.findingsCount} 条问题，` +
          `模型 ${outcome.model}，分块 ${outcome.chunks}，耗时 ${formatDuration(outcome.durationMs)}。`
        );
      }
      return (
        `审查完成：${outcome.url}\n${outcome.findingsCount} 条问题，模型 ${outcome.model}，` +
        `分块 ${outcome.chunks}，耗时 ${formatDuration(outcome.durationMs)}。` +
        (outcome.degraded ? '\n注意：GitHub 拒绝了行内评论（HTTP 422），已降级为只发总评。' : '')
      );
    case 'already-reviewed':
      return outcome.source === 'state'
        ? '该 commit 已审过（状态库记录），本次跳过。'
        : '该 commit 已审过（PR 上已有 glm-review-bot 标记），本次跳过。';
    case 'superseded':
      return `PR head 已变化（预期 ${outcome.expected.slice(0, 7)}，当前 ${outcome.current.slice(0, 7)}），本次审查取消。`;
    case 'deferred':
      return (
        `高峰期（工作日北京时间 14:00–18:00）不调用 GLM，已排队到：` +
        `${formatInZone(outcome.until, 'Asia/Shanghai', '北京时间')} / ` +
        `${formatInZone(outcome.until, 'America/New_York', '美东时间')}。`
      );
    case 'waiting':
      return `暂不启动审查：${outcome.detail}（任务 ${outcome.jobId} 保持排队，稍后会自动重试）。`;
    case 'skipped':
      return SKIP_LABEL[outcome.reason] ?? `已跳过（${outcome.reason}）。`;
    case 'failed':
      return outcome.requeued
        ? `审查失败：${outcome.error}\n任务 ${outcome.jobId} 已按重试策略回到队列（峰后由守护进程重试，或稍后重新运行本命令）。`
        : `审查失败：${outcome.error}\n任务 ${outcome.jobId} 已达重试上限，标记为 failed。`;
  }
}

export const command: Command = {
  name: 'review',
  summary: '手动审查一个 PR：完整流水线（去重/高峰/分块/模型审查/发布）',
  usage: USAGE,
  async run(argv, ctx): Promise<number> {
    let parsed: ReturnType<typeof parseArgs>;
    try {
      parsed = parseArgs(argv, { strings: [], booleans: ['dry-run', 'force', 'json'] });
    } catch (err) {
      if (err instanceof ArgError) {
        ctx.stderr(`错误：${err.message}\n${USAGE}\n`);
        return 2;
      }
      throw err;
    }

    const fail = (message: string): number => {
      ctx.stderr(`错误：${message}\n${USAGE}\n`);
      return 2;
    };
    if (parsed.positionals.length !== 2) {
      return fail('需要恰好两个参数：<owner/repo> 与 <PR 编号>');
    }
    const repo = parsed.positionals[0] as string;
    const prRaw = parsed.positionals[1] as string;
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) {
      return fail(`仓库标识必须是 "owner/name" 形式，收到 "${repo}"`);
    }
    if (!/^\d+$/.test(prRaw) || Number(prRaw) < 1) {
      return fail(`PR 编号必须是正整数，收到 "${prRaw}"`);
    }

    // 白名单检查在配置加载之后；--force 只跳过「已审过」去重，不放行白名单。
    const config = loadGlobalConfig(ctx.deps.paths.configFile, { log: ctx.deps.log });
    if (!config.repos.includes(repo)) {
      ctx.stderr(
        `错误：仓库 ${repo} 不在白名单内（全局配置 ${ctx.deps.paths.configFile} 的 repos），` +
          `--force 也不能放行；请先把仓库加入白名单。\n`,
      );
      return 2;
    }

    const json = parsed.values.json === true;
    const progress = (text: string): void => {
      (json ? ctx.stderr : ctx.stdout)(`→ ${text}\n`);
    };

    mkdirSync(ctx.deps.paths.home, { recursive: true });
    const state = openState(ctx.deps.paths.stateDb);
    let outcome: ReviewOutcome;
    try {
      outcome = await reviewPr(
        { repo, pr: Number(prRaw), force: parsed.values.force === true, dryRun: parsed.values['dry-run'] === true },
        {
          exec: ctx.deps.exec,
          clock: ctx.deps.clock,
          env: ctx.deps.env,
          paths: ctx.deps.paths,
          log: ctx.deps.log,
          state,
          out: json ? ctx.stderr : ctx.stdout,
          progress,
        },
      );
    } finally {
      state.close();
    }

    if (json) {
      ctx.stdout(`${JSON.stringify(outcome)}\n`);
      return outcome.status === 'failed' ? 1 : 0;
    }
    const text = renderOutcome(outcome);
    if (outcome.status === 'failed') {
      ctx.stderr(`${text}\n`);
      return 1;
    }
    ctx.stdout(`${text}\n`);
    return 0;
  },
};
