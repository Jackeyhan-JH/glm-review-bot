/**
 * `glm-review status`（#14）：一眼看清机器人在干什么。
 *
 * glm-review status [--json] [--serve [--port <n>]]
 *
 * - 默认：终端文本（中文、对齐表格）；
 * - `--json`：输出一行 collectStatus 的 JSON 快照（便于脚本处理）；
 * - `--serve`：启动只监听 127.0.0.1 的状态网页（`--port` 缺省用全局配置 statusPort），
 *   Ctrl+C / SIGTERM 优雅退出。
 */
import { mkdirSync } from 'node:fs';
import { loadGlobalConfig } from '../config/global.ts';
import { ArgError, parseArgs } from '../lib/args.ts';
import type { CliContext, Command } from '../lib/types.ts';
import { collectStatus } from '../status/collect.ts';
import { renderStatusText } from '../status/render-text.ts';
import { startStatusServer } from '../status/server.ts';
import { openState, type StateDb } from '../state/db.ts';

const USAGE = '用法：glm-review status [--json] [--serve [--port <n>]]';

export const command: Command = {
  name: 'status',
  summary: '查看机器人状态：队列、最近审查、用量、高峰（--serve 启动本机状态网页）',
  usage: USAGE,
  async run(argv, ctx): Promise<number> {
    let parsed: ReturnType<typeof parseArgs>;
    try {
      parsed = parseArgs(argv, { strings: ['port'], booleans: ['json', 'serve'] });
    } catch (err) {
      if (err instanceof ArgError) {
        ctx.stderr(`错误：${err.message}\n${USAGE}\n`);
        return 2;
      }
      throw err;
    }
    if (parsed.positionals.length > 0) {
      ctx.stderr(`错误：多余的参数：${parsed.positionals[0]}\n${USAGE}\n`);
      return 2;
    }

    let port: number | undefined;
    const portRaw = parsed.values.port;
    if (typeof portRaw === 'string') {
      if (!/^\d+$/.test(portRaw) || Number(portRaw) < 1 || Number(portRaw) > 65_535) {
        ctx.stderr(`错误：无效的 --port 取值（要 1–65535 的整数）：${portRaw}\n${USAGE}\n`);
        return 2;
      }
      port = Number(portRaw);
    }

    // 状态端口 / 暂停文件 / 轮询间隔都来自全局配置（缺文件时用默认值并打警告日志）。
    let config;
    try {
      config = loadGlobalConfig(ctx.deps.paths.configFile, { log: ctx.deps.log });
    } catch (err) {
      ctx.stderr(`${err instanceof Error ? err.message : String(err)}\n`);
      return 1;
    }
    const collectOptions = {
      pollIntervalSec: config.pollIntervalSec,
      pauseFile: config.pauseFile,
    };

    // 打开状态库（不存在时按空库处理：一切从零开始，也是新装机器的真实状态）。
    mkdirSync(ctx.deps.paths.home, { recursive: true });
    const db = openState(ctx.deps.paths.stateDb);

    if (parsed.values.serve) {
      return serve(db, port ?? config.statusPort, collectOptions, ctx);
    }

    try {
      const snapshot = collectStatus(db, ctx.deps.clock.now(), collectOptions);
      if (parsed.values.json) {
        ctx.stdout(`${JSON.stringify(snapshot)}\n`);
      } else {
        ctx.stdout(renderStatusText(snapshot));
      }
    } finally {
      db.close();
    }
    return 0;
  },
};

/** 启动状态网页并阻塞到收到退出信号（SIGINT / SIGTERM 优雅退出）。 */
function serve(
  db: StateDb,
  port: number,
  collectOptions: { pollIntervalSec: number; pauseFile: string },
  ctx: CliContext,
): Promise<number> {
  return new Promise((resolve) => {
    let exitCode = 0;
    startStatusServer({
      db,
      clock: ctx.deps.clock,
      port,
      ...collectOptions,
      log: ctx.deps.log,
    }).then(
      (server) => {
        ctx.stdout(`状态页已启动：http://127.0.0.1:${server.port}/\n`);
        ctx.stdout(`JSON 接口：http://127.0.0.1:${server.port}/api/status\n按 Ctrl+C 退出。\n`);
        const shutdown = (signal: string): void => {
          ctx.stdout(`收到 ${signal}，正在关闭状态页…\n`);
          void server.close().then(() => {
            try {
              db.close();
            } catch {
              // 已关闭则忽略。
            }
            resolve(exitCode);
          });
        };
        process.once('SIGINT', () => shutdown('SIGINT'));
        process.once('SIGTERM', () => shutdown('SIGTERM'));
      },
      (err) => {
        ctx.stderr(`状态页启动失败：${err instanceof Error ? err.message : String(err)}\n`);
        try {
          db.close();
        } catch {
          // 已关闭则忽略。
        }
        resolve(1);
      },
    );
  });
}
