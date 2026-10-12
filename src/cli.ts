/**
 * CLI 入口：扫描 src/commands/*.ts 动态 import，自动发现子命令并分发。
 * - `glm-review help` / `-h` / `--help` / 无参数：列出全部子命令（按名字排序）；
 * - 未知子命令：stderr 中文错误 + 用法提示，退出码 2；
 * - 子命令抛出的未捕获异常：中文错误，退出码 1；
 * - 子命令返回值作为进程退出码。
 */
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { systemClock } from './lib/clock.ts';
import { exec } from './lib/exec.ts';
import { createLogger, nullLogger } from './lib/log.ts';
import { ensureDirs, resolvePaths } from './lib/paths.ts';
import type { CliContext, Command, Deps } from './lib/types.ts';

export const PROGRAM = 'glm-review';

export interface CliOptions {
  /** 子命令目录，默认 src/commands（测试可注入临时目录）。 */
  commandsDir?: string;
  /** 上下文（依赖与输出），默认基于当前进程环境构建。 */
  ctx?: CliContext;
}

function defaultCommandsDir(): string {
  return path.join(import.meta.dirname, 'commands');
}

/** 基于当前进程构建默认上下文；日志惰性落盘（首次使用时建目录）。 */
export function createDefaultContext(): CliContext {
  const env = process.env;
  const paths = resolvePaths(env);
  let log = nullLogger;
  let logReady = false;
  const deps: Deps = {
    exec,
    clock: systemClock,
    env,
    paths,
    get log() {
      if (!logReady) {
        logReady = true;
        try {
          ensureDirs(paths);
          log = createLogger({
            file: path.join(paths.logsDir, 'glm-review.log'),
            clock: systemClock,
          });
        } catch {
          log = nullLogger;
        }
      }
      return log;
    },
  };
  return {
    deps,
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
  };
}

/** 内置 help 子命令：列出全部子命令；`help <子命令>` 显示该命令详细用法。 */
function makeHelpCommand(loadCommands: () => Promise<Map<string, Command>>): Command {
  return {
    name: 'help',
    summary: '显示帮助',
    usage: `${PROGRAM} help [子命令]`,
    async run(argv, ctx): Promise<number> {
      const commands = await loadCommands();
      const target = argv[0];
      if (target === undefined) {
        printCommandList(ctx, commands);
        return 0;
      }
      const cmd = commands.get(target);
      if (cmd === undefined) {
        ctx.stderr(`未知子命令：${target}\n运行 ${PROGRAM} help 查看可用子命令。\n`);
        return 2;
      }
      ctx.stdout(`用法：${cmd.usage}\n${cmd.summary}\n`);
      return 0;
    },
  };
}

function printCommandList(ctx: Pick<CliContext, 'stdout'>, commands: Map<string, Command>): void {
  const sorted = [...commands.values()].sort((a, b) => a.name.localeCompare(b.name));
  const width = Math.max(...sorted.map((cmd) => cmd.name.length));
  const lines = sorted.map((cmd) => `  ${cmd.name.padEnd(width)}  ${cmd.summary}`);
  ctx.stdout(
    [
      `${PROGRAM} — GLM 代码审查机器人`,
      '',
      `用法：${PROGRAM} <子命令> [参数]`,
      '',
      '子命令：',
      ...lines,
      '',
      `运行 ${PROGRAM} help <子命令> 查看该子命令的详细用法。`,
      '',
    ].join('\n'),
  );
}

/**
 * 加载全部子命令：内置 help + 目录里每个 `export const command: Command` 的 .ts 文件。
 * 同名时文件里的定义覆盖内置命令。加载失败的文件直接跳过。
 */
export async function loadCommands(commandsDir: string): Promise<Map<string, Command>> {
  const commands = new Map<string, Command>();
  let loading: Promise<Map<string, Command>> | undefined;
  loading = (async () => {
    let files: string[] = [];
    try {
      files = readdirSync(commandsDir)
        .filter((name) => name.endsWith('.ts'))
        .sort();
    } catch {
      files = [];
    }
    for (const file of files) {
      const fullPath = path.join(commandsDir, file);
      try {
        const mod = (await import(pathToFileURL(fullPath).href)) as { command?: Command };
        const cmd = mod.command;
        if (
          cmd !== undefined &&
          cmd !== null &&
          typeof cmd.name === 'string' &&
          typeof cmd.summary === 'string' &&
          typeof cmd.usage === 'string' &&
          typeof cmd.run === 'function'
        ) {
          commands.set(cmd.name, cmd);
        }
      } catch {
        // 单个命令文件损坏不影响其余子命令。
      }
    }
    return commands;
  })();
  commands.set('help', makeHelpCommand(() => loading ?? loadCommands(commandsDir)));
  await loading;
  return commands;
}

/** CLI 主流程：解析 argv、分发子命令，返回退出码。 */
export async function runCli(argv: string[], options: CliOptions = {}): Promise<number> {
  const ctx = options.ctx ?? createDefaultContext();
  const commands = await loadCommands(options.commandsDir ?? defaultCommandsDir());

  const first = argv[0];
  if (first === undefined || first === '-h' || first === '--help') {
    printCommandList(ctx, commands);
    return 0;
  }

  const cmd = commands.get(first);
  if (cmd === undefined) {
    ctx.stderr(`未知子命令：${first}\n运行 ${PROGRAM} help 查看可用子命令。\n`);
    return 2;
  }

  try {
    return await cmd.run(argv.slice(1), ctx);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    ctx.stderr(`执行出错：${message}\n`);
    return 1;
  }
}

const isMain =
  process.argv[1] !== undefined &&
  import.meta.filename === path.resolve(process.argv[1]);

if (isMain) {
  runCli(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (err) => {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(`执行出错：${message}\n`);
      process.exitCode = 1;
    },
  );
}
