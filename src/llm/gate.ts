/**
 * 启动前闸门（#8，#1 运行规则 2、3）——每次启动新的 claude 前检查：
 *
 * - `paused`：额度暂停文件存在（看门狗在 5 小时额度 > 95% 时创建）；
 * - `self-busy`：机器人自己同时在跑的 claude 已达 maxConcurrent（默认 1）；
 * - `box-busy`：本机全部 claude 进程（含其他项目开发的）已达上限（默认 4，
 *   用 `pgrep -x claude` 统计，经注入的 exec 调用）。
 *
 * 检查顺序 paused → self-busy → box-busy：先做不用起子进程的检查。
 * 高峰期判断不在这里（#4 提供、#11/#13 组装时调用）。
 */
import { existsSync } from 'node:fs';
import type { ExecFn } from '../lib/exec.ts';

/** 额度暂停文件的默认路径（#1 运行规则 3，可配置）。 */
export const DEFAULT_PAUSE_FILE = '/workspace/GLM_PAUSE';

/** 本机所有 Claude Code 进程的总数上限（#1 运行规则 2）。 */
export const DEFAULT_BOX_CLAUDE_LIMIT = 4;

/** 审查机器人自己的 claude 并发上限（#1 运行规则 2）。 */
export const DEFAULT_MAX_CONCURRENT = 1;

/** 闸门输入：全部可配置，均可省略用默认值（mineRunning 除外——调用方最清楚）。 */
export interface GateInput {
  /** 暂停文件路径，默认 /workspace/GLM_PAUSE。 */
  pauseFile?: string;
  /** 本机 claude 进程总数上限，默认 4。 */
  boxClaudeLimit?: number;
  /** 机器人自己正在运行的 claude 数量。 */
  mineRunning: number;
  /** 机器人自己的并发上限，默认 1。 */
  maxConcurrent?: number;
}

export interface GateDeps {
  exec: ExecFn;
}

export type GateResult =
  | { ok: true }
  | { ok: false; reason: 'paused' | 'box-busy' | 'self-busy'; detail: string };

/** 检查闸门：ok=false 时 detail 说明原因（中文，可进日志）。 */
export async function checkGate(input: GateInput, deps: GateDeps): Promise<GateResult> {
  const pauseFile = input.pauseFile ?? DEFAULT_PAUSE_FILE;
  if (existsSync(pauseFile)) {
    return { ok: false, reason: 'paused', detail: `额度暂停文件存在：${pauseFile}` };
  }

  const maxConcurrent = input.maxConcurrent ?? DEFAULT_MAX_CONCURRENT;
  if (input.mineRunning >= maxConcurrent) {
    return {
      ok: false,
      reason: 'self-busy',
      detail: `自身并发 ${input.mineRunning} 已达上限 ${maxConcurrent}`,
    };
  }

  const boxClaudeLimit = input.boxClaudeLimit ?? DEFAULT_BOX_CLAUDE_LIMIT;
  const boxRunning = await countClaudeProcesses(deps.exec);
  if (boxRunning >= boxClaudeLimit) {
    return {
      ok: false,
      reason: 'box-busy',
      detail: `本机 claude 进程 ${boxRunning} 已达上限 ${boxClaudeLimit}`,
    };
  }

  return { ok: true };
}

/**
 * 用 `pgrep -x claude` 统计本机 claude 进程数。
 * pgrep 无匹配时退出码 1、输出为空（= 0 个）；退出码 ≥ 2 才是 pgrep 自身出错。
 */
export async function countClaudeProcesses(exec: ExecFn): Promise<number> {
  const r = await exec('pgrep', ['-x', 'claude']);
  if (r.code === 0 || r.code === 1) {
    return r.stdout.trim() === '' ? 0 : r.stdout.trim().split('\n').filter((line) => line !== '').length;
  }
  throw new Error(`pgrep 执行失败（退出码 ${r.code}）：${r.stderr.trim()}`);
}
