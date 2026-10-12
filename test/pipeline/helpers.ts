/**
 * test/pipeline/ 共用：搭一个「假 gh + 假 git + 假 claude + 临时状态库」的完整世界，
 * 跑 #11 的流水线与命令。全程不碰真实网络 / 真实 gh / 真实 claude（见 #1 技术约定）。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fixedClock, type FakeClock } from '../../src/lib/clock.ts';
import { exec } from '../../src/lib/exec.ts';
import { nullLogger } from '../../src/lib/log.ts';
import { resolvePaths } from '../../src/lib/paths.ts';
import type { CliContext } from '../../src/lib/types.ts';
import { reviewPr, type ReviewOutcome, type ReviewPipelineDeps, type ReviewPrInput } from '../../src/pipeline/review.ts';
import { openState, type StateDb } from '../../src/state/db.ts';
import { createFakeBin, type FakeBin, type FakeBinRule, type FakeCall } from '../helpers/fakebin.ts';
import { createTmpEnv, type TmpEnv } from '../helpers/tmp.ts';

export const REPO = 'Jackeyhan-JH/split-bill';
export const PR_NO = 45;
export const HEAD_SHA = '9f2b1c3a4d5e6f708192a3b4c5d6e7f8091a2b3c';
export const OTHER_SHA = '0123456789abcdef0123456789abcdef01234567';
export const REVIEW_URL = `https://github.com/${REPO}/pull/45#pullrequestreview-77`;

/** getPr 请求的字段串（与 src/github/prs.ts 的 PR_FIELDS 一致，fakebin 精确匹配用）。 */
const PR_FIELDS =
  'number,title,author,url,headRefOid,baseRefOid,baseRefName,headRefName,isDraft,labels,updatedAt,state';

/** 默认假时钟：2026-10-12（周一）00:00Z = 北京 08:00，非高峰。 */
export const NON_PEAK_AT = '2026-10-12T00:00:00Z';
/** 高峰假时钟：2026-10-12（周一）07:00Z = 北京 15:00，本段高峰 10:00Z（北京 18:00）结束。 */
export const PEAK_AT = '2026-10-12T07:00:00Z';

const FIXTURES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'pipeline');

export const SAMPLE_DIFF = readFixture('sample.diff');
const PR_VIEW_JSON = readFixture('pr-view.json');

function readFixture(name: string): string {
  return readFileSync(path.join(FIXTURES_DIR, name), 'utf8');
}

/** claude 的 --output-format json 外壳，包住结构化输出（字段可覆盖）。 */
export function claudeEnvelope(output: unknown, overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: 'result',
    result: '',
    structured_output: output,
    is_error: false,
    usage: { input_tokens: 120, output_tokens: 80 },
    total_cost_usd: 0.012,
    duration_ms: 321,
    num_turns: 1,
    ...overrides,
  });
}

/** 样例模型输出：src/calc.ts 第 2、5 行各一条（都在新文件可评论范围内）。 */
export function sampleClaudeOutput(): { summary: string; findings: unknown[] } {
  return {
    summary: '整体实现清晰，问题集中在错误处理。',
    findings: [
      {
        severity: 'major',
        file: 'src/calc.ts',
        line: 2,
        title: '参数校验漏了 undefined',
        body: 'undefined 参与 NaN 比较返回 false，不会被 Number.isFinite 拦住。',
        suggestion: 'if (a === undefined || b === undefined) {\n  throw new Error("缺少参数");\n}',
      },
      {
        severity: 'minor',
        file: 'src/calc.ts',
        line: 5,
        title: '错误信息缺少参数名',
        body: '排查时不知道是哪个参数不合法。',
      },
    ],
  };
}

/** 世界选项：按测试场景调整假仓库 / 假模型的行为。 */
export interface WorldOptions {
  /** 假时钟停在的时刻，默认非高峰的周一早上。 */
  clockAt?: string;
  /** 追加的全局配置行（YAML 片段）。 */
  configExtra?: string[];
  /** 仓库 .glm-review.yml 的内容；缺省 = 文件不存在（404，用默认配置）。 */
  repoConfigYaml?: string;
  /** PR 上已有的 review 列表（body 里可带 glm-review-bot 标记）。 */
  reviews?: Array<Record<string, unknown>>;
  /** 假 claude 的应答规则；缺省成功返回样例输出。 */
  claude?: FakeBinRule;
  /** 创建额度暂停文件（路径写进全局配置的 pauseFile）。 */
  paused?: boolean;
}

/** 写全局配置：白名单只有 REPO，pauseFile 指向临时目录内。 */
export function writeGlobalConfig(tmp: TmpEnv, options: WorldOptions = {}): string {
  const pausePath = path.join(tmp.baseDir, 'GLM_PAUSE');
  const lines = ['repos:', `  - ${REPO}`, `pauseFile: ${pausePath}`, ...(options.configExtra ?? [])];
  writeFileSync(tmp.configPath, `${lines.join('\n')}\n`);
  return pausePath;
}

