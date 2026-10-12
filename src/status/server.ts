/**
 * 本机状态网页（#14）：node:http 服务，**只监听 127.0.0.1**（不对外）。
 *
 * - `GET /`          单页 HTML：内联 CSS、无外部资源、每 30 秒自动刷新、
 *                    浅色/深色跟随系统（`?theme=light|dark` 可手动指定，供截图/演示）；
 * - `GET /api/status` 当前状态快照（JSON，每个请求现场采集）；
 * - 其他路径 404；非 GET/HEAD 一律 405——本服务只读，不提供任何修改操作。
 *
 * 动态文本全部经 escapeHtml 转义；颜色按角色取自 CSS 变量（状态色固定，
 * 深色模式的取值单独挑选，不是简单反转）。
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Clock } from '../lib/clock.ts';
import { nullLogger, type Logger } from '../lib/log.ts';
import type { StateDb } from '../state/db.ts';
import {
  collectStatus,
  formatWallTime,
  STATUS_DISPLAY_ZONES,
  type CollectOptions,
  type StatusSnapshot,
} from './collect.ts';
import { formatDuration } from './render-text.ts';

export interface StatusServerOptions extends CollectOptions {
  db: StateDb;
  clock: Clock;
  /** 监听端口；默认 0 = 随机端口（测试用），命令层会传入配置的 statusPort。 */
  port?: number;
  log?: Logger;
}

export interface StatusServer {
  /** 监听地址，恒为 127.0.0.1。 */
  host: string;
  /** 实际监听端口（port=0 时是系统分配的随机端口）。 */
  port: number;
  /** 停止服务并断开所有连接；可重复调用。 */
  close(): Promise<void>;
}

/** HTML 转义（属性与文本共用：& < > " '）。 */
function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/** 表格单元格文本：错误信息可能带换行，折叠成一行。 */
function cellText(text: string | null | undefined): string {
  const flat = (text ?? '').replace(/\s+/g, ' ').trim();
  return flat === '' ? '—' : escapeHtml(flat);
}

const STATUS_STYLE = `
:root {
  color-scheme: light;
  --page: #f9f9f7;
  --surface: #fcfcfb;
  --ink: #0b0b0b;
  --ink-2: #52514e;
  --muted: #898781;
  --hairline: #e1e0d9;
  --ring: rgba(11, 11, 11, 0.10);
  --link: #2a78d6;
  --good: #0ca30c;
  --warning: #fab219;
  --serious: #ec835a;
  --critical: #d03b3b;
}
@media (prefers-color-scheme: dark) {
  :root:where(:not([data-theme="light"])) {
    color-scheme: dark;
    --page: #0d0d0d;
    --surface: #1a1a19;
    --ink: #ffffff;
    --ink-2: #c3c2b7;
    --hairline: #2c2c2a;
    --ring: rgba(255, 255, 255, 0.10);
    --link: #3987e5;
  }
}
:root[data-theme="dark"] {
  color-scheme: dark;
  --page: #0d0d0d;
  --surface: #1a1a19;
  --ink: #ffffff;
  --ink-2: #c3c2b7;
  --hairline: #2c2c2a;
  --ring: rgba(255, 255, 255, 0.10);
  --link: #3987e5;
}
* { box-sizing: border-box; }
body {
  margin: 0;
  padding: 24px 20px 48px;
  background: var(--page);
  color: var(--ink);
  font: 14px/1.6 system-ui, -apple-system, "Segoe UI", sans-serif;
}
main { max-width: 980px; margin: 0 auto; }
h1 { font-size: 20px; margin: 0 0 4px; }
h2 { font-size: 15px; margin: 28px 0 10px; color: var(--ink-2); }
.meta { margin: 0; color: var(--muted); font-size: 12.5px; }
.theme-nav { margin: 8px 0 0; font-size: 12.5px; color: var(--muted); }
.theme-nav a, a { color: var(--link); }
a { text-underline-offset: 2px; }
.cards {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(210px, 1fr));
  gap: 12px;
  margin-top: 16px;
}
.card {
  background: var(--surface);
  border: 1px solid var(--ring);
  border-radius: 8px;
  padding: 12px 14px;
}
.card .label { color: var(--ink-2); font-size: 12.5px; }
.card .value { font-size: 15px; margin-top: 2px; overflow-wrap: anywhere; }
.badge {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-weight: 600;
  white-space: nowrap;
}
.badge .dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--muted);
  flex: none;
}
.badge.good .dot { background: var(--good); }
.badge.warning .dot { background: var(--warning); }
.badge.serious .dot { background: var(--serious); }
.badge.critical .dot { background: var(--critical); }
.tiles {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
  gap: 12px;
  margin-top: 12px;
}
.tile {
  background: var(--surface);
  border: 1px solid var(--ring);
  border-radius: 8px;
  padding: 12px 14px;
}
.tile .figure { font-size: 26px; line-height: 1.2; margin-top: 2px; }
table {
  width: 100%;
  border-collapse: collapse;
  background: var(--surface);
  border: 1px solid var(--ring);
  border-radius: 8px;
  overflow: hidden;
  font-size: 13px;
}
th, td { padding: 7px 10px; text-align: left; vertical-align: top; }
thead th {
  color: var(--muted);
  font-weight: 600;
  font-size: 12px;
  border-bottom: 1px solid var(--hairline);
  white-space: nowrap;
}
tbody tr + tr { border-top: 1px solid var(--hairline); }
td.num { font-variant-numeric: tabular-nums; }
td.sha, td.mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
.empty { color: var(--muted); padding: 14px 10px; }
footer { margin-top: 32px; color: var(--muted); font-size: 12.5px; }
`;

