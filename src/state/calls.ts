/**
 * 调用账本（#5）：每次 claude 调用一行，记录模型、耗时、退出码、token 与费用。
 * `peak` 标记调用发生时是否处于 GLM 高峰期——按运行规则理应恒为 0，
 * 出现非 0 即说明高峰闸门有漏洞，用量报表（#15）会用到这些数据。
 */
import { toIso, type StateDb } from './db.ts';

/** 记录一次调用（recordCall 的输入）。 */
export interface CallInput {
  jobId: number;
  chunkIndex: number;
  model: string;
  startedAt: string | Date;
  durationMs: number;
  exitCode: number | null;
  ok: boolean;
  inputTokens?: number | null;
  outputTokens?: number | null;
  /** claude 报告的费用（美元），可空。 */
  costUsd?: number | null;
  peak?: boolean;
  error?: string | null;
}

/** 账本里的一条调用记录（repo 来自关联的任务，便于按仓库统计）。 */
export interface CallRecord {
  id: number;
  jobId: number;
  repo: string | null;
  chunkIndex: number;
  model: string;
  startedAt: string;
  durationMs: number;
  exitCode: number | null;
  ok: boolean;
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
  peak: boolean;
  error: string | null;
}

export interface ListCallsOptions {
  /** 只取 started_at >= since 的记录（含等号）。 */
  since?: string | Date;
  /** 只取 started_at <= until 的记录（含等号）。 */
  until?: string | Date;
  repo?: string;
  model?: string;
  /** 最多返回多少条，默认 1000。 */
  limit?: number;
}

type CallRow = {
  id: number;
  job_id: number;
  repo: string | null;
  chunk_index: number;
  model: string;
  started_at: string;
  duration_ms: number;
  exit_code: number | null;
  ok: number;
  input_tokens: number | null;
  output_tokens: number | null;
  cost_usd: number | null;
  peak: number;
  error: string | null;
};

function toCall(row: CallRow): CallRecord {
  return {
    id: row.id,
    jobId: row.job_id,
    repo: row.repo,
    chunkIndex: row.chunk_index,
    model: row.model,
    startedAt: row.started_at,
    durationMs: row.duration_ms,
    exitCode: row.exit_code,
    ok: row.ok === 1,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    costUsd: row.cost_usd,
    peak: row.peak === 1,
    error: row.error,
  };
}

/** 记录一次调用，返回入库后的完整记录。job_id 必须指向已存在的任务（外键约束）。 */
export function recordCall(state: StateDb, call: CallInput): CallRecord {
  const result = state.sqlite
    .prepare(
      `INSERT INTO calls
         (job_id, chunk_index, model, started_at, duration_ms, exit_code, ok,
          input_tokens, output_tokens, cost_usd, peak, error)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      call.jobId,
      call.chunkIndex,
      call.model,
      toIso(call.startedAt),
      call.durationMs,
      call.exitCode,
      call.ok ? 1 : 0,
      call.inputTokens ?? null,
      call.outputTokens ?? null,
      call.costUsd ?? null,
      call.peak === true ? 1 : 0,
      call.error ?? null,
    );
  const row = state.sqlite
    .prepare(
      `SELECT c.id, c.job_id, j.repo, c.chunk_index, c.model, c.started_at, c.duration_ms,
              c.exit_code, c.ok, c.input_tokens, c.output_tokens, c.cost_usd, c.peak, c.error
       FROM calls c LEFT JOIN jobs j ON j.id = c.job_id
       WHERE c.id = ?`,
    )
    .get(Number(result.lastInsertRowid)) as CallRow | undefined;
  if (row === undefined) throw new Error('记账后读不到调用记录');
  return toCall(row);
}

/** 查询账本，按调用开始时间升序；repo 过滤基于关联任务的仓库。 */
export function listCalls(state: StateDb, options: ListCallsOptions = {}): CallRecord[] {
  const conditions: string[] = [];
  const params: Array<string | number> = [];
  if (options.since !== undefined) {
    conditions.push('c.started_at >= ?');
    params.push(toIso(options.since));
  }
  if (options.until !== undefined) {
    conditions.push('c.started_at <= ?');
    params.push(toIso(options.until));
  }
  if (options.repo !== undefined) {
    conditions.push('j.repo = ?');
    params.push(options.repo);
  }
  if (options.model !== undefined) {
    conditions.push('c.model = ?');
    params.push(options.model);
  }
  const where = conditions.length > 0 ? ` WHERE ${conditions.join(' AND ')}` : '';
  const limit = Math.max(1, Math.min(options.limit ?? 1000, 100_000));
  const rows = state.sqlite
    .prepare(
      `SELECT c.id, c.job_id, j.repo, c.chunk_index, c.model, c.started_at, c.duration_ms,
              c.exit_code, c.ok, c.input_tokens, c.output_tokens, c.cost_usd, c.peak, c.error
       FROM calls c LEFT JOIN jobs j ON j.id = c.job_id${where}
       ORDER BY c.started_at, c.id
       LIMIT ?`,
    )
    .all(...params, limit) as unknown as CallRow[];
  return rows.map(toCall);
}
