/**
 * GitHub 适配层共享的命令执行与响应解析（模块内部使用）。
 * - gh / git 只经由注入的 exec 运行（带超时，环境继承 deps.env，测试注入 fakebin 的 PATH）；
 * - 非零退出 / 超时经 classify（可定制，如 422）→ 默认映射，抛出 errors.ts 里的错误类型；
 * - `gh api --paginate` 会把多页结果依次输出（数组页会被拼接），
 *   parseConcatenatedJson 按括号深度切开逐段解析，两种输出形态都能处理。
 */
import type { Clock } from '../lib/clock.ts';
import type { ExecFn, ExecOptions, ExecResult } from '../lib/exec.ts';
import type { Logger } from '../lib/log.ts';
import type { Paths } from '../lib/paths.ts';
import type { Env } from '../lib/types.ts';
import {
  GhUnavailableError,
  GithubError,
  UnexpectedResponseError,
  mapCommandFailure,
  summarize,
} from './errors.ts';

/** GitHub 适配层的依赖集合（CliContext.deps 结构满足它，可整体传入）。 */
export interface GithubDeps {
  exec: ExecFn;
  clock: Clock;
  paths: Paths;
  env?: Env;
  log?: Logger;
}

export interface RunOptions extends ExecOptions {
  /** 非零退出时的定制错误映射（如 422 → ReviewRejectedError）；返回 undefined 走默认映射。 */
  classify?: (result: ExecResult) => GithubError | undefined;
}

const DEFAULT_TIMEOUT_MS = 120_000;

export async function runGh(deps: GithubDeps, args: string[], options: RunOptions = {}): Promise<ExecResult> {
  return runCommand(deps, 'gh', args, options);
}

export async function runGit(deps: GithubDeps, args: string[], options: RunOptions = {}): Promise<ExecResult> {
  return runCommand(deps, 'git', args, options);
}

async function runCommand(
  deps: GithubDeps,
  cmd: 'gh' | 'git',
  args: string[],
  options: RunOptions,
): Promise<ExecResult> {
  const merged: RunOptions = { timeoutMs: DEFAULT_TIMEOUT_MS, ...options, env: options.env ?? deps.env };
  let result: ExecResult;
  try {
    result = await deps.exec(cmd, args, merged);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new GhUnavailableError(`无法执行 ${cmd} 命令（可能未安装或不在 PATH 中）：${detail}`);
  }
  if (result.code !== 0 || result.timedOut) {
    throw options.classify?.(result) ?? mapCommandFailure(cmd, args, result);
  }
  return result;
}

/** PR 编号必须是正整数，防止拼进 argv / API 路径时出现意外形态。 */
export function assertPositiveInt(value: number, what: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new GithubError(`${what}必须是正整数，实际是：${String(value)}`);
  }
}

/** 解析一段可能是多个 JSON 值拼接的文本（`gh api --paginate` 的输出形态）。 */
export function parseConcatenatedJson(text: string): unknown[] {
  const values: unknown[] = [];
  let i = 0;
  while (i < text.length) {
    while (i < text.length && /\s/.test(text[i])) i += 1;
    if (i >= text.length) break;
    const start = i;
    let depth = 0;
    let inString = false;
    let escaped = false;
    let closed = false;
    for (; i < text.length; i += 1) {
      const ch = text[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === '\\') escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') {
        inString = true;
      } else if (ch === '{' || ch === '[') {
        depth += 1;
      } else if (ch === '}' || ch === ']') {
        depth -= 1;
        if (depth === 0) {
          i += 1;
          closed = true;
          break;
        }
      }
    }
    if (!closed) {
      throw new UnexpectedResponseError(`gh 返回的 JSON 不完整：${summarize(text.slice(start, start + 120))}`);
    }
    values.push(parseJsonPiece(text.slice(start, i)));
  }
  return values;
}

function parseJsonPiece(piece: string): unknown {
  try {
    return JSON.parse(piece);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new UnexpectedResponseError(`gh 返回的内容不是合法 JSON（${detail}）：${summarize(piece)}`);
  }
}

/** 把多页结果摊平成数组（数组页拼接，单对象页包成一项）。 */
export function flattenPages(values: unknown[]): unknown[] {
  return values.flatMap((value) => (Array.isArray(value) ? value : [value]));
}

/** `gh api --paginate` 输出 → 对象数组（非对象项被丢掉）。 */
export function parsePaginatedObjects(text: string): Array<Record<string, unknown>> {
  return flattenPages(parseConcatenatedJson(text)).filter(isRecord);
}

/** `gh … --json` 单对象输出 → 对象。 */
export function parseSingleObject(text: string, what: string): Record<string, unknown> {
  const value = parseJsonPiece(text.trim());
  if (!isRecord(value)) throw new UnexpectedResponseError(`${what}应为 JSON 对象，实际不是`);
  return value;
}

/** `gh pr list --json` 数组输出 → 对象数组。 */
export function parseObjectArray(text: string, what: string): Array<Record<string, unknown>> {
  const value = parseJsonPiece(text.trim());
  if (!Array.isArray(value)) throw new UnexpectedResponseError(`${what}应为 JSON 数组，实际不是`);
  return value.filter(isRecord);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}

export function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

export function asNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

export function asBoolean(value: unknown): boolean {
  return value === true;
}
