/**
 * status 模块测试夹具：临时状态库 + 演示数据。
 *
 * 演示数据以 NOW = 2026-10-12T07:30:00Z（周一北京时间 15:30，正处高峰）为基准，
 * 时间关系前后自洽：高峰中入队的任务延后到本段高峰结束（周一 18:00 北京时间）。
 * 快照测试与截图脚本（demo.ts）共用同一份种子，保证所见即所测。
 *
 * 注意：claimNext 取的是全库最早可执行的任务，所以种子必须按时间顺序
 * 「入队 → 认领 → 终态」逐步操作，否则认领会拿到别的任务。
 */
import path from 'node:path';
import { currentWindow, nextSwitch } from '../../src/peak/peak.ts';
import { recordCall } from '../../src/state/calls.ts';
import {
  META_DAEMON_HEARTBEAT_AT,
  META_DAEMON_LAST_POLL_MS,
  META_DAEMON_OPEN_PRS,
} from '../../src/status/collect.ts';
import { openState, type StateDb } from '../../src/state/db.ts';
import { claimNext, enqueue, markDone, markFailed, markSkipped } from '../../src/state/jobs.ts';
import { createTmpEnv } from '../helpers/tmp.ts';

/** 演示数据的基准时刻：周一北京时间 15:30（高峰期内）。 */
export const DEMO_NOW = new Date('2026-10-12T07:30:00.000Z');
/** 本段高峰结束：周一北京时间 18:00。 */
export const DEMO_PEAK_END = new Date('2026-10-12T10:00:00.000Z');

/**
 * 高峰延后任务的 not_before：高峰中 = 本段结束；峰外 = 下一段高峰的结束
 * （高峰固定 4 小时，DEMO_NOW 下等于 DEMO_PEAK_END，与非高峰时刻播种也自洽）。
 */
function peakDeferUntil(now: Date): Date {
  const current = currentWindow(now);
  if (current !== null) return current.end;
  return new Date(nextSwitch(now).at.getTime() + 4 * 60 * 60_000);
}

const TOOLBOX = 'Jackeyhan-JH/glm-toolbox';
const SPLIT_BILL = 'Jackeyhan-JH/split-bill';
const NIGHT_SHIFT = 'Jackeyhan-JH/glm-night-shift';
const PEAK_CLOCK = 'Jackeyhan-JH/glm-peak-clock';

const minutes = (n: number): number => n * 60_000;

export interface TmpStatus {
  state: StateDb;
  /** 库文件路径。 */
  dbPath: string;
  /** 额度暂停文件的临时路径（默认不存在；测试可自行创建）。 */
  pauseFile: string;
  cleanup(): void;
}

export function openTmpStatus(prefix = 'glm-review-status-test'): TmpStatus {
  const tmp = createTmpEnv(prefix);
  const dbPath = path.join(tmp.homeDir, 'state.db');
  const state = openState(dbPath);
  const pauseFile = path.join(tmp.baseDir, 'GLM_PAUSE');
  const cleanup = (): void => {
    try {
      state.close();
    } catch {
      // 已关闭则忽略。
    }
    tmp.cleanup();
  };
  return { state, dbPath, pauseFile, cleanup };
}

