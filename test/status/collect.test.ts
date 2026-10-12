/**
 * collectStatus 的输出测试（验收标准第 1 条）：空库、有队列、有失败任务、
 * 心跳过期四种情况，外加用量窗口、暂停文件与高峰双时区字段。
 * 全部用假时钟（fixedClock），不碰真实网络 / gh / claude。
 */
import assert from 'node:assert/strict';
import { writeFileSync, rmSync } from 'node:fs';
import { test } from 'node:test';
import { fixedClock } from '../../src/lib/clock.ts';
import {
  collectStatus,
  META_DAEMON_HEARTBEAT_AT,
  META_DAEMON_LAST_POLL_MS,
  META_DAEMON_OPEN_PRS,
} from '../../src/status/collect.ts';
import { claimNext, enqueue, markFailed } from '../../src/state/jobs.ts';
import { DEMO_NOW, openTmpStatus, seedDemoState, setMeta, type TmpStatus } from './helpers.ts';

/** 收集时固定指向临时 pauseFile，避免读到真实机器上的 /workspace/GLM_PAUSE。 */
function options(t: TmpStatus): { pauseFile: string } {
  return { pauseFile: t.pauseFile };
}

test('空库：全部为零，守护进程显示未运行或无心跳', () => {
  const t = openTmpStatus();
  try {
    const snapshot = collectStatus(t.state, DEMO_NOW, options(t));
    assert.deepEqual(snapshot.jobs, {
      queued: 0,
      deferred: 0,
      running: 0,
      done: 0,
      failed: 0,
      skipped: 0,
    });
    assert.equal(snapshot.heartbeat.present, false);
    assert.equal(snapshot.heartbeat.lastAt, null);
    assert.equal(snapshot.heartbeat.ageMs, null);
    assert.equal(snapshot.heartbeat.stale, false);
    assert.equal(snapshot.heartbeat.staleAfterMs, 360_000); // 3 × 默认 120 秒
    assert.deepEqual(snapshot.queue, []);
    assert.deepEqual(snapshot.recentReviews, []);
    assert.deepEqual(snapshot.usage, {
      today: { calls: 0, okCalls: 0, inputTokens: 0, outputTokens: 0 },
      last7d: { calls: 0, okCalls: 0, inputTokens: 0, outputTokens: 0 },
    });
    assert.equal(snapshot.paused, false);
    assert.equal(snapshot.pauseFile, t.pauseFile);
  } finally {
    t.cleanup();
  }
});

test('空库：高峰与下一次切换按北京时间 / 美东双写', () => {
  const t = openTmpStatus();
  try {
    // 周一北京时间 15:30 = 高峰期，本段 18:00 结束（美东 06:00）。
    const snapshot = collectStatus(t.state, DEMO_NOW, options(t));
    assert.equal(snapshot.generatedAt, '2026-10-12T07:30:00.000Z');
    assert.equal(snapshot.peak.isPeak, true);
    assert.equal(snapshot.peak.nextToPeak, false);
    assert.equal(snapshot.peak.nextSwitchAt, '2026-10-12T10:00:00.000Z');
    assert.equal(snapshot.peak.nextSwitchBeijing, '10月12日 周一 18:00');
    assert.equal(snapshot.peak.nextSwitchNewYork, '10月12日 周一 06:00');
    assert.equal(snapshot.peak.msUntilSwitch, 2.5 * 60 * 60_000);
    assert.equal(snapshot.generatedAtBeijing, '10月12日 周一 15:30');
    assert.equal(snapshot.generatedAtNewYork, '10月12日 周一 03:30');

    // 非高峰时刻：下一个高峰是次日 14:00（北京时间），美东 02:00（夏令时）。
    const offPeak = collectStatus(t.state, new Date('2026-10-13T02:00:00Z'), options(t));
    assert.equal(offPeak.peak.isPeak, false);
    assert.equal(offPeak.peak.nextToPeak, true);
    assert.equal(offPeak.peak.nextSwitchAt, '2026-10-13T06:00:00.000Z');
    assert.equal(offPeak.peak.nextSwitchBeijing, '10月13日 周二 14:00');
    assert.equal(offPeak.peak.nextSwitchNewYork, '10月13日 周二 02:00');
  } finally {
    t.cleanup();
  }
});

