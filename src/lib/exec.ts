/**
 * 外部命令执行的唯一入口（见 #1：`gh` / `git` / `claude` 只经由这里调用）。
 * 基于 child_process.spawn，不经过 shell；超时先 SIGINT，宽限期后 SIGKILL。
 */
import { spawn } from 'node:child_process';

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
}

export interface ExecOptions {
  cwd?: string;
  /** 写入子进程 stdin 的内容（写完立即关闭）。 */
  input?: string;
  /** 超时毫秒数：到时先发 SIGINT，`killGraceMs` 后仍未退出则 SIGKILL。 */
  timeoutMs?: number;
  /** SIGINT 后等待退出的宽限期，默认 5000ms。 */
  killGraceMs?: number;
  /** 传给子进程的完整环境变量（不传则继承当前进程）。 */
  env?: Record<string, string | undefined>;
}

export type ExecFn = (cmd: string, args: string[], options?: ExecOptions) => Promise<ExecResult>;

export const exec: ExecFn = async (cmd, args, options = {}) => {
  const startedAt = Date.now();
  const child = spawn(cmd, args, {
    cwd: options.cwd,
    env: options.env,
    shell: false,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let stdout = '';
  let stderr = '';
  let timedOut = false;
  let settled = false;

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk;
  });

  child.stdin.on('error', () => {
    // 子进程不读 stdin（如 EPIPE）时忽略，属正常情况。
  });
  if (options.input !== undefined) child.stdin.write(options.input);
  child.stdin.end();

  const result = await new Promise<ExecResult>((resolve, reject) => {
    let graceTimer: NodeJS.Timeout | undefined;
    let intTimer: NodeJS.Timeout | undefined;

    const clearTimers = () => {
      if (intTimer !== undefined) clearTimeout(intTimer);
      if (graceTimer !== undefined) clearTimeout(graceTimer);
    };

    const onSpawnError = (err: Error) => {
      if (settled) return;
      settled = true;
      clearTimers();
      reject(err);
    };

    child.on('error', onSpawnError);

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimers();
      resolve({
        code: code ?? -1,
        stdout,
        stderr,
        timedOut,
        durationMs: Date.now() - startedAt,
      });
    });

    if (options.timeoutMs !== undefined) {
      intTimer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGINT');
        const grace = options.killGraceMs ?? 5000;
        graceTimer = setTimeout(() => {
          child.kill('SIGKILL');
        }, grace);
      }, options.timeoutMs);
    }
  });

  return result;
};
