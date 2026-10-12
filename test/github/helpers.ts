/**
 * test/github/ 共用：构造注入假 gh / 假 git（fakebin）与隔离目录的 GithubDeps。
 */
import { fixedClock } from '../../src/lib/clock.ts';
import { exec } from '../../src/lib/exec.ts';
import { nullLogger } from '../../src/lib/log.ts';
import { resolvePaths } from '../../src/lib/paths.ts';
import type { GithubDeps } from '../../src/github/run.ts';
import type { FakeBin } from '../helpers/fakebin.ts';
import type { TmpEnv } from '../helpers/tmp.ts';

export function fakeDeps(fake: FakeBin, tmp: TmpEnv): GithubDeps {
  return {
    exec,
    clock: fixedClock('2026-10-12T00:00:00Z'),
    env: fake.env,
    paths: resolvePaths(tmp.env),
    log: nullLogger,
  };
}

export const REPO = 'jackeyhan-JH/split-bill';

export const SHA_A = '9f2b1c3a4d5e6f708192a3b4c5d6e7f8091a2b3c';
export const SHA_B = '0123456789abcdef0123456789abcdef01234567';
