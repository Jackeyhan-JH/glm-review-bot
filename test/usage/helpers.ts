/**
 * usage 模块测试夹具（#15）：
 * - FIXED_CALLS：一组固定调用记录——两个仓库、两个模型、高峰期 1 条、失败 2 条、
 *   跨北京时间两天（2026-10-12 周一 / 2026-10-13 周二），数值断言都以它为准；
 * - toCallRecord：把夹具转成 report 需要的 CallRecord；
 * - seedUsageDb：把夹具写进临时状态库（先入队任务再记账），供命令层测试；
 * - createUsageHarness：可拨时针的 CLI 测试上下文（捕获输出、隔离目录）。
 */
import { fixedClock, type FakeClock } from '../../src/lib/clock.ts';
import { exec } from '../../src/lib/exec.ts';
import { nullLogger } from '../../src/lib/log.ts';
import { resolvePaths } from '../../src/lib/paths.ts';
import type { CliContext } from '../../src/lib/types.ts';
import { recordCall, type CallRecord } from '../../src/state/calls.ts';
import { openState } from '../../src/state/db.ts';
import { enqueue } from '../../src/state/jobs.ts';
import { createTmpEnv, type TmpEnv } from '../helpers/tmp.ts';

/** 夹具里的一条调用（repo/pr 用于入库关联任务，其余是账本字段）。 */
export interface FixtureCall {
  repo: string;
  pr: number;
  model: string;
  startedAt: string;
  durationMs: number;
  ok: boolean;
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
  peak: boolean;
  error?: string | null;
}

/**
 * 固定调用记录（北京时间 2026-10-12 是周一）：
 * 1. 10-12 10:00（北京）split-bill / glm-5.3，成功；
 * 2. 10-12 15:00（北京，高峰）split-bill / glm-5.3-flash，成功，peak 标记；
 * 3. 10-12 20:00（北京）glm-toolbox / glm-5.3，失败（无费用）；
 * 4. 10-13 09:00（北京）glm-toolbox / glm-5.3-flash，失败（无费用）；
 * 5. 10-13 11:30（北京）glm-toolbox / glm-5.3，成功。
 */
export const FIXED_CALLS: readonly FixtureCall[] = Object.freeze([
  Object.freeze({
    repo: 'Jackeyhan-JH/split-bill',
    pr: 11,
    model: 'glm-5.3',
    startedAt: '2026-10-12T02:00:00.000Z',
    durationMs: 60_000,
    ok: true,
    inputTokens: 1200,
    outputTokens: 300,
    costUsd: 0.012,
    peak: false,
  }),
  Object.freeze({
    repo: 'Jackeyhan-JH/split-bill',
    pr: 11,
    model: 'glm-5.3-flash',
    startedAt: '2026-10-12T07:00:00.000Z',
    durationMs: 30_000,
    ok: true,
    inputTokens: 800,
    outputTokens: 100,
    costUsd: 0.004,
    peak: true,
  }),
  Object.freeze({
    repo: 'Jackeyhan-JH/glm-toolbox',
    pr: 7,
    model: 'glm-5.3',
    startedAt: '2026-10-12T12:00:00.000Z',
    durationMs: 45_000,
    ok: false,
    inputTokens: 500,
    outputTokens: 0,
    costUsd: null,
    peak: false,
    error: 'claude 退出码 1',
  }),
  Object.freeze({
    repo: 'Jackeyhan-JH/glm-toolbox',
    pr: 7,
    model: 'glm-5.3-flash',
    startedAt: '2026-10-13T01:00:00.000Z',
    durationMs: 20_000,
    ok: false,
    inputTokens: 300,
    outputTokens: 0,
    costUsd: null,
    peak: false,
    error: '结构化输出解析失败',
  }),
  Object.freeze({
    repo: 'Jackeyhan-JH/glm-toolbox',
    pr: 8,
    model: 'glm-5.3',
    startedAt: '2026-10-13T03:30:00.000Z',
    durationMs: 90_000,
    ok: true,
    inputTokens: 2000,
    outputTokens: 800,
    costUsd: 0.02,
    peak: false,
  }),
]);

/** 夹具 → CallRecord（id / jobId 只作占位，报表不依赖它们）。 */
export function toCallRecord(call: FixtureCall, id: number, jobId = 1): CallRecord {
  return {
    id,
    jobId,
    repo: call.repo,
    chunkIndex: 0,
    model: call.model,
    startedAt: call.startedAt,
    durationMs: call.durationMs,
    exitCode: call.ok ? 0 : 1,
    ok: call.ok,
    inputTokens: call.inputTokens,
    outputTokens: call.outputTokens,
    costUsd: call.costUsd,
    peak: call.peak,
    error: call.error ?? null,
  };
}

export const FIXED_CALL_RECORDS: readonly CallRecord[] = FIXED_CALLS.map((call, index) =>
  toCallRecord(call, index + 1),
);

/** 把夹具写进状态库：每个 (repo, pr) 入队一个任务，再逐条记账。 */
export function seedUsageDb(dbPath: string, calls: readonly FixtureCall[]): void {
  const state = openState(dbPath);
  try {
    const jobIds = new Map<string, number>();
    for (const call of calls) {
      const key = `${call.repo}#${call.pr}`;
      let jobId = jobIds.get(key);
      if (jobId === undefined) {
        const { job } = enqueue(state, {
          repo: call.repo,
          pr: call.pr,
          headSha: `seed-${key}`,
          now: call.startedAt,
        });
        jobId = job.id;
        jobIds.set(key, jobId);
      }
      recordCall(state, {
        jobId,
        chunkIndex: 0,
        model: call.model,
        startedAt: call.startedAt,
        durationMs: call.durationMs,
        exitCode: call.ok ? 0 : 1,
        ok: call.ok,
        inputTokens: call.inputTokens,
        outputTokens: call.outputTokens,
        costUsd: call.costUsd,
        peak: call.peak,
        error: call.error ?? null,
      });
    }
  } finally {
    state.close();
  }
}

export interface UsageHarness {
  ctx: CliContext;
  clock: FakeClock;
  tmp: TmpEnv;
  stdout(): string;
  stderr(): string;
  /** 清空已捕获的输出（同一 harness 多次运行命令时用）。 */
  reset(): void;
  /** 把夹具写入本上下文的 state.db（独立于 clock，可反复调用追加数据）。 */
  seed(calls: readonly FixtureCall[]): void;
  cleanup(): void;
}

/** 命令层测试上下文：假时钟可拨动，输出捕获到字符串。 */
export function createUsageHarness(
  now: string = '2026-10-13T06:00:00.000Z',
  prefix = 'glm-review-usage-test',
): UsageHarness {
  const tmp = createTmpEnv(prefix);
  const clock = fixedClock(now);
  let out = '';
  let err = '';
  const ctx: CliContext = {
    deps: {
      exec,
      clock,
      env: tmp.env,
      paths: resolvePaths(tmp.env),
      log: nullLogger,
    },
    stdout: (text) => {
      out += text;
    },
    stderr: (text) => {
      err += text;
    },
  };
  return {
    ctx,
    clock,
    tmp,
    stdout: () => out,
    stderr: () => err,
    reset: () => {
      out = '';
      err = '';
    },
    seed: (calls) => seedUsageDb(ctx.deps.paths.stateDb, calls),
    cleanup: tmp.cleanup,
  };
}
