/**
 * GitHub 适配层的错误类型与 gh / git 失败输出映射（见 #6）。
 * 全部交互只经由 gh CLI，错误在这里归一到可识别的类型（中文信息），
 * 供上层（#11 流水线、#13 守护进程）做重试 / 降级 / 排队决策。
 */
import type { ExecResult } from '../lib/exec.ts';

/** GitHub 适配层错误基类。 */
export class GithubError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GithubError';
  }
}

/** gh 未登录或凭证失效，需要 `gh auth login`。 */
export class GhNotLoggedInError extends GithubError {
  constructor(message: string) {
    super(message);
    this.name = 'GhNotLoggedInError';
  }
}

/** 仓库（或 PR）不存在，或当前账号无权限访问。 */
export class RepoNotFoundError extends GithubError {
  constructor(message: string) {
    super(message);
    this.name = 'RepoNotFoundError';
  }
}

/** 网络错误：无法访问 GitHub，或 gh / git 长时间无响应超时。 */
export class GhNetworkError extends GithubError {
  constructor(message: string) {
    super(message);
    this.name = 'GhNetworkError';
  }
}

/** GitHub API 限流，携带建议等待秒数（解析不到时按 1 小时窗口保守估计）。 */
export class RateLimitError extends GithubError {
  readonly retryAfterSeconds: number;

  constructor(message: string, retryAfterSeconds: number) {
    super(message);
    this.name = 'RateLimitError';
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/** gh / git 可执行文件本身无法运行（未安装、不在 PATH、spawn 失败）。 */
export class GhUnavailableError extends GithubError {
  constructor(message: string) {
    super(message);
    this.name = 'GhUnavailableError';
  }
}

/** 未归类的命令非零退出：带退出码与原始 stderr。 */
export class GhCommandError extends GithubError {
  readonly exitCode: number;
  readonly stderr: string;

  constructor(message: string, exitCode: number, stderr: string) {
    super(message);
    this.name = 'GhCommandError';
    this.exitCode = exitCode;
    this.stderr = stderr;
  }
}

/** PR diff 超过大小上限，不适合整体送审。 */
export class DiffTooLargeError extends GithubError {
  readonly bytes: number;
  readonly maxBytes: number;

  constructor(message: string, bytes: number, maxBytes: number) {
    super(message);
    this.name = 'DiffTooLargeError';
    this.bytes = bytes;
    this.maxBytes = maxBytes;
  }
}

/**
 * review 被 GitHub 拒绝（HTTP 422）。常见原因：某条行内评论的行号不在 diff 里。
 * `details` 保留 GitHub 返回的原始错误信息，供 #11 降级重试。
 */
export class ReviewRejectedError extends GithubError {
  readonly details: string;

  constructor(message: string, details: string) {
    super(message);
    this.name = 'ReviewRejectedError';
    this.details = details;
  }
}

/** 命令成功返回，但内容不是预期格式（JSON 损坏、字段缺失等）。 */
export class UnexpectedResponseError extends GithubError {
  constructor(message: string) {
    super(message);
    this.name = 'UnexpectedResponseError';
  }
}

/** 仓库标识非法（必须形如 owner/name，防止拼进本地路径时被注入）。 */
export class InvalidRepoSlugError extends GithubError {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidRepoSlugError';
  }
}

/** commit SHA 非法（必须 40 / 64 位十六进制，防止拼进本地路径时被注入）。 */
export class InvalidShaError extends GithubError {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidShaError';
  }
}

/** 把多行输出压成一行并截断，用于拼进错误信息。 */
export function summarize(text: string, max = 300): string {
  const oneLine = text.trim().replace(/\s+/g, ' ');
  return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine;
}

/** 从限流提示里解析建议等待秒数；解析不到按 1 小时（GitHub 主限流窗口）保守估计。 */
export function parseRetrySeconds(text: string): number {
  const direct = /re-trying in (\d+) second/i.exec(text);
  if (direct !== null) return Number(direct[1]);
  const unit = /(\d+)\s*(seconds?|secs?|s|minutes?|mins?|m|hours?|h)\b/i.exec(text);
  if (unit !== null) {
    const n = Number(unit[1]);
    if (/^h/i.test(unit[2])) return n * 3600;
    if (/^m/i.test(unit[2])) return n * 60;
    return n;
  }
  return 3600;
}

const NETWORK_MARKERS = [
  'could not resolve host',
  'dial tcp',
  'connection refused',
  'network is unreachable',
  'no route to host',
  'connection reset',
  'connection was closed',
  'i/o timeout',
];

/**
 * 把 gh / git 的失败结果映射成上面的错误类型。匹配基于 stderr + stdout 的文本特征。
 */
export function mapCommandFailure(cmd: string, args: string[], result: ExecResult): GithubError {
  const context = summarize(`${cmd} ${args.join(' ')}`, 120);
  const combined = `${result.stderr}\n${result.stdout}`;
  const brief = summarize(combined);
  const lower = combined.toLowerCase();

  if (result.timedOut) {
    return new GhNetworkError(`调用 ${context} 超时无响应，疑似网络问题，请稍后重试`);
  }
  if (lower.includes('rate limit exceeded') || lower.includes('secondary rate limit')) {
    const wait = parseRetrySeconds(combined);
    return new RateLimitError(`GitHub API 限流：${brief}；建议等待 ${wait} 秒后重试`, wait);
  }
  if (
    lower.includes('gh auth login') ||
    lower.includes('not logged in') ||
    lower.includes('to get started with github cli') ||
    lower.includes('authentication required') ||
    lower.includes('http 401')
  ) {
    return new GhNotLoggedInError(`gh 未登录或凭证已失效，请先运行 gh auth login：${brief}`);
  }
  if (lower.includes('could not resolve to a repository')) {
    return new RepoNotFoundError(`仓库不存在或当前账号无权限访问：${brief}`);
  }
  if (lower.includes('could not resolve to a pull') || lower.includes('http 404') || /\bnot found\b/.test(lower)) {
    const target = lower.includes('pull') ? 'PR（或其仓库）' : '仓库';
    return new RepoNotFoundError(`${target}不存在或当前账号无权限访问：${brief}`);
  }
  if (NETWORK_MARKERS.some((marker) => lower.includes(marker))) {
    return new GhNetworkError(`网络错误，无法访问 GitHub：${brief}`);
  }
  return new GhCommandError(`命令失败（${context}，退出码 ${result.code}）：${brief}`, result.code, result.stderr);
}