test('有队列：queued / deferred / running 各就各位，按可执行时间排序并带原因', () => {
  const t = openTmpStatus();
  try {
    seedDemoState(t.state);
    const snapshot = collectStatus(t.state, DEMO_NOW, options(t));

    assert.deepEqual(snapshot.jobs, {
      queued: 1,
      deferred: 1,
      running: 1,
      done: 2,
      failed: 1,
      skipped: 1,
    });
    // 排序：running（not_before 最早）→ 重试任务 → 高峰延后任务。
    assert.deepEqual(
      snapshot.queue.map((entry) => `${entry.repo}#${entry.pr}:${entry.status}`),
      [
        'Jackeyhan-JH/glm-toolbox#25:running',
        'Jackeyhan-JH/split-bill#9:queued',
        'Jackeyhan-JH/glm-toolbox#24:deferred',
      ],
    );
    const [running, retry, deferred] = snapshot.queue;
    assert.equal(running.shortSha.length, 7);
    assert.equal(running.waitMs <= 0, true);
    assert.equal(running.attempts, 1);
    assert.equal(retry.reason, 'gh 请求被限流（HTTP 403）');
    assert.equal(retry.attempts, 1);
    assert.equal(retry.waitMs <= 0, true);
    assert.equal(deferred.reason, 'peak');
    assert.equal(deferred.notBefore, '2026-10-12T10:00:00.000Z');
    assert.equal(deferred.waitMs, 2.5 * 60 * 60_000);
  } finally {
    t.cleanup();
  }
});

test('有失败任务：终态 failed 进最近审查，结果与原因齐全', () => {
  const t = openTmpStatus();
  try {
    seedDemoState(t.state);
    const snapshot = collectStatus(t.state, DEMO_NOW, options(t));

    assert.equal(snapshot.jobs.failed, 1);
    const failed = snapshot.recentReviews.find((r) => r.outcome === 'failed');
    assert.notEqual(failed, undefined);
    assert.equal(failed?.repo, 'Jackeyhan-JH/glm-night-shift');
    assert.equal(failed?.pr, 5);
    assert.equal(failed?.shortSha.length, 7);
    assert.equal(failed?.reason, 'claude 退出码 124：调用超时');
    assert.equal(failed?.reviewUrl, null);
    assert.equal(failed?.findingsCount, null);

    // 成功的审查带 review 链接 / 问题数 / 模型 / 耗时，按结束时间倒序。
    const done = snapshot.recentReviews.filter((r) => r.outcome === 'done');
    assert.equal(done.length, 2);
    assert.equal(done[0]?.repo, 'Jackeyhan-JH/glm-toolbox'); // now-37m 结束，最新
    assert.equal(done[0]?.reviewUrl, 'https://github.com/Jackeyhan-JH/glm-toolbox/pull/23#pullrequestreview-2405112601');
    assert.equal(done[0]?.findingsCount, 3);
    assert.equal(done[0]?.model, 'glm-5.3-flash');
    assert.equal(done[0]?.durationMs, 3 * 60_000);
    assert.equal(done[1]?.durationMs, 15 * 60_000);

    // 跳过的审查也在列表里。
    assert.equal(snapshot.recentReviews.some((r) => r.outcome === 'skipped' && r.reason === 'superseded'), true);
  } finally {
    t.cleanup();
  }
});

test('心跳过期：超过 3 个轮询间隔判 stale，新鲜心跳不判', () => {
  const t = openTmpStatus();
  try {
    // pollIntervalSec=120 → 阈值 360 秒；400 秒未更新 = 过期。
    setMeta(t.state, META_DAEMON_HEARTBEAT_AT, new Date(DEMO_NOW.getTime() - 400_000).toISOString());
    setMeta(t.state, META_DAEMON_LAST_POLL_MS, '4200');
    setMeta(t.state, META_DAEMON_OPEN_PRS, '{"Jackeyhan-JH/glm-toolbox":2}');
    const stale = collectStatus(t.state, DEMO_NOW, { ...options(t), pollIntervalSec: 120 });
    assert.equal(stale.heartbeat.present, true);
    assert.equal(stale.heartbeat.ageMs, 400_000);
    assert.equal(stale.heartbeat.stale, true);
    assert.equal(stale.heartbeat.staleAfterMs, 360_000);
    assert.equal(stale.heartbeat.lastPollMs, 4200);
    assert.deepEqual(stale.heartbeat.openPrs, { 'Jackeyhan-JH/glm-toolbox': 2 });

    // 10 秒前的心跳：运行中。
    setMeta(t.state, META_DAEMON_HEARTBEAT_AT, new Date(DEMO_NOW.getTime() - 10_000).toISOString());
    const fresh = collectStatus(t.state, DEMO_NOW, { ...options(t), pollIntervalSec: 120 });
    assert.equal(fresh.heartbeat.present, true);
    assert.equal(fresh.heartbeat.ageMs, 10_000);
    assert.equal(fresh.heartbeat.stale, false);

    // 轮询间隔不同，过期阈值跟着变（3 × 60 秒 = 180 秒）。
    const tight = collectStatus(t.state, DEMO_NOW, { ...options(t), pollIntervalSec: 60 });
    assert.equal(tight.heartbeat.staleAfterMs, 180_000);
    assert.equal(tight.heartbeat.stale, false); // 10 秒 < 180 秒
  } finally {
    t.cleanup();
  }
});

