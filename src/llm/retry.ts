/**
 * 就地重试（#8）：同一块的瞬时错误（超时、5xx/过载/限流、输出不是合法 JSON）
 * 在调用器内部重试；任务级重试（带排队与退避）由 #5 的队列负责。
 *
 * withRetry 不抛错：fn 的失败用返回值表达，重试耗尽时返回最后一次结果，
 * 由调用方检查 ok。fn 抛出的异常直接向上抛、不重试（spawn 失败等确定性错误）。
 */

/** 可重试判定的最小接口（claude.ts 的 ClaudeRunResult 满足它）。 */
export interface RetryableResult {
  ok: boolean;
  /** 失败后是否值得就地重试。 */
  retryable: boolean;
}

export interface RetryOptions {
  /** 总尝试次数（含第一次），默认 2。 */
  attempts?: number;
  /** 每次重试前的固定等待毫秒数，默认 0（不等待）。 */
  backoffMs?: number;
  /** 等待函数，测试可注入假实现。 */
  sleep?: (ms: number) => Promise<void>;
}

const realSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 依次尝试 fn(1)、fn(2)、…（最多 attempts 次）：成功或不可重试立即返回，
 * 否则等 backoffMs 再试下一次。
 */
export async function withRetry<T extends RetryableResult>(
  fn: (attempt: number) => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const attempts = Math.max(1, Math.floor(options.attempts ?? 2));
  const backoffMs = options.backoffMs ?? 0;
  const sleep = options.sleep ?? realSleep;

  let result = await fn(1);
  for (let attempt = 2; attempt <= attempts; attempt++) {
    if (result.ok || !result.retryable) return result;
    if (backoffMs > 0) await sleep(backoffMs);
    result = await fn(attempt);
  }
  return result;
}
