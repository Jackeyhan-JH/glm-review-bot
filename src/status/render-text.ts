/**
 * 终端文本渲染（#14）：把 collectStatus 的快照排成中文、对齐的状态文本。
 * 对齐按显示宽度计算（CJK 字符占 2 列），中文内容也能对得齐。
 */
import { formatWallTime, STATUS_DISPLAY_ZONES, type StatusSnapshot, type UsageSummary } from './collect.ts';

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

/** 表格里原因一列的最大显示宽度，超出截断（错误信息可能很长）。 */
const REASON_MAX_COLS = 40;

const numberFormat = new Intl.NumberFormat('zh-CN');

/** CJK 等双宽字符按 2 列计的显示宽度。 */
export function displayWidth(text: string): number {
  let width = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    const wide =
      (code >= 0x1100 && code <= 0x115f) || // 谚文字母
      (code >= 0x2e80 && code <= 0xa4cf) || // CJK 部首、符号、假名等
      (code >= 0xac00 && code <= 0xd7a3) || // 谚文音节
      (code >= 0xf900 && code <= 0xfaff) || // CJK 兼容表意
      (code >= 0xfe30 && code <= 0xfe4f) || // CJK 兼容形式
      (code >= 0xff00 && code <= 0xff60) || // 全角形式
      (code >= 0xffe0 && code <= 0xffe6) ||
      (code >= 0x20000 && code <= 0x3fffd); // CJK 扩展 B 及以后
    width += wide ? 2 : 1;
  }
  return width;
}

function padEnd(text: string, width: number): string {
  return text + ' '.repeat(Math.max(0, width - displayWidth(text)));
}