test('心跳取值损坏时容忍：当作没有心跳', () => {
  const t = openTmpStatus();
  try {
    setMeta(t.state, META_DAEMON_HEARTBEAT_AT, 'not-a-date');
    setMeta(t.state, META_DAEMON_LAST_POLL_MS, 'fast');
    setMeta(t.state, META_DAEMON_OPEN_PRS, '{broken json');
    const snapshot = collectStatus(t.state, DEMO_NOW, options(t));
    assert.equal(snapshot.heartbeat.present, false);
    assert.equal(snapshot.heartbeat.lastAt, null);
    assert.equal(snapshot.heartbeat.lastPollMs, null);
    assert.equal(snapshot.heartbeat.openPrs, null);
  } finally {
    t.cleanup();
  }
});

test('用量窗口：今天按北京时间日历日，近 7 天为滚动窗口', () => {
  const t = openTmpStatus();
  try {
    seedDemoState(t.state);
    const snapshot = collectStatus(t.state, DEMO_NOW, options(t));
    // 今天（北京时间周一，自 2026-10-11T16:00Z 起）：04:30 / 03:00 / 前一天 20:00 三条。
    assert.deepEqual(snapshot.usage.today, {
      calls: 3,
      okCalls: 2,
      inputTokens: 57_500,
      outputTokens: 11_400,
    });
    // 近 7 天：再加周日 05:00 那条；8 天前的不算。
    assert.deepEqual(snapshot.usage.last7d, {
      calls: 4,
      okCalls: 3,
      inputTokens: 87_500,
      outputTokens: 16_400,
    });
  } finally {
    t.cleanup();
  }
});

test('额度暂停：pauseFile 存在时 paused=true', () => {
  const t = openTmpStatus();
  try {
    const before = collectStatus(t.state, DEMO_NOW, options(t));
    assert.equal(before.paused, false);

    writeFileSync(t.pauseFile, '');
    const after = collectStatus(t.state, DEMO_NOW, options(t));
    assert.equal(after.paused, true);

    rmSync(t.pauseFile);
    const removed = collectStatus(t.state, DEMO_NOW, options(t));
    assert.equal(removed.paused, false);
  } finally {
    t.cleanup();
  }
});

test('队列与最近审查条数受 limit 限制', () => {
  const t = openTmpStatus();
  try {
    seedDemoState(t.state);
    const snapshot = collectStatus(t.state, DEMO_NOW, { ...options(t), queueLimit: 1, reviewLimit: 2 });
    assert.equal(snapshot.queue.length, 1);
    assert.equal(snapshot.recentReviews.length, 2);
  } finally {
    t.cleanup();
  }
});

test('collectStatus 不依赖系统时钟：同一库 + 同一时刻结果一致', () => {
  const t = openTmpStatus();
  try {
    seedDemoState(t.state);
    const clock = fixedClock(DEMO_NOW);
    const first = collectStatus(t.state, clock.now(), options(t));
    const second = collectStatus(t.state, clock.now(), options(t));
    assert.deepEqual(first, second);
  } finally {
    t.cleanup();
  }
});

test('markFailed 的重试任务在队列里，终态任务不重复出现', () => {
  const t = openTmpStatus();
  try {
    const job = enqueue(t.state, {
      repo: 'Jackeyhan-JH/glm-toolbox',
      pr: 30,
      headSha: 'a'.repeat(40),
      now: new Date(DEMO_NOW.getTime() - 60_000),
    }).job;
    claimNext(t.state, new Date(DEMO_NOW.getTime() - 30_000));
    markFailed(t.state, job.id, '临时错误', {
      now: new Date(DEMO_NOW.getTime() - 20_000),
      retryAt: new Date(DEMO_NOW.getTime() + 40_000),
    });
    const snapshot = collectStatus(t.state, DEMO_NOW, options(t));
    assert.equal(snapshot.jobs.queued, 1);
    assert.equal(snapshot.queue.length, 1);
    assert.equal(snapshot.queue[0]?.waitMs, 40_000);
    assert.deepEqual(snapshot.recentReviews, []);
  } finally {
    t.cleanup();
  }
});
