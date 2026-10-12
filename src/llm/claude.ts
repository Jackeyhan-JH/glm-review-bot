/**
 * Claude Code 非交互调用器（#8，#1 运行规则 5）：
 *
 *     claude -p --model <model> --effort <effort> --output-format json
 *            --json-schema <schema-json> --tools Read Grep Glob
 *            --permission-mode default --no-session-persistence
 *
 * - 提示词只经 stdin 传入，绝不进 argv（argv 会出现在进程列表里）；
 * - 只给只读工具 Read / Grep / Glob，绝不给 Bash / Edit / Write / WebFetch /
 *   WebSearch，也绝不带任何跳过权限检查的参数；
 * - 解析 `--output-format json` 的结果（result / structured_output / is_error /
 *   usage / total_cost_usd / duration_ms / num_turns），结构化输出缺失时从
 *   result 文本里提取第一个 JSON 对象；
 * - 失败分成可重试（超时、5xx/过载/限流、输出不是合法 JSON）与不可重试
 *   （认证失败、参数错误），供 retry.ts 就地重试；
 * - 每次调用结束（无论成败）回调一次 onCall，由 #11 写进 calls 表记账。
 *
 * 外部执行只经注入的 exec（src/lib/exec.ts，自带超时：先 SIGINT、宽限期后 SIGKILL）。
 * 参数名已对照本机 `claude --version` 2.1.292 的 `--help` 校验。
 */
import type { ExecFn, ExecResult } from '../lib/exec.ts';

/** 被调用的命令名（经 PATH 解析；测试时 fakebin 的 PATH 在最前）。 */
export const CLAUDE_BIN = 'claude';

/** 审查可用的只读工具白名单：claude 会话里只有这三个工具。 */
export const READONLY_TOOLS: readonly string[] = ['Read', 'Grep', 'Glob'];

/** 默认思考力度。 */
export const DEFAULT_EFFORT = 'medium';

/** 默认超时（一次块审查给 10 分钟）。 */
export const DEFAULT_TIMEOUT_MS = 600_000;

/** 一次 claude 调用的输入。 */
export interface ClaudeRunInput {
  /** 提示词全文，经 stdin 传入。 */
  prompt: string;
  /** 工作目录（PR head 的只读检出，见 #6）。 */
  cwd: string;
  /** 模型名（pickModel 的结果）。 */
  model: string;
  /** 思考力度（low / medium / high / xhigh / max），默认 medium。 */
  effort?: string;
  /** 结构化输出 JSON Schema；省略则不带 --json-schema。 */
  jsonSchema?: unknown;
  /** 超时毫秒数，默认 10 分钟。 */
  timeoutMs?: number;
}

/** 用量与成本，来自输出 JSON 的 usage / total_cost_usd / num_turns。 */
export interface ClaudeUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalCostUsd?: number;
  numTurns?: number;
}

/** onCall 的记账记录（#11 写进状态库 calls 表）。 */
export interface ClaudeCallRecord {
  model: string;
  durationMs: number;
  exitCode: number;
  ok: boolean;
  usage?: ClaudeUsage;
  error?: string;
}

/** runClaude 的结果。ok = 调用成功且输出可解析；retryable = 失败后是否值得就地重试。 */
export interface ClaudeRunResult {
  ok: boolean;
  /** structured_output；缺失时为从 result 文本提取的第一个 JSON 对象；再缺失为 result 文本。 */
  output?: unknown;
  usage?: ClaudeUsage;
  durationMs: number;
  exitCode: number;
  error?: string;
  retryable: boolean;
}

/** runClaude 的依赖，全部可注入。 */
export interface ClaudeDeps {
  exec: ExecFn;
  /** 子进程的完整环境变量（测试注入 fakebin 的 PATH）；不传则继承当前进程。 */
  env?: Record<string, string | undefined>;
  /** 每次调用结束回调一次（无论成败）。 */
  onCall?: (record: ClaudeCallRecord) => void;
}

/**
 * 组装 claude 的完整 argv（不含命令名；提示词不在其中）。
 * 导出以便测试与排查时直接核对。
 */
