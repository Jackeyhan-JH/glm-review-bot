/**
 * 状态网页 HTTP 测试（验收标准第 3 条）：只监听 127.0.0.1（随机端口）、
 * `/` 返回 200 且 HTML 无外部资源引用（review 链接除外）、`/api/status` 返回
 * JSON、POST 返回 405、未知路径 404，以及每个请求现场采集（数据变化可见）。
 * 连接走本机回环，不碰真实网络 / gh / claude。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixedClock } from '../../src/lib/clock.ts';
import { nullLogger } from '../../src/lib/log.ts';
import { collectStatus } from '../../src/status/collect.ts';
import { renderStatusHtml, startStatusServer, type StatusServer } from '../../src/status/server.ts';
import { enqueue } from '../../src/state/jobs.ts';
import { DEMO_NOW, openTmpStatus, seedDemoState, type TmpStatus } from './helpers.ts';

interface Harness {
  tmp: TmpStatus;
  server: StatusServer;
  base: string;
  stop(): Promise<void>;
}

async function startHarness(seed: boolean): Promise<Harness> {
  const tmp = openTmpStatus('glm-review-status-http');
  if (seed) seedDemoState(tmp.state);
  const server = await startStatusServer({
    db: tmp.state,
    clock: fixedClock(DEMO_NOW),
    pauseFile: tmp.pauseFile,
    port: 0,
    log: nullLogger,
  });
  return {
    tmp,
    server,
    base: `http://127.0.0.1:${server.port}`,
    async stop() {
      await server.close();
      tmp.cleanup();
    },
  };
}

test('服务只监听 127.0.0.1，端口为随机分配', async () => {
  const h = await startHarness(false);
  try {
    assert.equal(h.server.host, '127.0.0.1');
    assert.equal(h.server.port > 0, true);
    assert.equal(h.server.port < 65_536, true);
    // 回环地址可访问（绑定在别的地址上会连接失败）。
    const res = await fetch(`${h.base}/api/status`);
    assert.equal(res.status, 200);
  } finally {
    await h.stop();
  }
});

test('GET / 返回 200 与单页 HTML：内联 CSS、30 秒刷新、无外部资源引用', async () => {
  const h = await startHarness(true);
  try {
    const res = await fetch(`${h.base}/`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /^text\/html; charset=utf-8/);
    const html = await res.text();
    assert.match(html, /^<!doctype html>/);
    assert.ok(html.includes('<meta http-equiv="refresh" content="30">'), '应每 30 秒自动刷新');
    assert.ok(html.includes('<style>'), 'CSS 应内联');
    assert.ok(!html.includes('<script src'), '不应引用外部脚本');
    assert.ok(!html.includes('<link'), '不应引用外部样式');
    assert.ok(html.includes('prefers-color-scheme'), '深浅色应跟随系统');
    assert.ok(html.includes('GLM 审查机器人状态'));

    // 所有 http(s):// 引用只能是 review / PR 链接（github.com）。
    const urls = [...html.matchAll(/https?:\/\/[^"'<>\s)）]+/g)].map((m) => m[0]);
    assert.ok(urls.length > 0, '演示数据里应有 review 链接');
    for (const url of urls) {
      assert.match(
        url,
        /^https:\/\/github\.com\//,
        `出现了非 review/PR 链接的外部引用：${url}`,
      );
    }
  } finally {
    await h.stop();
  }
});

test('GET /?theme=dark|light 手动指定主题；默认跟随系统（无 data-theme）', async () => {
  const h = await startHarness(true);
  try {
    const dark = await (await fetch(`${h.base}/?theme=dark`)).text();
    assert.ok(dark.includes('<html lang="zh-CN" data-theme="dark">'));
    const light = await (await fetch(`${h.base}/?theme=light`)).text();
    assert.ok(light.includes('<html lang="zh-CN" data-theme="light">'));
    const auto = await (await fetch(`${h.base}/`)).text();
    assert.ok(auto.includes('<html lang="zh-CN">'));
  } finally {
    await h.stop();
  }
});

test('GET /api/status 返回 200 与可解析的 JSON 快照', async () => {
  const h = await startHarness(true);
  try {
    const res = await fetch(`${h.base}/api/status`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /^application\/json; charset=utf-8/);
    const snapshot = (await res.json()) as ReturnType<typeof collectStatus>;
    assert.equal(snapshot.generatedAt, DEMO_NOW.toISOString());
    assert.deepEqual(snapshot.jobs, {
      queued: 1,
      deferred: 1,
      running: 1,
      done: 2,
      failed: 1,
      skipped: 1,
    });
    assert.equal(snapshot.usage.today.calls, 3);
    assert.equal(snapshot.heartbeat.present, true);
    assert.equal(snapshot.peak.isPeak, true);
    assert.equal(snapshot.paused, false);
  } finally {
    await h.stop();
  }
});

test('POST / 返回 405 并带 Allow 头；PUT /api/status 同样 405', async () => {
  const h = await startHarness(false);
  try {
    const post = await fetch(`${h.base}/`, { method: 'POST' });
    assert.equal(post.status, 405);
    assert.equal(post.headers.get('allow'), 'GET, HEAD');
    assert.match(await post.text(), /只读状态页，不提供修改操作/);

    const put = await fetch(`${h.base}/api/status`, { method: 'PUT', body: '{}' });
    assert.equal(put.status, 405);
  } finally {
    await h.stop();
  }
});

test('未知路径返回 404；HEAD / 返回 200', async () => {
  const h = await startHarness(false);
  try {
    const missing = await fetch(`${h.base}/nope`);
    assert.equal(missing.status, 404);
    assert.match(await missing.text(), /未找到/);

    const head = await fetch(`${h.base}/`, { method: 'HEAD' });
    assert.equal(head.status, 200);
  } finally {
    await h.stop();
  }
});

test('每个请求现场采集：入库新任务后立刻可见', async () => {
  const h = await startHarness(true);
  try {
    const before = (await (await fetch(`${h.base}/api/status`)).json()) as ReturnType<
      typeof collectStatus
    >;
    assert.equal(before.jobs.queued, 1);

    enqueue(h.tmp.state, {
      repo: 'Jackeyhan-JH/glm-peak-clock',
      pr: 3,
      headSha: 'b'.repeat(40),
      now: DEMO_NOW,
    });
    const after = (await (await fetch(`${h.base}/api/status`)).json()) as ReturnType<
      typeof collectStatus
    >;
    assert.equal(after.jobs.queued, 2);
    assert.equal(after.queue.length, 4);
  } finally {
    await h.stop();
  }
});

test('close() 后连接关闭且可重复调用', async () => {
  const h = await startHarness(false);
  await h.server.close();
  await h.server.close(); // 幂等
  await assert.rejects(() => fetch(`${h.base}/api/status`));
  h.tmp.cleanup();
});

test('renderStatusHtml 转义动态文本', () => {
  const tmp = openTmpStatus();
  try {
    enqueue(tmp.state, {
      repo: 'Jackeyhan-JH/glm-toolbox',
      pr: 1,
      headSha: 'c'.repeat(40),
      now: DEMO_NOW,
    });
    // 直接改库，塞进带 HTML 的 reason（正常流程不会出现，防注入兜底验证）。
    tmp.state.sqlite
      .prepare("UPDATE jobs SET reason = '<script>alert(1)</script>' WHERE pr = 1")
      .run();
    const snapshot = collectStatus(tmp.state, DEMO_NOW, { pauseFile: tmp.pauseFile });
    const html = renderStatusHtml(snapshot);
    assert.ok(!html.includes('<script>alert'), '动态文本必须被转义');
    assert.ok(html.includes('&lt;script&gt;'));
  } finally {
    tmp.cleanup();
  }
});
