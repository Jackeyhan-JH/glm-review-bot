/**
 * test/publish/ 共用：PR / 发现 / 元信息构造器、快照断言、脚本化 exec。
 *
 * 脚本化 exec 是「按调用次序应答的假 gh」：fakebin 的应答规则是静态的
 * （同 argv 永远同应答），而 422 降级需要「第一次失败、第二次成功」的时序，
 * 用依赖注入的 exec 逐次回放应答，同样不碰真实 gh / 网络。
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { NormalizedFinding } from '../../src/findings/types.ts';
import { fixedClock } from '../../src/lib/clock.ts';
import { exec, type ExecFn, type ExecResult } from '../../src/lib/exec.ts';
import { nullLogger } from '../../src/lib/log.ts';
import { resolvePaths } from '../../src/lib/paths.ts';
import type { PrInfo } from '../../src/lib/types.ts';
import { commentLocation } from '../../src/publish/format.ts';
import type { PublishDeps } from '../../src/publish/post.ts';
import type { Lang, ReviewMeta } from '../../src/publish/types.ts';
import type { FakeBin } from '../helpers/fakebin.ts';
import type { TmpEnv } from '../helpers/tmp.ts';

export const REPO = 'jackeyhan-JH/split-bill';
export const HEAD_SHA = '9f2b1c3a4d5e6f708192a3b4c5d6e7f8091a2b3c';
export const OTHER_SHA = '0123456789abcdef0123456789abcdef01234567';
export const REVIEW_URL = `https://github.com/${REPO}/pull/45#pullrequestreview-99`;

/** PR 元信息（`gh pr view --json` 的形态），字段可覆盖。 */
export function makePr(overrides: Partial<PrInfo> = {}): PrInfo {
  return {
    repo: REPO,
    number: 45,
    title: 'feat: 分账支持多币种',
    author: 'Jackeyhan-JH',
    url: `https://github.com/${REPO}/pull/45`,
    headSha: HEAD_SHA,
    baseSha: OTHER_SHA,
    baseRef: 'main',
    headRef: 'feat/multi-currency',
    isDraft: false,
    labels: [],
    state: 'OPEN',
    updatedAt: '2026-10-12T08:00:00Z',
    ...overrides,
  };
}

/** 归一化后的发现（#9 的输出形态），字段可覆盖。 */
export function finding(overrides: Partial<NormalizedFinding> = {}): NormalizedFinding {
  return {
    severity: 'major',
    file: 'src/calc.ts',
    line: 12,
    title: '空指针未判断',
    body: 'a 可能为 null，直接取属性会崩溃。',
    inline: true,
    ...overrides,
  };
}

/** 审查元信息，字段可覆盖。 */
export function makeMeta(overrides: Partial<ReviewMeta> = {}): ReviewMeta {
  return {
    model: 'glm-5.3',
    chunks: 2,
    durationMs: 45_000,
    summary: '整体结构清晰，分账逻辑正确；问题集中在错误处理。',
    ...overrides,
  };
}

const SNAPSHOT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '__snapshots__');

/**
 * 快照断言：`GLM_REVIEW_UPDATE_SNAPSHOTS=1 npm test` 时写入 / 更新快照文件，
 * 平时逐字符比较。快照是人工核对后提交的「总评 + 评论正文」期望输出。
 */
export function assertSnapshot(name: string, actual: string): void {
  const file = path.join(SNAPSHOT_DIR, `${name}.md`);
  if (process.env.GLM_REVIEW_UPDATE_SNAPSHOTS === '1') {
    mkdirSync(SNAPSHOT_DIR, { recursive: true });
    writeFileSync(file, actual, 'utf8');
    return;
  }
  assert.ok(
    existsSync(file),
    `快照缺失：${file}；先运行 GLM_REVIEW_UPDATE_SNAPSHOTS=1 npm test 生成，人工核对后提交`,
  );
  const expected = readFileSync(file, 'utf8');
  assert.equal(
    actual,
    expected,
    `输出与快照不一致：${file}；如属预期变化，运行 GLM_REVIEW_UPDATE_SNAPSHOTS=1 npm test 更新并人工核对 diff`,
  );
}

/** 快照形态：总评在前，行内评论逐条附后（快照同时覆盖两者）。 */
export function renderForSnapshot(
  review: { body: string; comments: Array<{ path: string; line: number; startLine?: number; body: string }> },
): string {
  const parts = [review.body];
  review.comments.forEach((comment, index) => {
    parts.push(`\n----- 行内评论 ${index + 1}/${review.comments.length} · ${commentLocation(comment)} -----\n`);
    parts.push(comment.body);
  });
  return `${parts.join('\n')}\n`;
}

/** 一次脚本化应答：非零 code + stderr 文本特征决定 #6 的错误映射。 */
export interface ScriptedResponse {
  stdout?: string;
  stderr?: string;
  code?: number;
}

export interface RecordedCall {
  cmd: string;
  args: string[];
  input?: string;
}

/** 按调用次序回放应答的假 exec；应答耗尽时报错，防止测试静默走错分支。 */
export function createScriptedExec(responses: ScriptedResponse[]): {
  exec: ExecFn;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const execFn: ExecFn = async (cmd, args, options = {}) => {
    const index = calls.length;
    calls.push({ cmd, args, input: options.input });
    const response = responses[index];
    if (response === undefined) {
      return { code: 1, stdout: '', stderr: `scripted exec：第 ${index + 1} 次调用没有应答脚本`, timedOut: false, durationMs: 1 };
    }
    const result: ExecResult = {
      code: response.code ?? 0,
      stdout: response.stdout ?? '',
      stderr: response.stderr ?? '',
      timedOut: false,
      durationMs: 1,
    };
    return result;
  };
  return { exec: execFn, calls };
}

/** gh 走 fakebin（真实 exec + 假 gh），dry-run 输出走注入的 out。 */
export function fakeGhDeps(fake: FakeBin, tmp: TmpEnv, out?: (text: string) => void): PublishDeps {
  return {
    exec,
    clock: fixedClock('2026-10-12T00:00:00Z'),
    paths: resolvePaths(tmp.env),
    env: fake.env,
    log: nullLogger,
    ...(out !== undefined ? { out } : {}),
  };
}

/** gh 走脚本化 exec（时序应答），不落任何临时目录。 */
export function scriptedDeps(execFn: ExecFn, out?: (text: string) => void): PublishDeps {
  return {
    exec: execFn,
    clock: fixedClock('2026-10-12T00:00:00Z'),
    paths: resolvePaths({}),
    log: nullLogger,
    ...(out !== undefined ? { out } : {}),
  };
}

/** 422 应答（stderr 文本含 http 422 特征，与真实 gh 的输出形态一致）。 */
export function rejectedResponse(): ScriptedResponse {
  return {
    code: 1,
    stdout: '',
    stderr: `gh: HTTP 422: Validation Failed - https://api.github.com/repos/${REPO}/pulls/45/reviews\n{"message":"Validation Failed","errors":[{"message":"Invalid line number"}]}`,
  };
}

/** 成功应答：返回 review 的 html_url。 */
export function postedResponse(): ScriptedResponse {
  return { code: 0, stdout: JSON.stringify({ html_url: REVIEW_URL }) };
}

/** 语言参数的两种取值，参数化测试用。 */
export const LANGS: Lang[] = ['zh', 'en'];