export function buildClaudeArgs(input: ClaudeRunInput): string[] {
  const args = [
    '-p',
    '--model',
    input.model,
    '--effort',
    input.effort ?? DEFAULT_EFFORT,
    '--output-format',
    'json',
  ];
  if (input.jsonSchema !== undefined) {
    args.push('--json-schema', JSON.stringify(input.jsonSchema));
  }
  args.push('--tools', ...READONLY_TOOLS, '--permission-mode', 'default', '--no-session-persistence');
  return args;
}

/** 调用 claude 并解析结果；不抛错（连 spawn 失败也变成 ok=false 的返回值）。 */
export async function runClaude(input: ClaudeRunInput, deps: ClaudeDeps): Promise<ClaudeRunResult> {
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  let raw: ExecResult;
  try {
    raw = await deps.exec(CLAUDE_BIN, buildClaudeArgs(input), {
      cwd: input.cwd,
      input: input.prompt,
      timeoutMs,
      env: deps.env,
    });
  } catch (err) {
    // claude 本体没跑起来（如命令不存在、权限不足）：重试不会有好结果。
    const message = `claude 启动失败：${err instanceof Error ? err.message : String(err)}`;
    const result: ClaudeRunResult = {
      ok: false,
      durationMs: 0,
      exitCode: -1,
      error: message,
      retryable: false,
    };
    deps.onCall?.({ model: input.model, durationMs: 0, exitCode: -1, ok: false, error: message });
    return result;
  }

  const result = assembleResult(raw, input, timeoutMs);
  const record: ClaudeCallRecord = {
    model: input.model,
    durationMs: result.durationMs,
    exitCode: result.exitCode,
    ok: result.ok,
    usage: result.usage,
  };
  if (result.error !== undefined) record.error = result.error;
  deps.onCall?.(record);
  return result;
}

/** 不可重试的错误特征：认证失败、参数错误——重试也不会有好结果。 */
const FATAL_PATTERNS: RegExp[] = [
  /invalid api key/i,
  /authentication\s*(?:error|failed)?/i,
  /unauthorized/i,
  /forbidden/i,
  /\b40[13]\b/,
  /not logged in/i,
  /no (?:api key|credentials)/i,
  /unknown option/i,
  /invalid value/i,
  /missing (?:required )?argument/i,
  /option [^ ]+ requires/i,
];

/** 可重试的错误特征：5xx / 过载 / 限流 / 网络抖动。 */
const RETRYABLE_PATTERNS: RegExp[] = [
  /\b(?:429|500|502|503|504|529)\b/,
  /overloaded/i,
  /rate.?limit/i,
  /too many requests/i,
  /service unavailable/i,
  /temporarily/i,
  /internal server error/i,
  /bad gateway/i,
  /gateway timeout/i,
  /timed? ?out/i,
  /econn(?:reset|refused)/i,
  /etimedout/i,
  /socket hang up/i,
  /fetch failed/i,
  /network error/i,
];

/** 是否命中不可重试特征（认证失败、参数错误）。 */
export function isFatalFailure(message: string): boolean {
  return FATAL_PATTERNS.some((re) => re.test(message));
}

/**
 * 失败分类：先看不可重试特征（认证/参数），再看可重试特征（5xx/过载/限流/网络）。
 * 都不匹配时按不可重试处理——宁可交给 #5 的任务级重试，也不在原地盲试；
 * 「输出不是合法 JSON」单独定性为可重试（见 assembleResult）。
 */
export function isRetryableFailure(message: string): boolean {
  if (isFatalFailure(message)) return false;
  return RETRYABLE_PATTERNS.some((re) => re.test(message));
}