/** 毫秒 → 精简中文时长："3.4 秒"、"1 分 23 秒"、"2 小时 5 分"、"1 天 3 小时"。 */
export function formatDuration(ms: number): string {
  if (ms < 0) ms = 0;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1).replace(/\.0$/, '')} 秒`;
  const totalSeconds = Math.floor(ms / 1000);
  const days = Math.floor(totalSeconds / 86_400);
  const hours = Math.floor((totalSeconds % 86_400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (days > 0) return `${days} 天 ${hours} 小时`;
  if (hours > 0) return `${hours} 小时 ${minutes} 分`;
  return seconds > 0 ? `${minutes} 分 ${seconds} 秒` : `${minutes} 分`;
}

/** 相对时长文案："12 秒前"、"5 分钟前"、"3 小时 12 分前"、"2 天前"。 */
function formatAgo(ms: number): string {
  if (ms < 0) ms = 0;
  const totalSeconds = Math.floor(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds} 秒前`;
  const days = Math.floor(totalSeconds / 86_400);
  const hours = Math.floor((totalSeconds % 86_400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  if (days > 0) return `${days} 天前`;
  if (hours > 0) return `${hours} 小时 ${minutes} 分前`;
  return `${minutes} 分钟前`;
}

/** 表格单元格文本：折叠空白（错误信息可能带换行），需要时截到 maxCols 列。 */
function cellText(text: string, maxCols?: number): string {
  let flat = text.replace(/\s+/g, ' ').trim();
  if (maxCols !== undefined && displayWidth(flat) > maxCols) {
    while (flat !== '' && displayWidth(flat) > maxCols - 1) flat = flat.slice(0, -1);
    flat += '…';
  }
  return flat === '' ? '—' : flat;
}

function heartbeatLines(snapshot: StatusSnapshot): string[] {
  const h = snapshot.heartbeat;
  if (!h.present) return ['守护进程：未运行或无心跳'];
  const thresholdSec = Math.round(h.staleAfterMs / 3000); // staleAfterMs = 3 × pollIntervalSec × 1000
  const lines = [
    `守护进程：${h.stale ? '心跳已过期' : '运行中'}（${formatAgo(h.ageMs ?? 0)}更新，过期阈值 3 × ${thresholdSec} 秒）`,
  ];
  if (h.lastPollMs !== null) lines.push(`  上一轮轮询耗时：${formatDuration(h.lastPollMs)}`);
  if (h.openPrs !== null) {
    const repos = Object.keys(h.openPrs);
    lines.push(
      repos.length > 0
        ? `  开放 PR：${repos.map((repo) => `${repo} ${h.openPrs?.[repo] ?? 0}`).join('、')}`
        : '  开放 PR：白名单内没有开放 PR',
    );
  }
  return lines;
}

function peakAndPauseLines(snapshot: StatusSnapshot): string[] {
  const p = snapshot.peak;
  const direction = p.nextToPeak ? '进入高峰' : '回到非高峰';
  return [
    `GLM 高峰：当前${p.isPeak ? '高峰期（不调用 GLM）' : '非高峰期'}；下一次切换（${direction}）` +
      `：北京时间 ${p.nextSwitchBeijing} / 美东 ${p.nextSwitchNewYork}，还有 ${formatDuration(p.msUntilSwitch)}`,
    `额度暂停：${snapshot.paused ? `已暂停（${snapshot.pauseFile} 存在，任务保持排队）` : `未暂停（${snapshot.pauseFile} 不存在）`}`,
  ];
}

function jobsLine(snapshot: StatusSnapshot): string {
  const jobs = snapshot.jobs;
  const order: Array<[string, keyof typeof jobs]> = [
    ['排队', 'queued'],
    ['延后', 'deferred'],
    ['进行中', 'running'],
    ['完成', 'done'],
    ['失败', 'failed'],
    ['跳过', 'skipped'],
  ];
  const total = order.reduce((sum, [, key]) => sum + jobs[key], 0);
  return `任务统计：${order.map(([label, key]) => `${label} ${jobs[key]}`).join(' · ')}（共 ${total}）`;
}

/** 简单等宽表格：按各列最大显示宽度补空格，列间两个空格。 */
function formatTable(header: string[], rows: string[][]): string[] {
  const all = [header, ...rows];
  const widths = header.map((_, col) => Math.max(...all.map((row) => displayWidth(row[col] ?? ''))));
  const render = (row: string[]): string =>
    '  ' +
    row.map((cell, col) => (col === row.length - 1 ? cell : padEnd(cell, widths[col]))).join('  ');
  return [render(header), ...rows.map(render)];
}

function queueTable(snapshot: StatusSnapshot): string[] {
  const entries = snapshot.queue;
  if (entries.length === 0) return ['等待队列：空'];
  const header = ['仓库', 'PR', '状态', '可执行时间（北京时间）', '还需等待', '尝试', '原因'];
  const rows = entries.map((entry) => [
    entry.repo,
    `#${entry.pr}`,
    JOB_STATUS_LABEL[entry.status] ?? entry.status,
    formatWallTime(new Date(entry.notBefore), STATUS_DISPLAY_ZONES.beijing),
    entry.waitMs <= 0 ? '已可执行' : formatDuration(entry.waitMs),
    `${entry.attempts}`,
    cellText(entry.reason ?? '—', REASON_MAX_COLS),
  ]);
  return ['等待队列（按可执行时间排序）：', ...formatTable(header, rows)];
}

function reviewTable(snapshot: StatusSnapshot): string[] {
  const reviews = snapshot.recentReviews;
  if (reviews.length === 0) return ['最近审查：还没有记录'];
  const header = ['仓库', 'PR', 'commit', '结果', '问题数', '模型', '耗时', 'review'];
  const rows = reviews.map((r) => [
    r.repo,
    `#${r.pr}`,
    r.shortSha,
    OUTCOME_LABEL[r.outcome] ?? r.outcome,
    r.findingsCount === null ? '—' : `${r.findingsCount}`,
    r.model ?? '—',
    r.durationMs === null ? '—' : formatDuration(r.durationMs),
    r.reviewUrl ?? cellText(r.reason ?? '—', REASON_MAX_COLS),
  ]);
  return ['最近审查（最多 20 条）：', ...formatTable(header, rows)];
}

function usageLines(snapshot: StatusSnapshot): string[] {
  const usage = (s: UsageSummary): string =>
    `${s.calls} 次（成功 ${s.okCalls} · 失败 ${s.calls - s.okCalls}），` +
    `输入 ${numberFormat.format(s.inputTokens)} tokens，输出 ${numberFormat.format(s.outputTokens)} tokens`;
  // generatedAtBeijing 形如「10月12日 周一 23:09」，取日期 + 星期作为「今天」的标注。
  const todayLabel = snapshot.generatedAtBeijing.split(' ').slice(0, 2).join(' ');
  return [
    'claude 用量：',
    `  今天（北京时间 ${todayLabel}）：${usage(snapshot.usage.today)}`,
    `  近 7 天：${usage(snapshot.usage.last7d)}`,
  ];
}

/** 渲染完整状态文本（末尾带换行）。 */
export function renderStatusText(snapshot: StatusSnapshot): string {
  const lines: string[] = [
    'GLM 审查机器人状态',
    `生成时间：北京时间 ${snapshot.generatedAtBeijing} / 美东 ${snapshot.generatedAtNewYork}（${STATUS_DISPLAY_ZONES.newYork}）`,
    '',
    ...heartbeatLines(snapshot),
    ...peakAndPauseLines(snapshot),
    '',
    jobsLine(snapshot),
    '',
    ...queueTable(snapshot),
    '',
    ...reviewTable(snapshot),
    '',
    ...usageLines(snapshot),
    '',
  ];
  return lines.join('\n');
}
