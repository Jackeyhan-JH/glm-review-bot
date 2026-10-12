/**
 * 测试用 CliContext：捕获 stdout/stderr 到字符串，依赖全部用假实现
 * （隔离的临时目录、假时钟、空日志器），不碰真实环境。
 */
import { fixedClock } from '../../src/lib/clock.ts';
import { exec } from '../../src/lib/exec.ts';
import { nullLogger } from '../../src/lib/log.ts';
import { resolvePaths } from '../../src/lib/paths.ts';
import type { CliContext } from '../../src/lib/types.ts';
import { createTmpEnv, type TmpEnv } from './tmp.ts';

export interface TestHarness {
  ctx: CliContext;
  tmp: TmpEnv;
  /** 目前捕获到的 stdout。 */
  stdout(): string;
  /** 目前捕获到的 stderr。 */
  stderr(): string;
  cleanup(): void;
}

export function createTestContext(): TestHarness {
  const tmp = createTmpEnv('glm-review-cli-test');
  let out = '';
  let err = '';
  const ctx: CliContext = {
    deps: {
      exec,
      clock: fixedClock('2026-10-12T00:00:00Z'),
      env: tmp.env,
      paths: resolvePaths(tmp.env),
      log: nullLogger,
    },
    stdout: (text) => {
      out += text;
    },
    stderr: (text) => {
      err += text;
    },
  };
  return {
    ctx,
    tmp,
    stdout: () => out,
    stderr: () => err,
    cleanup: tmp.cleanup,
  };
}
