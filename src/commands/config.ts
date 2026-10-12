/**
 * `glm-review config`（#3）：
 * - `config check [--repo-file <路径>]`：校验全局配置（及可选的本地仓库配置文件），
 *   打印合并默认值后的 YAML；有任何错误退出码 1。
 * - `config init`：全局配置不存在时写一份带注释的默认配置（已存在则不改动）。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { stringify as stringifyYaml } from 'yaml';
import { defaultGlobalConfigTemplate, loadGlobalConfig } from '../config/global.ts';
import { parseRepoConfig } from '../config/repo.ts';
import { ArgError, parseArgs } from '../lib/args.ts';
import type { CliContext, Command } from '../lib/types.ts';

const USAGE = [
  '用法：',
  '  glm-review config check [--repo-file <路径>]   校验配置并打印合并后的结果（YAML）',
  '  glm-review config init                        写入带注释的默认全局配置',
].join('\n');

function runCheck(argv: string[], ctx: CliContext): number {
  let values: Record<string, string | boolean>;
  try {
    ({ values } = parseArgs(argv, { strings: ['repo-file'] }));
  } catch (err) {
    if (err instanceof ArgError) {
      ctx.stderr(`${err.message}\n${USAGE}\n`);
      return 2;
    }
    throw err;
  }

  const configFile = ctx.deps.paths.configFile;
  let globalConfig;
  try {
    globalConfig = loadGlobalConfig(configFile, { log: ctx.deps.log });
  } catch (err) {
    ctx.stderr(`${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
  if (!existsSync(configFile)) {
    ctx.stderr(`提示：全局配置文件不存在（${configFile}），以下为默认值。\n`);
  }
  ctx.stdout(`# 全局配置（${configFile}，合并默认值后）\n${stringifyYaml(globalConfig)}`);

  const repoFile = values['repo-file'];
  if (typeof repoFile !== 'string') return 0;
  let text: string;
  try {
    text = readFileSync(repoFile, 'utf8');
  } catch {
    ctx.stderr(`无法读取仓库配置文件：${repoFile}\n`);
    return 1;
  }
  const repo = parseRepoConfig(text);
  ctx.stdout(`\n# 仓库配置（${repoFile}，合并默认值后）\n${stringifyYaml(repo.config)}`);
  if (repo.errors.length > 0) {
    for (const error of repo.errors) ctx.stderr(`${error}\n`);
    return 1;
  }
  return 0;
}

function runInit(ctx: CliContext): number {
  const file = ctx.deps.paths.configFile;
  if (existsSync(file)) {
    ctx.stdout(`配置文件已存在，未改动：${file}\n`);
    return 0;
  }
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, defaultGlobalConfigTemplate(), { mode: 0o644 });
  } catch (err) {
    ctx.stderr(`写入配置文件失败：${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
  ctx.stdout(`已写入默认全局配置：${file}\n可用 glm-review config check 查看合并后的结果。\n`);
  return 0;
}

export const command: Command = {
  name: 'config',
  summary: '校验 / 初始化配置文件',
  usage: 'glm-review config <check|init> [--repo-file <路径>]',
  async run(argv, ctx): Promise<number> {
    const sub = argv[0];
    if (sub === undefined) {
      ctx.stderr(`缺少子命令。\n${USAGE}\n`);
      return 2;
    }
    if (sub === 'check') return runCheck(argv.slice(1), ctx);
    if (sub === 'init') return runInit(ctx);
    ctx.stderr(`未知子命令：config ${sub}\n${USAGE}\n`);
    return 2;
  },
};