/** 直接写 meta 表（#13 的 daemon 将来也这样写心跳）。 */
export function setMeta(state: StateDb, key: string, value: string): void {
  state.sqlite
    .prepare(
      `INSERT INTO meta (key, value) VALUES (?, ?)
       ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
    )
    .run(key, value);
}

/** 在指定时刻认领某条任务；认领的不是期望的那条说明种子顺序写错了，直接报错。 */
function claimAt(state: StateDb, at: Date, id: number): void {
  const job = claimNext(state, at);
  if (job === undefined || job.id !== id) {
    throw new Error(`演示数据认领失败：期望 id=${id}，实际 id=${job?.id}`);
  }
}

/**
 * 种入一份「什么都有」的演示状态：新鲜心跳、三种等待中的任务、
 * 成功 / 失败 / 跳过的审查、跨越今天与近 7 天窗口的调用账本。
 * 操作按时间先后排列（见文件头说明）。
 */
export function seedDemoState(state: StateDb, now: Date = DEMO_NOW): void {
  setMeta(state, META_DAEMON_HEARTBEAT_AT, new Date(now.getTime() - 15_000).toISOString());
  setMeta(state, META_DAEMON_LAST_POLL_MS, '4200');
  setMeta(state, META_DAEMON_OPEN_PRS, JSON.stringify({ [TOOLBOX]: 2, [SPLIT_BILL]: 1 }));

  // 失败：重试 3 次（每次认领后失败，退避到指定时刻）后终态 failed。
  const failed = enqueue(state, {
    repo: NIGHT_SHIFT,
    pr: 5,
    headSha: '9f8e7d6c5b4a39281706f5e4d3c2b1a09f8e7d6c',
    now: new Date(now.getTime() - minutes(360)),
  }).job;
  let failedAt = new Date(now.getTime() - minutes(280));
  for (let attempt = 0; attempt < 3; attempt++) {
    claimAt(state, failedAt, failed.id);
    markFailed(state, failed.id, 'claude 退出码 124：调用超时', {
      now: failedAt,
      retryAt: new Date(failedAt.getTime() + minutes(30)),
    });
    failedAt = new Date(failedAt.getTime() + minutes(31));
  }

  // 完成：两次成功审查（带 review 链接、问题数、模型、耗时）。
  const done2 = enqueue(state, {
    repo: SPLIT_BILL,
    pr: 8,
    headSha: '0a1b2c3d4e5f60718293a4b5c6d7e8f9a0b1c2d3',
    now: new Date(now.getTime() - minutes(300)),
  }).job;
  claimAt(state, new Date(now.getTime() - minutes(195)), done2.id);
  markDone(state, done2.id, {
    now: new Date(now.getTime() - minutes(180)),
    reviewUrl: 'https://github.com/Jackeyhan-JH/split-bill/pull/8#pullrequestreview-2405107777',
    findingsCount: 1,
    model: 'glm-5.3',
  });

  const done1 = enqueue(state, {
    repo: TOOLBOX,
    pr: 23,
    headSha: '1f3e5d7c9a2b4d6f8e0c1a3b5d7f9e1c2a4b6d8f0',
    now: new Date(now.getTime() - minutes(120)),
  }).job;
  claimAt(state, new Date(now.getTime() - minutes(40)), done1.id);
  markDone(state, done1.id, {
    now: new Date(now.getTime() - minutes(37)),
    reviewUrl: 'https://github.com/Jackeyhan-JH/glm-toolbox/pull/23#pullrequestreview-2405112601',
    findingsCount: 3,
    model: 'glm-5.3-flash',
  });

  // 跳过：被同一 PR 的新 commit 取代。
  const skipped = enqueue(state, {
    repo: PEAK_CLOCK,
    pr: 2,
    headSha: '5201314987654321abcdef0123456789abcdef01',
    now: new Date(now.getTime() - minutes(75)),
  }).job;
  markSkipped(state, skipped.id, 'superseded', new Date(now.getTime() - minutes(30)));

  // 排队（失败退避后等待重试）：已到可执行时刻。
  const retry = enqueue(state, {
    repo: SPLIT_BILL,
    pr: 9,
    headSha: '13579bdf02468ace13579bdf02468ace13579bdf',
    now: new Date(now.getTime() - minutes(90)),
  }).job;
  claimAt(state, new Date(now.getTime() - minutes(20)), retry.id);
  markFailed(state, retry.id, 'gh 请求被限流（HTTP 403）', {
    now: new Date(now.getTime() - minutes(19)),
    retryAt: new Date(now.getTime() - minutes(1)),
  });

  // 延后：高峰期入队，not_before = 本段高峰结束（周一 18:00 北京时间）。
  enqueue(state, {
    repo: TOOLBOX,
    pr: 24,
    headSha: '2468ace13579bdf02468ace13579bdf02468ace1',
    now: new Date(now.getTime() - minutes(30)),
    notBefore: peakDeferUntil(now),
    status: 'deferred',
    reason: 'peak',
  });

  // 进行中：刚被认领（not_before 早于上面的重试任务，认领顺序正确）。
  const running = enqueue(state, {
    repo: TOOLBOX,
    pr: 25,
    headSha: 'fedcba9876543210fedcba9876543210fedcba98',
    now: new Date(now.getTime() - minutes(25)),
  }).job;
  claimAt(state, new Date(now.getTime() - minutes(2)), running.id);

  // 调用账本：覆盖今天（北京时间）与近 7 天窗口，另有一条 8 天前（窗外）。
  // 时刻全部相对 now 偏移（DEMO_NOW 下与注释里的绝对时刻一一对应），
  // 这样 demo.ts 用真实当前时刻播种时，队列与账本的时间关系仍然自洽。
  const at = (offsetMinutes: number): string =>
    new Date(now.getTime() - minutes(offsetMinutes)).toISOString();
  recordCall(state, {
    jobId: done1.id,
    chunkIndex: 0,
    model: 'glm-5.3-flash',
    startedAt: at(180), // 北京时间周一 12:30（非高峰）
    durationMs: 180_000,
    exitCode: 0,
    ok: true,
    inputTokens: 12_000,
    outputTokens: 3_400,
  });
  recordCall(state, {
    jobId: done2.id,
    chunkIndex: 0,
    model: 'glm-5.3',
    startedAt: at(270), // 北京时间周一 11:00（非高峰）
    durationMs: 900_000,
    exitCode: 0,
    ok: true,
    inputTokens: 45_000,
    outputTokens: 8_000,
  });
  recordCall(state, {
    jobId: failed.id,
    chunkIndex: 0,
    model: 'glm-5.3',
    startedAt: at(690), // 北京时间周一 04:00（非高峰）
    durationMs: 300_000,
    exitCode: 124,
    ok: false,
    inputTokens: 500,
    outputTokens: 0,
    error: 'claude 退出码 124：调用超时',
  });
  recordCall(state, {
    jobId: done2.id,
    chunkIndex: 1,
    model: 'glm-5.3',
    startedAt: at(1590), // 北京时间周日 13:00
    durationMs: 600_000,
    exitCode: 0,
    ok: true,
    inputTokens: 30_000,
    outputTokens: 5_000,
  });
  recordCall(state, {
    jobId: done1.id,
    chunkIndex: 9,
    model: 'glm-5.3-flash',
    startedAt: at(11_490), // 8 天前，两个窗口都不含
    durationMs: 120_000,
    exitCode: 0,
    ok: true,
    inputTokens: 8_000,
    outputTokens: 1_000,
  });
}