const JOB_STATUS_LABEL: Record<string, string> = {
  queued: '排队',
  deferred: '延后',
  running: '进行中',
  done: '完成',
  failed: '失败',
  skipped: '跳过',
};

const OUTCOME_LABEL: Record<string, string> = {
  done: '成功',
  failed: '失败',
  skipped: '跳过',
};

function badge(tone: 'good' | 'warning' | 'serious' | 'critical' | 'neutral', label: string): string {
  return `<span class="badge ${tone}"><span class="dot"></span>${escapeHtml(label)}</span>`;
}

function daemonCard(snapshot: StatusSnapshot): string {
  const h = snapshot.heartbeat;
  const state = !h.present
    ? badge('neutral', '未运行或无心跳')
    : h.stale
      ? badge('serious', '心跳已过期')
      : badge('good', '运行中');
  const lines: string[] = [`<div class="card"><div class="label">守护进程</div><div class="value">${state}</div>`];
  if (h.present) {
    lines.push(
      `<div class="value">上次心跳：${escapeHtml(formatAgoShort(h.ageMs ?? 0))}` +
        `（过期阈值 3 × ${Math.round(h.staleAfterMs / 3000)} 秒）</div>`,
    );
    if (h.lastPollMs !== null) {
      lines.push(`<div class="value">上一轮轮询耗时：${escapeHtml(formatDuration(h.lastPollMs))}</div>`);
    }
    if (h.openPrs !== null) {
      const repos = Object.keys(h.openPrs);
      lines.push(
        `<div class="value">开放 PR：${
          repos.length > 0
            ? repos.map((repo) => `${escapeHtml(repo)} ${h.openPrs?.[repo] ?? 0}`).join('、')
            : '白名单内没有开放 PR'
        }</div>`,
      );
    }
  }
  lines.push('</div>');
  return lines.join('');
}

function peakCard(snapshot: StatusSnapshot): string {
  const p = snapshot.peak;
  const state = p.isPeak ? badge('warning', '高峰期（不调用 GLM）') : badge('good', '非高峰期');
  const direction = p.nextToPeak ? '进入高峰' : '回到非高峰';
  return `<div class="card"><div class="label">GLM 高峰</div><div class="value">${state}</div>` +
    `<div class="value">下一次切换（${escapeHtml(direction)}）：还有 ${escapeHtml(formatDuration(p.msUntilSwitch))}</div>` +
    `<div class="value">北京时间 ${escapeHtml(p.nextSwitchBeijing)} · 美东 ${escapeHtml(p.nextSwitchNewYork)}</div></div>`;
}

function pauseCard(snapshot: StatusSnapshot): string {
  const state = snapshot.paused ? badge('critical', '已暂停') : badge('good', '未暂停');
  return `<div class="card"><div class="label">额度暂停</div><div class="value">${state}</div>` +
    `<div class="value">${escapeHtml(snapshot.pauseFile)} ${snapshot.paused ? '存在，任务保持排队' : '不存在'}</div></div>`;
}