/** 给假 gh / git / pgrep / claude 装上一次完整审查所需的全部应答规则。 */
export function setupFakeRepo(fake: FakeBin, options: WorldOptions = {}): void {
  fake.rule('gh', {
    match: ['pr', 'view', String(PR_NO), '--repo', REPO, '--json', PR_FIELDS],
    stdout: PR_VIEW_JSON,
  });
  fake.rule('gh', {
    match: ['api', `repos/${REPO}/pulls/${PR_NO}/reviews`, '--paginate'],
    stdout: JSON.stringify(options.reviews ?? []),
  });
  fake.rule('gh', repoConfigRule(options.repoConfigYaml));
  fake.rule('gh', {
    match: ['pr', 'view', String(PR_NO), '--repo', REPO, '--json', 'body'],
    stdout: JSON.stringify({ body: '支持多币种分账，汇率取自配置。' }),
  });
  fake.rule('gh', { match: ['pr', 'diff', String(PR_NO), '--repo', REPO], stdout: SAMPLE_DIFF });
  fake.rule('gh', { match: ['repo', 'clone'], mode: 'prefix', stdout: '' });
  fake.rule('gh', {
    match: ['api', '--method', 'POST', `repos/${REPO}/pulls/${PR_NO}/reviews`, '--input', '-'],
    stdout: JSON.stringify({ html_url: REVIEW_URL }),
  });
  // git 兜底：fetch / worktree add / worktree prune 全部成功（裸仓是假的，没有真实对象）。
  fake.rule('git', { stdout: '' });
  // pgrep 兜底：本机 claude 进程数 = 0（退出码 1、输出为空）。
  fake.rule('pgrep', { code: 1, stdout: '' });
  fake.rule('claude', options.claude ?? { stdout: claudeEnvelope(sampleClaudeOutput()) });
}

function repoConfigRule(yaml: string | undefined): FakeBinRule {
  if (yaml === undefined) {
    return { match: ['api', `repos/${REPO}/contents/.glm-review.yml`], code: 1, stderr: 'gh: Not Found' };
  }
  return {
    match: ['api', `repos/${REPO}/contents/.glm-review.yml`],
    stdout: JSON.stringify({ content: Buffer.from(yaml, 'utf8').toString('base64'), encoding: 'base64' }),
  };
}

/** 直接调 reviewPr 的世界（状态库由测试打开与关闭）。 */
export interface PipelineWorld {
  fake: FakeBin;
  tmp: TmpEnv;
  state: StateDb;
  clock: FakeClock;
  deps: ReviewPipelineDeps;
  pausePath: string;
  run(input?: Partial<ReviewPrInput>): Promise<ReviewOutcome>;
  claudeCalls(): FakeCall[];
  postCalls(): FakeCall[];
  previewOut(): string;
  progressLines(): string[];
  cleanup(): void;
}

export function createWorld(options: WorldOptions = {}): PipelineWorld {
  const tmp = createTmpEnv('glm-review-pipeline-test');
  const fake = createFakeBin({ bins: ['gh', 'claude', 'git', 'pgrep'] });
  const clock = fixedClock(options.clockAt ?? NON_PEAK_AT);
  const pausePath = writeGlobalConfig(tmp, options);
  if (options.paused === true) writeFileSync(pausePath, '');
  setupFakeRepo(fake, options);

  const state = openState(path.join(tmp.homeDir, 'state.db'));
  let preview = '';
  const progress: string[] = [];
  const deps: ReviewPipelineDeps = {
    exec,
    clock,
    env: fake.env,
    paths: resolvePaths(tmp.env),
    log: nullLogger,
    state,
    out: (text) => {
      preview += text;
    },
    progress: (text) => {
      progress.push(text);
    },
  };
  return {
    fake,
    tmp,
    state,
    clock,
    deps,
    pausePath,
    run: (input = {}) => reviewPr({ repo: REPO, pr: PR_NO, ...input }, deps),
    claudeCalls: () => fake.calls().filter((call) => call.bin === 'claude'),
    postCalls: () => fake.calls().filter((call) => call.bin === 'gh' && call.argv.includes('POST')),
    previewOut: () => preview,
    progressLines: () => progress,
    cleanup: () => {
      try {
        state.close();
      } catch {
        // 已关闭则忽略。
      }
      fake.remove();
      tmp.cleanup();
    },
  };
}

/** 命令层测试用的 CliContext：输出捕获 + fakebin PATH + 临时目录隔离。 */
export function createCliHarness(fake: FakeBin, tmp: TmpEnv, clock: FakeClock): {
  ctx: CliContext;
  stdout(): string;
  stderr(): string;
} {
  const env = { ...tmp.env, PATH: `${fake.binDir}:${process.env.PATH ?? ''}` };
  let out = '';
  let err = '';
  return {
    ctx: {
      deps: { exec, clock, env, paths: resolvePaths(env), log: nullLogger },
      stdout: (text) => {
        out += text;
      },
      stderr: (text) => {
        err += text;
      },
    },
    stdout: () => out,
    stderr: () => err,
  };
}

/** 建一个只含指定命令集合的世界（llm-smoke 等不需要 gh / git 的命令测试用）。 */
export function createCommandEnv(bins: string[], clockAt = NON_PEAK_AT): {
  fake: FakeBin;
  tmp: TmpEnv;
  clock: FakeClock;
  harness: ReturnType<typeof createCliHarness>;
  cleanup(): void;
} {
  const tmp = createTmpEnv('glm-review-pipeline-cmd-test');
  const fake = createFakeBin({ bins });
  const clock = fixedClock(clockAt);
  writeGlobalConfig(tmp);
  const harness = createCliHarness(fake, tmp, clock);
  return {
    fake,
    tmp,
    clock,
    harness,
    cleanup: () => {
      fake.remove();
      tmp.cleanup();
    },
  };
}
