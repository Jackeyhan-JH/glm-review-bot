/**
 * `glm-review daemon`（#13）：轮询守护进程入口。
 *
 * glm-review daemon [--once] [--dry-run]
 *
 * - 常驻：每 pollIntervalSec 轮询白名单仓库；SIGINT / SIGTERM 优雅退出；
 * - --once   只做一轮轮询 + 处理所有当前可执行任务后退出（测试与 cron）；
 * - --dry-run 透传给流水线：只预览将要发布的 review，不发送。
 *
 * 退出码：0 正常；4 已有实例在运行；2 参数错误；1 运行异常。
 * 优雅退出超时的任务已放回队列后，被放弃的后台审查子进程仍占着事件循环，
 * 此时直接硬退出（process.exit），避免进程滞留。
 */
import { mkdirSync } from 'node:fs';
import { loadGlobalConfig } from '../config/global.ts';
import { ArgError, parseArgs } from '../lib/args.ts';
import type { CliContext, Command } from '../lib/types.ts';
import { runDaemon } from '../daemon/daemon.ts';
import { openState } from '../state/db.ts';

const USAGE = [
  '用法：glm-review daemon [--once] [--dry-run]',
  '  轮询守护进程：入队新 PR / 新 head、峰后执行审查、失败退避重试。',
  '  单实例（GLM_REVIEW_HOME/daemon.lock）；SIGINT / SIGTERM 优雅退出。',
  '  --once     只做一轮轮询 + 处理所有当前可执行任务后退出（测试 / cron）',
  '  --dry-run  透传给流水线：只预览将要发布的 review，不发送',
].join('\n');

export const command: Command = {
  name: 'daemon',
  summary: '轮询守护进程：入队、峰后执行、重试、单实例、优雅退出',
  usage: USAGE,
  async run(argv, ctx): Promise<number> {
    let parsed: ReturnType<typeof parseArgs>;
    try {
      parsed = parseArgs(argv, { strings: [], booleans: ['once', 'dry-run'] });
    } catch (err) {
      if (err instanceof ArgError) {
        ctx.stderr(`错误：${err.message}\n${USAGE}\n`);
        return 2;
      }
      throw err;
    }

    const once = parsed.values.once === true;
    const dryRun = parsed.values['dry-run'] === true;
    const config = loadGlobalConfig(ctx.deps.paths.configFile, { log: ctx.deps.log });
    if (config.repos.length === 0) {
      ctx.deps.log.warn('全局配置 repos 白名单为空，轮询不到任何仓库', {
        configFile: ctx.deps.paths.configFile,
      });
      ctx.stdout('注意：全局配置 repos 白名单为空，本轮轮询不到任何仓库（心跳照常写入）。\n');
    }
    ctx.stdout(
      `glm-review daemon 启动（${once ? '--once 单轮模式' : `轮询间隔 ${config.pollIntervalSec} 秒`}${dryRun ? '，dry-run' : ''}）。\n`,
    );

    mkdirSync(ctx.deps.paths.home, { recursive: true });
    const state = openState(ctx.deps.paths.stateDb);
    let result;
    try {
      result = await runDaemon(
        { once, dryRun },
        {
          exec: ctx.deps.exec,
          clock: ctx.deps.clock,
          env: ctx.deps.env,
          paths: ctx.deps.paths,
          log: ctx.deps.log,
          state,
          config,
          out: (text: string) => ctx.stdout(`${text}\n`),
        },
      );
    } finally {
      state.close();
    }

    if (result.code === 4) {
      ctx.stderr(`错误：已有守护进程实例在运行（pid ${result.holderPid}），拒绝启动。\n`);
      return 4;
    }
    if (result.abandoned > 0) {
      ctx.stderr(
        `注意：${result.abandoned} 个审查等待超时已放回队列；被放弃的后台审查仍占着事件循环，现在直接退出。\n`,
      );
      process.exit(result.code);
    }
    return result.code;
  },
};
