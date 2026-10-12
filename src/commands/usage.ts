/**
 * `glm-review usage`（#15）：用量报表——调用次数 / 成功率 / 耗时 / token /
 * 费用 / 折合 prompt 数，按天 / 仓库 / 模型分组，附「近 5 小时」「近 7 天」
 * 两个滚动窗口汇总（对照 GLM 套餐的 5 小时 / 每周额度）。
 *
 * glm-review usage [--since 7d|24h|<ISO>] [--until <ISO>] [--by day|repo|model]
 *                  [--plan new|v2-glm-5.3|v2-glm-5.3-flash] [--json|--csv]
 *
 * - 数据来自状态库的调用账本（#5 calls 表），只读；
 * - 折合 prompt 数按所选套餐计价：高峰 / 非高峰倍率见 src/usage/plans.ts，
 *   V2 套餐按每次调用的模型选对应套餐行；
 * - `--csv` 输出一张带表头的 CSV（分组行 + 总计 + 两个窗口行）；
 * - `--json` 输出一行 JSON（报表对象原文）；
 * - 参数非法：中文报错、退出码 2；状态库读不了：退出码 1。
 */
import { existsSync } from 'node:fs';
import { ArgError, parseArgs } from '../lib/args.ts';
import type { CliContext, Command } from '../lib/types.ts';
import { listCalls, type CallRecord } from '../state/calls.ts';
import { openState, type StateDb } from '../state/db.ts';
import { getPlan, PLANS } from '../usage/plans.ts';
import {
  buildUsageReport,
  GROUP_LABEL,
  type UsageGroupBy,
  type UsageReport,
  type UsageStats,
} from '../usage/report.ts';
import { parseIsoArg, parseSinceArg, TimeArgError } from '../usage/timearg.ts';

const USAGE = [
  '用法：glm-review usage [选项]',
  '  --since <7d|24h|30m|ISO>   统计起点（相对时长或 ISO 时刻，默认全部记录）',
  '  --until <ISO>              统计终点（ISO 时刻，默认不限）',
  '  --by <day|repo|model>      分组维度（默认 day，日期按北京时间）',
  '  --plan <套餐 id>           折算套餐（默认 new）',
  '  --json                     输出一行 JSON',
  '  --csv                      输出 CSV（带表头）',
].join('\n');

const GROUP_VALUES: UsageGroupBy[] = ['day', 'repo', 'model'];
const ANSI_RED = '\x1b[31m';
const ANSI_RESET = '\x1b[0m';

/** 毫秒 → 中文时长：「45 秒」「2 分 15 秒」「1 小时 3 分」。 */
function formatDuration(ms: number): string {
  const totalSeconds = Math.round(Math.max(0, ms) / 1000);
  if (totalSeconds < 60) return `${totalSeconds} 秒`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return seconds === 0 ? `${minutes} 分` : `${minutes} 分 ${seconds} 秒`;
  return `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分`;
}

/** 数值展示：钳到 4 位小数并去掉尾零（3 → "3"，4.6 → "4.6"）。 */
function formatCount(value: number): string {
  return String(Number(value.toFixed(4)));
}

/** 终端显示宽度（中日韩全角字符按 2 列计），仅用于表格对齐。 */
const WIDE_CHAR = /[⺀-鿿豈-﫿＀-￯]/;
function displayWidth(text: string): number {
  let width = 0;
  for (const ch of text) {
    width += WIDE_CHAR.test(ch) ? 2 : 1;
  }
  return width;
}

function padCell(text: string, width: number): string {
  return text + ' '.repeat(Math.max(1, width - displayWidth(text)));
}

function renderTable(header: string[], rows: string[][]): string {
  const widths = header.map((title, index) =>
    Math.max(displayWidth(title), ...rows.map((row) => displayWidth(row[index] ?? ''))),
  );
  const line = (cells: string[]): string =>
    cells.map((cell, index) => padCell(cell, widths[index])).join('  ').trimEnd();
  return [line(header), ...rows.map(line)].join('\n');
}

function statsCells(stats: UsageStats): string[] {
  return [
    String(stats.calls),
    String(stats.okCalls),
    String(stats.failedCalls),
    stats.calls === 0 ? '—' : `${(stats.successRate * 100).toFixed(1)}%`,
    formatDuration(stats.avgDurationMs),
    formatDuration(stats.totalDurationMs),
    String(stats.inputTokens),
    String(stats.outputTokens),
    stats.costUsd.toFixed(4),
    formatCount(stats.prompts),
    String(stats.peakCalls),
  ];
}

function windowLine(label: string, from: string, to: string, stats: UsageStats): string {
  return (
    `${label}（${from} ～ ${to}，左闭右开）：` +
    `${stats.calls} 次调用，成功 ${stats.okCalls} / 失败 ${stats.failedCalls}，` +
    `折合 ${formatCount(stats.prompts)} prompt，` +
    `输入 ${stats.inputTokens} / 输出 ${stats.outputTokens} token，` +
    `费用 $${stats.costUsd.toFixed(4)}，高峰 ${stats.peakCalls} 次`
  );
}

function renderHuman(report: UsageReport): string {
  const header = [
    GROUP_LABEL[report.groupBy],
    '调用',
    '成功',
    '失败',
    '成功率',
    '平均耗时',
    '总耗时',
    '输入token',
    '输出token',
    '费用($)',
    '折合prompt',
    '高峰调用',
  ];
  const rows = [
    ...report.groups.map((group) => [group.key, ...statsCells(group)]),
    ['总计', ...statsCells(report.totals)],
  ];
  const rangeFrom = report.since ?? '全部记录';
  const rangeTo = report.until ?? `${report.generatedAt}（当前时刻）`;
  const lines = [
    `用量报表（套餐：${report.planName}，分组：${GROUP_LABEL[report.groupBy]}）`,
    `统计范围：${rangeFrom} ～ ${rangeTo}，共 ${report.totals.calls} 次调用`,
    '',
    renderTable(header, rows),
    '',
    windowLine('近 5 小时', report.window5h.from, report.window5h.to, report.window5h),
    windowLine('近 7 天', report.window7d.from, report.window7d.to, report.window7d),
  ];
  for (const warning of report.warnings) {
    lines.push('', `${ANSI_RED}⚠ ${warning}${ANSI_RESET}`);
  }
  return `${lines.join('\n')}\n`;
}

