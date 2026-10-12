/**
 * #11 流水线测试：假 gh + 假 git + 假 claude + 临时状态库，覆盖验收标准里的
 * 正常审查 / 去重（状态库与 PR 标记）/ 高峰排队 / 暂停 / 块失败重试 / 三种跳过 /
 * dry-run / --force。全部不碰真实网络与真实命令。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { botMarker } from '../../src/github/reviews.ts';
import { listCalls } from '../../src/state/calls.ts';
import { getJob, listJobs } from '../../src/state/jobs.ts';
import {
  createWorld,
  HEAD_SHA,
  OTHER_SHA,
  PEAK_AT,
  REPO,
  REVIEW_URL,
} from './helpers.ts';

test('端到端：正常审查一次 → POST 一条 review（含标记与行内评论）、calls 记账、任务 done', async () => {
  const w = createWorld();
  try {
    const outcome = await w.run();
    assert.equal(outcome.status, 'reviewed');
    assert.equal(outcome.url, REVIEW_URL);
    assert.equal(outcome.findingsCount, 2);
    assert.equal(outcome.model, 'glm-5.3-flash'); // 6 行改动 ≤ 300 → 小模型
    assert.equal(outcome.chunks, 1);
    assert.ok(outcome.durationMs >= 0);

    // 假 gh 收到一次 POST …/reviews，正文含去重标记与行内评论
    const posts = w.postCalls();
    assert.equal(posts.length, 1);
    const payload = JSON.parse(posts[0]?.stdin ?? '') as Record<string, unknown>;
    assert.equal(payload.commit_id, HEAD_SHA);
    assert.equal(payload.event, 'COMMENT');
    assert.ok(String(payload.body).includes(botMarker(HEAD_SHA)));
    const comments = payload.comments as Array<Record<string, unknown>>;
    assert.equal(comments.length, 2);
    assert.equal(comments[0]?.path, 'src/calc.ts');
    assert.equal(comments[0]?.side, 'RIGHT');

    // claude：只读工具、只读检出目录、提示词带 diff 与 PR 描述
    const claude = w.claudeCalls();
    assert.equal(claude.length, 1);
    assert.ok(claude[0]?.argv.includes('Read'));
    assert.ok(claude[0]?.argv.includes('Grep') && claude[0]?.argv.includes('Glob'));
    assert.ok(claude[0]?.cwd.includes(HEAD_SHA.slice(0, 7)));
    assert.ok(claude[0]?.stdin.includes('### 文件: src/calc.ts'));
    assert.ok(claude[0]?.stdin.includes('支持多币种分账'));

    // calls 表有对应记录
    const calls = listCalls(w.state);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.ok, true);
    assert.equal(calls[0]?.model, 'glm-5.3-flash');
    assert.equal(calls[0]?.chunkIndex, 0);
    assert.equal(calls[0]?.inputTokens, 120);
    assert.equal(calls[0]?.outputTokens, 80);
    assert.equal(calls[0]?.repo, REPO);
    assert.equal(calls[0]?.peak, false);

    // 任务 done，记录 review 地址、问题数与模型
    const job = getJob(w.state, outcome.jobId);
    assert.equal(job.status, 'done');
    assert.equal(job.reviewUrl, REVIEW_URL);
    assert.equal(job.findingsCount, 2);
    assert.equal(job.model, 'glm-5.3-flash');
    assert.ok(job.finishedAt !== null);

    // 阶段进度有输出
    assert.ok(w.progressLines().some((line) => line.includes('获取 PR')));
  } finally {
    w.cleanup();
  }
});

test('同一 sha 再跑 → already-reviewed，不再调用 claude', async () => {
  const w = createWorld();
  try {
    const first = await w.run();
    assert.equal(first.status, 'reviewed');
    const claudeAfterFirst = w.claudeCalls().length;
    const postsAfterFirst = w.postCalls().length;

    const second = await w.run();
    assert.equal(second.status, 'already-reviewed');
    assert.equal(second.source, 'state');
    assert.equal(w.claudeCalls().length, claudeAfterFirst);
    assert.equal(w.postCalls().length, postsAfterFirst);
    assert.equal(listJobs(w.state).length, 1); // 同键只有一行任务
  } finally {
    w.cleanup();
  }
});

test('状态库清空后再跑 → 通过 PR 上的标记仍判定已审（并恢复去重键）', async () => {
  // 第一段：正常审一次（此时 PR 上没有标记，fake 返回空 review 列表）。
  const first = createWorld();
  try {
    const outcome = await first.run();
    assert.equal(outcome.status, 'reviewed');
    assert.equal(first.postCalls().length, 1);
  } finally {
    first.cleanup();
  }

  // 第二段：全新状态库（= 清空）+ PR 上已有本 SHA 的标记 review → 已审。
  const markedReviews = [
    {
      id: 9,
      body: `## 🤖 GLM 代码审查\n未发现需要处理的问题 ✅\n${botMarker(HEAD_SHA)}`,
      commit_id: HEAD_SHA,
      submitted_at: '2026-10-10T00:00:00Z',
      user: { login: 'glm-review-bot' },
    },
  ];
  const second = createWorld({ reviews: markedReviews });
  try {
    const outcome = await second.run();
    assert.equal(outcome.status, 'already-reviewed');
    assert.equal(outcome.source, 'marker');
    assert.equal(second.claudeCalls().length, 0);
    assert.equal(second.postCalls().length, 0);
    // 去重键被恢复：任务行记为 skipped，之后靠状态库判断
    const job = getJob(second.state, outcome.jobId);
    assert.equal(job.status, 'skipped');
    assert.equal(job.reason, 'already-reviewed');
  } finally {
    second.cleanup();
  }
});

test('高峰期（2026-10-12T07:00:00Z）→ 不调用 claude，任务 deferred，not_before = 峰后', async () => {
  const w = createWorld({ clockAt: PEAK_AT });
  try {
    const outcome = await w.run();
    assert.equal(outcome.status, 'deferred');
    // 北京 15:00 → 本段高峰 18:00（北京）结束 = 10:00Z
    assert.equal(outcome.until, '2026-10-12T10:00:00.000Z');
    const job = getJob(w.state, outcome.jobId);
    assert.equal(job.status, 'deferred');
    assert.equal(job.notBefore, '2026-10-12T10:00:00.000Z');
    assert.equal(job.reason, 'peak');
    assert.equal(w.claudeCalls().length, 0);
    assert.equal(w.postCalls().length, 0);
  } finally {
    w.cleanup();
  }
});

test('GLM_PAUSE 存在 → waiting: paused，不调用 claude，任务保持排队', async () => {
  const w = createWorld({ paused: true });
  try {
    const outcome = await w.run();
    assert.equal(outcome.status, 'waiting');
    assert.equal(outcome.reason, 'paused');
    assert.ok(outcome.detail.includes('GLM_PAUSE'));
    assert.equal(w.claudeCalls().length, 0);
    const job = getJob(w.state, outcome.jobId);
    assert.equal(job.status, 'queued');
  } finally {
    w.cleanup();
  }
});

test('一块 claude 持续失败 → 不发 review，任务按重试策略回到 queued，失败调用也记账', async () => {
  const w = createWorld({ claude: { code: 1, stderr: 'Error: service unavailable (503), overloaded' } });
  try {
    const outcome = await w.run();
    assert.equal(outcome.status, 'failed');
    assert.equal(outcome.requeued, true);
    assert.ok(outcome.error.includes('claude'));

    // 不发半截 review
    assert.equal(w.postCalls().length, 0);

    // 任务回到 queued（未达重试上限），原因记录错误信息
    const job = getJob(w.state, outcome.jobId);
    assert.equal(job.status, 'queued');
    assert.ok(job.reason !== null && job.reason.includes('claude'));

    // 就地重试（默认 2 次）每次都进了账本
    const calls = listCalls(w.state);
    assert.equal(calls.length, 2);
    assert.ok(calls.every((call) => !call.ok));
    assert.equal(w.claudeCalls().length, 2);
  } finally {
    w.cleanup();
  }
});

test('仓库配置 enabled: false → skipped: disabled，不调用 claude', async () => {
  const w = createWorld({ repoConfigYaml: 'enabled: false\n' });
  try {
    const outcome = await w.run();
    assert.equal(outcome.status, 'skipped');
    assert.equal(outcome.reason, 'disabled');
    assert.equal(w.claudeCalls().length, 0);
    assert.equal(w.postCalls().length, 0);
    const job = getJob(w.state, outcome.jobId);
    assert.equal(job.status, 'skipped');
    assert.equal(job.reason, 'disabled');
  } finally {
    w.cleanup();
  }
});

test('全部文件被忽略 → skipped: no-reviewable-changes，不发评论', async () => {
  const w = createWorld({ repoConfigYaml: 'ignore:\n  - "src/**"\n' });
  try {
    const outcome = await w.run();
    assert.equal(outcome.status, 'skipped');
    assert.equal(outcome.reason, 'no-reviewable-changes');
    assert.equal(w.claudeCalls().length, 0);
    assert.equal(w.postCalls().length, 0);
    const job = getJob(w.state, outcome.jobId);
    assert.equal(job.status, 'skipped');
    assert.equal(job.reason, 'no-reviewable-changes');
  } finally {
    w.cleanup();
  }
});

test('head 已变化（传入 headSha 与当前不同）→ superseded，只取了 PR 信息', async () => {
  const w = createWorld();
  try {
    const outcome = await w.run({ headSha: OTHER_SHA });
    assert.equal(outcome.status, 'superseded');
    assert.equal(outcome.expected, OTHER_SHA);
    assert.equal(outcome.current, HEAD_SHA);
    assert.equal(w.claudeCalls().length, 0);
    assert.equal(w.postCalls().length, 0);
    // 只发生了一次 gh 调用（pr view），没有入队也没有后续阶段
    assert.equal(w.fake.calls().filter((call) => call.bin === 'gh').length, 1);
    assert.equal(listJobs(w.state).length, 0);
  } finally {
    w.cleanup();
  }
});

test('dry-run → 不 POST、不标记 done、输出预览（含标记），claude 调用照常记账', async () => {
  const w = createWorld();
  try {
    const outcome = await w.run({ dryRun: true });
    assert.equal(outcome.status, 'reviewed');
    assert.equal(outcome.dryRun, true);
    assert.equal(outcome.url, undefined);
    assert.equal(outcome.findingsCount, 2);

    assert.equal(w.postCalls().length, 0);
    assert.ok(w.previewOut().includes('dry-run'));
    assert.ok(w.previewOut().includes(botMarker(HEAD_SHA)));
    assert.ok(w.previewOut().includes('src/calc.ts'));

    // 预览不该占用「审过」去重键：任务仍 queued，再跑（非 dry-run）会真正发布
    const job = getJob(w.state, outcome.jobId);
    assert.equal(job.status, 'queued');
    const second = await w.run();
    assert.equal(second.status, 'reviewed');
    assert.equal(w.postCalls().length, 1);
    // 真实发生的模型调用照常记账
    assert.equal(listCalls(w.state).length, 2);
  } finally {
    w.cleanup();
  }
});

test('force → 同一 sha 已审过也重审，再次 POST', async () => {
  const w = createWorld();
  try {
    const first = await w.run();
    assert.equal(first.status, 'reviewed');
    const second = await w.run({ force: true });
    assert.equal(second.status, 'reviewed');
    assert.equal(w.postCalls().length, 2);
    assert.equal(w.claudeCalls().length, 2);
    assert.equal(listJobs(w.state).length, 1); // 仍是同一行任务
  } finally {
    w.cleanup();
  }
});

test('大模型选择：改动行数超过 smallDiffLines 时用 large 模型', async () => {
  // 阈值降到 5：样例 diff 6 行改动 → 走大模型。
  const w = createWorld({ configExtra: ['models:', '  smallDiffLines: 5'] });
  try {
    const outcome = await w.run();
    assert.equal(outcome.status, 'reviewed');
    assert.equal(outcome.model, 'glm-5.3');
    assert.ok(w.claudeCalls()[0]?.argv.includes('glm-5.3'));
  } finally {
    w.cleanup();
  }
});

test('仓库配置 focus 进入提示词，渲染后的 diff 进入提示词', async () => {
  const world = createWorld({ repoConfigYaml: 'focus: 重点看错误处理\n' });
  try {
    const outcome = await world.run();
    assert.equal(outcome.status, 'reviewed');
    const stdin = world.claudeCalls()[0]?.stdin ?? '';
    assert.ok(stdin.includes('重点看错误处理'));
    assert.ok(stdin.includes('export function add'));
    assert.ok(stdin.includes('@@ -0,0 +1,6 @@')); // hunk 头保留
  } finally {
    world.cleanup();
  }
});