/** 相对时长短语（HTML 侧）。 */
function formatAgoShort(ms: number): string {
  const seconds = Math.floor(Math.max(0, ms) / 1000);
  if (seconds < 60) return `${seconds} 秒前`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时 ${minutes % 60} 分前`;
  return `${Math.floor(hours / 24)} 天前`;
}

function tiles(snapshot: StatusSnapshot): string {
  const order: Array<[string, keyof StatusSnapshot['jobs']]> = [
    ['排队', 'queued'],
    ['延后', 'deferred'],
    ['进行中', 'running'],
    ['完成', 'done'],
    ['失败', 'failed'],
    ['跳过', 'skipped'],
  ];
  return order
    .map(([label, key]) => `<div class="tile"><div class="label">${label}</div><div class="figure">${snapshot.jobs[key]}</div></div>`)
    .join('');
}

function queueTable(snapshot: StatusSnapshot): string {
  const rows = snapshot.queue
    .map(
      (entry) => `<tr>` +
        `<td>${escapeHtml(entry.repo)}</td>` +
        `<td class="num">#${entry.pr}</td>` +
        `<td>${escapeHtml(JOB_STATUS_LABEL[entry.status] ?? entry.status)}</td>` +
        `<td>${escapeHtml(formatWallTime(new Date(entry.notBefore), STATUS_DISPLAY_ZONES.beijing))}</td>` +
        `<td>${entry.waitMs <= 0 ? '已可执行' : escapeHtml(formatDuration(entry.waitMs))}</td>` +
        `<td class="num">${entry.attempts}</td>` +
        `<td>${cellText(entry.reason)}</td></tr>`,
    )
    .join('');
  return `<table><thead><tr><th>仓库</th><th>PR</th><th>状态</th><th>可执行时间（北京时间）</th><th>还需等待</th><th>尝试</th><th>原因</th></tr></thead>` +
    (rows === ''
      ? `<tbody><tr><td colspan="7" class="empty">等待队列为空</td></tr></tbody>`
      : `<tbody>${rows}</tbody>`) +
    `</table>`;
}

function reviewTable(snapshot: StatusSnapshot): string {
  const rows = snapshot.recentReviews
    .map((r) => {
      const link =
        r.reviewUrl !== null
          ? `<a href="${escapeHtml(r.reviewUrl)}" rel="noopener noreferrer">review</a>`
          : cellText(r.reason);
      return (
        `<tr>` +
        `<td>${escapeHtml(r.repo)}</td>` +
        `<td class="num">#${r.pr}</td>` +
        `<td class="sha">${escapeHtml(r.shortSha)}</td>` +
        `<td>${escapeHtml(OUTCOME_LABEL[r.outcome] ?? r.outcome)}</td>` +
        `<td class="num">${r.findingsCount === null ? '—' : r.findingsCount}</td>` +
        `<td>${cellText(r.model)}</td>` +
        `<td class="num">${r.durationMs === null ? '—' : escapeHtml(formatDuration(r.durationMs))}</td>` +
        `<td>${link}</td></tr>`
      );
    })
    .join('');
  return `<table><thead><tr><th>仓库</th><th>PR</th><th>commit</th><th>结果</th><th>问题数</th><th>模型</th><th>耗时</th><th>review</th></tr></thead>` +
    (rows === ''
      ? `<tbody><tr><td colspan="8" class="empty">还没有审查记录</td></tr></tbody>`
      : `<tbody>${rows}</tbody>`) +
    `</table>`;
}

function usageSection(snapshot: StatusSnapshot): string {
  const usage = (s: StatusSnapshot['usage']['today']): string[] => [
    `${s.calls} 次调用（成功 ${s.okCalls} · 失败 ${s.calls - s.okCalls}）`,
    `输入 ${s.inputTokens.toLocaleString('zh-CN')} tokens · 输出 ${s.outputTokens.toLocaleString('zh-CN')} tokens`,
  ];
  const today = usage(snapshot.usage.today);
  const last7d = usage(snapshot.usage.last7d);
  const todayLabel = snapshot.generatedAtBeijing.split(' ').slice(0, 2).join(' ');
  return `<div class="cards">` +
    `<div class="card"><div class="label">今天（北京时间 ${escapeHtml(todayLabel)}）</div>` +
    `<div class="value">${escapeHtml(today[0])}</div><div class="value">${escapeHtml(today[1])}</div></div>` +
    `<div class="card"><div class="label">近 7 天</div>` +
    `<div class="value">${escapeHtml(last7d[0])}</div><div class="value">${escapeHtml(last7d[1])}</div></div>` +
    `</div>`;
}