function csvField(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

function csvRow(cells: readonly (string | number)[]): string {
  return cells.map((cell) => csvField(String(cell))).join(',');
}

function renderCsv(report: UsageReport): string {
  const header = csvRow([
    GROUP_LABEL[report.groupBy],
    '调用次数',
    '成功次数',
    '失败次数',
    '成功率',
    '平均耗时ms',
    '总耗时ms',
    '输入token',
    '输出token',
    '费用usd',
    '折合prompt',
    '高峰调用次数',
  ]);
  const statsCells = (stats: UsageStats): readonly (string | number)[] => [
    stats.calls,
    stats.okCalls,
    stats.failedCalls,
    stats.successRate,
    stats.avgDurationMs,
    stats.totalDurationMs,
    stats.inputTokens,
    stats.outputTokens,
    stats.costUsd,
    stats.prompts,
    stats.peakCalls,
  ];
  const rows = [
    header,
    ...report.groups.map((group) => csvRow([group.key, ...statsCells(group)])),
    csvRow(['总计', ...statsCells(report.totals)]),
    csvRow(['近5小时', ...statsCells(report.window5h)]),
    csvRow(['近7天', ...statsCells(report.window7d)]),
  ];
  return `${rows.join('\n')}\n`;
}

/** 读出全部调用记录；库文件不存在时返回空（提示走 stderr，不打扰 --json）。 */
function loadCalls(dbPath: string): { calls: CallRecord[]; missing: boolean } {
  if (!existsSync(dbPath)) return { calls: [], missing: true };
  let state: StateDb;
  try {
    state = openState(dbPath);
  } catch (err) {
    throw new Error(`打开状态库失败：${err instanceof Error ? err.message : String(err)}`);
  }
  try {
    return { calls: listCalls(state, { limit: 100_000 }), missing: false };
  } finally {
    state.close();
  }
}

export const command: Command = {
  name: 'usage',
  summary: '用量报表：调用 / token / 折合 prompt 数，5 小时与 7 天窗口',
  usage: USAGE,
  async run(argv, ctx): Promise<number> {
    let parsed: ReturnType<typeof parseArgs>;
    try {
      parsed = parseArgs(argv, {
        strings: ['since', 'until', 'by', 'plan'],
        booleans: ['json', 'csv'],
      });
    } catch (err) {
      if (err instanceof ArgError) {
        ctx.stderr(`错误：${err.message}\n${USAGE}\n`);
        return 2;
      }
      throw err;
    }
    const fail = (message: string): number => {
      ctx.stderr(`错误：${message}\n${USAGE}\n`);
      return 2;
    };

    if (parsed.positionals.length > 0) return fail(`多余的参数：${parsed.positionals[0]}`);
    const asString = (key: string): string | undefined => {
      const value = parsed.values[key];
      return typeof value === 'string' ? value : undefined;
    };

    const json = parsed.values.json === true;
    const csv = parsed.values.csv === true;
    if (json && csv) return fail('--json 与 --csv 不能同时使用');

    const byRaw = asString('by');
    let groupBy: UsageGroupBy = 'day';
    if (byRaw !== undefined) {
      if (!GROUP_VALUES.includes(byRaw as UsageGroupBy)) {
        return fail(`无效的 --by 取值：${byRaw}（可选 ${GROUP_VALUES.join(' | ')}）`);
      }
      groupBy = byRaw as UsageGroupBy;
    }

    const planRaw = asString('plan');
    const plan = planRaw === undefined ? undefined : getPlan(planRaw);
    if (planRaw !== undefined && plan === undefined) {
      return fail(`无效的 --plan 取值：${planRaw}（可选 ${PLANS.map((p) => p.id).join(' | ')}）`);
    }

    // 当前时间只从注入时钟取；--since 相对时长也以它为基准。
    const now = ctx.deps.clock.now();
    const sinceRaw = asString('since');
    const untilRaw = asString('until');
    let since: Date | undefined;
    let until: Date | undefined;
    try {
      if (sinceRaw !== undefined) since = parseSinceArg(sinceRaw, now);
      if (untilRaw !== undefined) until = parseIsoArg(untilRaw);
    } catch (err) {
      if (err instanceof TimeArgError) return fail(err.message);
      throw err;
    }

    let calls: CallRecord[];
    try {
      const loaded = loadCalls(ctx.deps.paths.stateDb);
      calls = loaded.calls;
      if (loaded.missing) {
        ctx.stderr(`提示：状态库不存在（${ctx.deps.paths.stateDb}），暂无调用记录。\n`);
      }
    } catch (err) {
      ctx.stderr(`${err instanceof Error ? err.message : String(err)}\n`);
      return 1;
    }

    const report = buildUsageReport(calls, { now, since, until, groupBy, plan });

    if (json) {
      ctx.stdout(`${JSON.stringify(report)}\n`);
    } else if (csv) {
      ctx.stdout(renderCsv(report));
      for (const warning of report.warnings) ctx.stderr(`${ANSI_RED}⚠ ${warning}${ANSI_RESET}\n`);
    } else {
      ctx.stdout(renderHuman(report));
    }
    return 0;
  },
};
