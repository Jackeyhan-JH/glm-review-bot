/**
 * 时钟：所有「当前时间」都必须从这里取，禁止直接 `new Date()` / `Date.now()`，
 * 以便测试注入假时钟（见 #1 技术约定）。
 */

export interface Clock {
  now(): Date;
}

/** 真实系统时钟。 */
export const systemClock: Clock = {
  now(): Date {
    return new Date();
  },
};

/** 可推进的假时钟，`fixedClock(iso)` 创建一个停在指定时刻的实例。 */
export interface FakeClock extends Clock {
  now(): Date;
  /** 把时钟拨到指定时刻（ISO 字符串或 Date）。 */
  set(at: string | Date): void;
  /** 向前推进 ms 毫秒。 */
  advance(ms: number): void;
}

export function fixedClock(at: string | Date = '2026-01-01T00:00:00Z'): FakeClock {
  let current = new Date(at);
  return {
    now(): Date {
      return new Date(current.getTime());
    },
    set(next: string | Date): void {
      current = new Date(next);
    },
    advance(ms: number): void {
      current = new Date(current.getTime() + ms);
    },
  };
}