/** 渲染单页状态 HTML。theme 为 null 时跟随系统，'light' / 'dark' 手动指定。 */
export function renderStatusHtml(snapshot: StatusSnapshot, theme: 'light' | 'dark' | null = null): string {
  const themeAttr = theme === null ? '' : ` data-theme="${theme}"`;
  return `<!doctype html>
<html lang="zh-CN"${themeAttr}>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="30">
<title>GLM 审查机器人状态</title>
<style>${STATUS_STYLE}</style>
</head>
<body>
<main>
<header>
<h1>GLM 审查机器人状态</h1>
<p class="meta">生成时间：北京时间 ${escapeHtml(snapshot.generatedAtBeijing)} · 美东 ${escapeHtml(snapshot.generatedAtNewYork)}（每 30 秒自动刷新）</p>
<p class="theme-nav">主题：<a href="/?theme=light">浅色</a> · <a href="/?theme=dark">深色</a> · <a href="/">跟随系统</a></p>
</header>
<div class="cards">
${daemonCard(snapshot)}
${peakCard(snapshot)}
${pauseCard(snapshot)}
</div>
<h2>任务统计</h2>
<div class="tiles">${tiles(snapshot)}</div>
<h2>等待队列（按可执行时间排序）</h2>
${queueTable(snapshot)}
<h2>最近审查（最多 20 条）</h2>
${reviewTable(snapshot)}
<h2>claude 用量</h2>
${usageSection(snapshot)}
<footer>只读状态页 · JSON 接口：<a href="/api/status">/api/status</a> · 只监听本机 127.0.0.1</footer>
</main>
</body>
</html>
`;
}

/**
 * 启动状态网页。resolve 时机是 listening 事件——拿到的是实际端口。
 * 每个请求现场 collectStatus，页面反映的是请求时刻的最新状态。
 */
export function startStatusServer(options: StatusServerOptions): Promise<StatusServer> {
  const { db, clock, log = nullLogger } = options;
  const server: Server = createServer((req, res) => {
    handleRequest(req, res, { db, clock, collect: options, log }).catch((err) => {
      const message = err instanceof Error ? err.message : String(err);
      log.error('状态页请求处理失败', { error: message });
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
      }
      res.end('状态采集失败。\n');
    });
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        server.close();
        reject(new Error('状态页监听地址异常'));
        return;
      }
      log.info('状态页已启动', { host: '127.0.0.1', port: address.port });
      let closed = false;
      resolve({
        host: '127.0.0.1',
        port: address.port,
        close(): Promise<void> {
          if (closed) return Promise.resolve();
          closed = true;
          return new Promise((done) => {
            server.close(() => done());
            server.closeAllConnections();
          });
        },
      });
    });
  });
}

interface RequestContext {
  db: StateDb;
  clock: Clock;
  collect: CollectOptions;
  log: Logger;
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RequestContext,
): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  const path = url.pathname;
  const method = (req.method ?? 'GET').toUpperCase();

  if (path !== '/' && path !== '/api/status') {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end('未找到：状态页只有 / 与 /api/status。\n');
    return;
  }
  if (method !== 'GET' && method !== 'HEAD') {
    res.writeHead(405, {
      'Content-Type': 'text/plain; charset=utf-8',
      Allow: 'GET, HEAD',
      'Cache-Control': 'no-store',
    });
    res.end('只读状态页，不提供修改操作。\n');
    return;
  }

  const snapshot = collectStatus(ctx.db, ctx.clock.now(), ctx.collect);
  ctx.log.debug('状态页请求', { path, method });

  if (path === '/api/status') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(snapshot));
    return;
  }
  const theme = url.searchParams.get('theme');
  const themeOverride = theme === 'light' || theme === 'dark' ? theme : null;
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(renderStatusHtml(snapshot, themeOverride));
}
