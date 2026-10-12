/**
 * 共享类型。只在 #2（地基）里增改；功能模块需要的新类型定义在自己目录里。
 */
import type { Clock } from './clock.ts';
import type { ExecFn } from './exec.ts';
import type { Logger } from './log.ts';
import type { Paths } from './paths.ts';

/** 严重度：从高到低 blocker > major > minor > nit。 */
export type Severity = 'blocker' | 'major' | 'minor' | 'nit';

/** 严重度排序数值，越大越严重。 */
export const SEVERITY_ORDER: Record<Severity, number> = {
  nit: 0,
  minor: 1,
  major: 2,
  blocker: 3,
};

/** 严重度中文显示名。 */
export const SEVERITY_LABEL: Record<Severity, string> = {
  blocker: '严重',
  major: '重要',
  minor: '一般',
  nit: '建议',
};

/** 仓库标识：`owner/name`。 */
export type RepoSlug = string;

/** PR 元信息（来源 `gh pr view --json`）。 */
export interface PrInfo {
  repo: RepoSlug;
  number: number;
  title: string;
  author: string;
  url: string;
  headSha: string;
  /** base 的 commit SHA。`--json baseRefOid` 需 gh ≥ 2.76（#30），运行时不请求，通常缺省；需要时经 github.getPrBaseSha 另查。 */
  baseSha?: string;
  baseRef: string;
  headRef: string;
  isDraft: boolean;
  labels: string[];
  state: string;
  updatedAt: string;
}

/** 一条审查发现（模型结构化输出）。 */
export interface Finding {
  severity: Severity;
  file: string;
  line: number;
  endLine?: number;
  title: string;
  body: string;
  suggestion?: string;
}

/** 一次审查的结构化结果。 */
export interface ReviewResult {
  summary: string;
  findings: Finding[];
}

/** 任务队列状态。 */
export type JobStatus = 'queued' | 'deferred' | 'running' | 'done' | 'failed' | 'skipped';

/** 环境变量集合。 */
export type Env = Record<string, string | undefined>;

/** 子命令依赖集合，全部可注入（测试用假实现替换）。 */
export interface Deps {
  exec: ExecFn;
  clock: Clock;
  env: Env;
  paths: Paths;
  log: Logger;
}

/** 传给子命令的上下文：依赖集合 + 输出函数。 */
export interface CliContext {
  deps: Deps;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

/** 子命令：`src/commands/*.ts` 每个文件 `export const command: Command`。 */
export interface Command {
  name: string;
  summary: string;
  usage: string;
  run(argv: string[], ctx: CliContext): Promise<number>;
}