/** 把 exec 的原始结果变成 ClaudeRunResult（超时 → 可重试；is_error / 非零退出 → 失败）。 */
function assembleResult(raw: ExecResult, input: ClaudeRunInput, timeoutMs: number): ClaudeRunResult {
  const base = { exitCode: raw.code, durationMs: raw.durationMs };

  if (raw.timedOut) {
    return {
      ...base,
      ok: false,
      retryable: true,
      error: `claude 调用超时（${timeoutMs}ms 内未完成）`,
    };
  }

  const envelope = parseEnvelope(raw.stdout);
  if (envelope === undefined) {
    // stdout 不是合法 JSON：规范定性为可重试（除非 stderr 里是认证/参数类错误）。
    const detail = raw.stderr.trim() !== '' ? raw.stderr : raw.stdout;
    const message = `claude 输出无法解析（${raw.stdout.trim() === '' ? '输出为空' : '输出不是合法 JSON'}，退出码 ${raw.code}）：${truncate(detail)}`;
    return {
      ...base,
      ok: false,
      retryable: !isFatalFailure(raw.stderr),
      error: message,
    };
  }

  const usage = readUsage(envelope);
  const durationMs = typeof envelope.duration_ms === 'number' ? envelope.duration_ms : raw.durationMs;

  if (raw.code !== 0 || envelope.is_error === true) {
    const resultText = typeof envelope.result === 'string' ? envelope.result : '';
    const detail = [resultText, raw.stderr].filter((s) => s.trim() !== '').join('\n');
    return {
      ok: false,
      usage,
      durationMs,
      exitCode: raw.code,
      retryable: isRetryableFailure(detail),
      error:
        detail.trim() !== ''
          ? `claude 调用失败（退出码 ${raw.code}${envelope.is_error === true ? '，is_error' : ''}）：${truncate(detail)}`
          : `claude 调用失败（退出码 ${raw.code}${envelope.is_error === true ? '，is_error' : ''}）`,
    };
  }

  return {
    ok: true,
    output: resolveOutput(envelope),
    usage,
    durationMs,
    exitCode: raw.code,
    retryable: false,
  };
}

/** 解析 `--output-format json` 的 stdout；不是 JSON 对象时返回 undefined。 */
function parseEnvelope(stdout: string): Record<string, unknown> | undefined {
  const trimmed = stdout.trim();
  if (trimmed === '') return undefined;
  try {
    const value: unknown = JSON.parse(trimmed);
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
  } catch {
    // 落到外面的「输出不是合法 JSON」分支
  }
  return undefined;
}

/** 从输出 JSON 里取用量字段（缺的省略）。 */
function readUsage(envelope: Record<string, unknown>): ClaudeUsage | undefined {
  const usageRaw =
    envelope.usage !== null && typeof envelope.usage === 'object' && !Array.isArray(envelope.usage)
      ? (envelope.usage as Record<string, unknown>)
      : undefined;
  const num = (value: unknown): number | undefined =>
    typeof value === 'number' && Number.isFinite(value) ? value : undefined;
  const usage: ClaudeUsage = {
    inputTokens: num(usageRaw?.input_tokens),
    outputTokens: num(usageRaw?.output_tokens),
    totalCostUsd: num(envelope.total_cost_usd),
    numTurns: num(envelope.num_turns),
  };
  const hasAny = Object.values(usage).some((v) => v !== undefined);
  return hasAny ? usage : undefined;
}

/** 输出取值优先级：structured_output > result 文本里的第一个 JSON 对象 > result 文本。 */
function resolveOutput(envelope: Record<string, unknown>): unknown {
  if ('structured_output' in envelope) return envelope.structured_output;
  if (typeof envelope.result === 'string') {
    const extracted = extractFirstJsonObject(envelope.result);
    if (extracted !== undefined) return extracted;
    return envelope.result;
  }
  return undefined;
}

/**
 * 从文本里提取第一个能解析成对象的 JSON 片段：先找配平的花括号块，再 JSON.parse，
 * 失败就找下一个 `{`。字符串里的花括号与转义不影响配平。
 */
export function extractFirstJsonObject(text: string): unknown | undefined {
  for (let start = text.indexOf('{'); start !== -1; start = text.indexOf('{', start + 1)) {
    const end = balancedObjectEnd(text, start);
    if (end === -1) continue;
    try {
      const value: unknown = JSON.parse(text.slice(start, end + 1));
      if (value !== null && typeof value === 'object' && !Array.isArray(value)) return value;
    } catch {
      // 不是合法 JSON，继续找下一个 {
    }
  }
  return undefined;
}

/** 从 start（指向 `{`）起找配平的 `}` 下标；跨过字符串字面量；不配平返回 -1。 */
function balancedObjectEnd(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
    } else if (ch === '"') {
      inString = true;
    } else if (ch === '{') {
      depth += 1;
    } else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** 错误信息截断，避免把整段输出带进日志/结果里。 */
function truncate(text: string, max = 500): string {
  const flat = text.trim();
  return flat.length <= max ? flat : `${flat.slice(0, max)}…`;
}
