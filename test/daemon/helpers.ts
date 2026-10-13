/**
 * test/daemon/ 共用：搭一个「假 gh + 假 git + 假 claude + 假时钟 + 临时状态库」的
 * 守护进程世界，直接驱动 runDaemon / runCli。全程不碰真实网络 / 真实 gh / 真实 claude
 * （见 #1 技术约定）。仓库与 PR 的形态在 RepoSpec / PrSpec 里描述，测试中途改完
 * 调 rebuild() 换一套新的 fakebin 应答（fakebin 规则是静态的，重建最简单可靠）。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fixedClock, type FakeClock } from '../../src/lib/clock.ts';
import { loadGlobalConfig, type GlobalConfig } from '../../src/config/global.ts';
import { exec } from '../../src/lib/exec.ts';
import type { Logger, LogLevel, LogFields } from '../../src/lib/log.ts';
import { resolvePaths } from '../../src/lib/paths.ts';
import type { CliContext } from '../../src/lib/types.ts';
import { runCli } from '../../src/cli.ts';
import { runDaemon, type DaemonRunResult } from '../../src/daemon/daemon.ts';
import { createRepoConfigCache, pollOnce, type PollSummary } from '../../src/daemon/poller.ts';
import type { GraceWaiter, WorkerDeps } from '../../src/daemon/worker.ts';
import { openState, type StateDb } from '../../src/state/db.ts';
import { createFakeBin, type FakeBin, type FakeBinRule, type FakeCall } from '../helpers/fakebin.ts';
import { createTmpEnv, type TmpEnv } from '../helpers/tmp.ts';

/** 与 src/github/prs.ts 的 PR_FIELDS 一致（fakebin 精确匹配用）。 */
const PR_FIELDS =
  'number,title,author,url,headRefOid,baseRefName,headRefName,isDraft,labels,updatedAt,state';

/** 非高峰：2026-10-12（周一）00:00Z = 北京 08:00。 */
export const NON_PEAK_AT = '2026-10-12T00:00:00Z';
/** 高峰：2026-10-12（周一）07:00Z = 北京 15:00，本段 10:00Z（北京 18:00）结束。 */
export const PEAK_AT = '2026-10-12T07:00:00Z';
/** 峰后：2026-10-12（周一）10:30Z = 北京 18:30。 */
export const AFTER_PEAK_AT = '2026-10-12T10:30:00Z';

export const REPO_A = 'Jackeyhan-JH/split-bill';
export const REPO_B = 'Jackeyhan-JH/glm-toolbox';
export const PR_A = 45;
export const PR_B = 7;
export const SHA_A1 = '9f2b1c3a4d5e6f708192a3b4c5d6e7f8091a2b3c';
export const SHA_A2 = 'a51c9d3e7f2b4a6c8d0e1f2a3b4c5d6e7f8a9b0c';
export const SHA_B1 = 'bb2d4e6f8a0c1e3d5f7a9b1c3e5d7f9a1b3c5d7e';

const FIXTURES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const SAMPLE_DIFF = readFileSync(path.join(FIXTURES_DIR, 'sample.diff'), 'utf8');

/** 一条 PR 会话评论（fake gh api 返回值）。 */
export interface CommentSpec {
  id: number;
  /** 缺省仓库 owner。 */
  author?: string;
  body: string;
  createdAt: string;
}

/** 一条开放 PR 的形态（fake gh pr list / pr view 返回值）。 */
export interface PrSpec {
  number: number;
  headSha: string;
  title?: string;
  author?: string;
  isDraft?: boolean;
  labels?: string[];
  /** gh 的 state，缺省 OPEN。 */
  state?: string;
  comments?: CommentSpec[];
  /** 模拟 pr view 失败（让 reviewPr 的 getPr 阶段抛错）。 */
  viewError?: { code: number; stderr: string };
}

/** 一个白名单仓库的形态。 */
export interface RepoSpec {
  repo: string;
  prs: PrSpec[];
  /** 模拟 pr list 失败（404 / 限流等）。 */
  listError?: { code: number; stderr: string };
}

export interface DaemonWorldOptions {
  clockAt?: string;
  repos?: RepoSpec[];
  /** 追加到全局配置的 YAML 行（覆盖默认时写在后面）。 */
  configExtra?: string[];
  /** 假 claude 的应答规则；缺省成功返回样例输出。 */
  claude?: FakeBinRule;
}

/** 内存日志器：捕获全部日志行，测试可断言。 */
export interface MemoryLogger extends Logger {
  entries: Array<{ level: LogLevel; msg: string; fields?: LogFields }>;
  lines(level?: LogLevel): string[];
}

export function createMemoryLogger(): MemoryLogger {
  const entries: MemoryLogger['entries'] = [];
  const make = (level: LogLevel) => (msg: string, fields?: LogFields) => {
    entries.push({ level, msg, fields });
  };
  return {
    entries,
    debug: make('debug'),
    info: make('info'),
    warn: make('warn'),
    error: make('error'),
    lines: (level?: LogLevel) =>
      entries
        .filter((entry) => level === undefined || entry.level === level)
        .map((entry) => `${entry.level} ${entry.msg}`),
  };
}

/** claude 的 --output-format json 外壳，包住结构化输出（与样例 diff 行号匹配）。 */
export function claudeEnvelope(): string {
  return JSON.stringify({
    type: 'result',
    result: '',
    structured_output: {
      summary: '整体实现清晰，问题集中在参数校验。',
      findings: [
        {
          severity: 'major',
          file: 'src/calc.ts',
          line: 2,
          title: '参数校验漏了 undefined',
          body: 'undefined 参与 NaN 比较返回 false，不会被 Number.isFinite 拦住。',
        },
        {
          severity: 'minor',
          file: 'src/calc.ts',
          line: 5,
          title: '错误信息缺少参数名',
          body: '排查时不知道是哪个参数不合法。',
        },
      ],
    },
    is_error: false,
    usage: { input_tokens: 120, output_tokens: 80 },
    total_cost_usd: 0.012,
    duration_ms: 321,
    num_turns: 1,
  });
}

/** gh 的 PR JSON（author / labels 是对象）。 */
function prJson(spec: PrSpec): Record<string, unknown> {
  return {
    number: spec.number,
    title: spec.title ?? '支持多币种分账',
    author: { login: spec.author ?? 'Jackeyhan-JH' },
    url: `https://github.com/x/y/pull/${spec.number}`,
    headRefOid: spec.headSha,
    baseRefName: 'main',
    headRefName: `feature-${spec.number}`,
    isDraft: spec.isDraft === true,
    labels: (spec.labels ?? []).map((name) => ({ name })),
    updatedAt: '2026-10-11T00:00:00Z',
    state: spec.state ?? 'OPEN',
  };
}

export interface DaemonWorld {
  tmp: TmpEnv;
  clock: FakeClock;
  state: StateDb;
  log: MemoryLogger;
  /** 当前 fakebin（rebuild 后会换实例）。 */
  fake: FakeBin;
  /** 可变的仓库形态；改完调 rebuild()。 */
  repos: RepoSpec[];
  runDaemon(options?: RunDaemonWorldOptions): Promise<DaemonRunResult>;
  /** 只跑一轮轮询（不领取执行），返回汇总；仓库配置缓存跨调用复用。 */
  pollOnce(): Promise<PollSummary>;
  /** 走 runCli 全链路（含子命令分发与命令层文案）。 */
  runCli(argv: string[]): Promise<number>;
  harness: { stdout(): string; stderr(): string };
  rebuild(): void;
  claudeCalls(): FakeCall[];
  postCalls(): FakeCall[];
  ghListCalls(): FakeCall[];
  configCalls(): FakeCall[];
  cleanup(): void;
}

export interface RunDaemonWorldOptions {
  once?: boolean;
  dryRun?: boolean;
  /** 注入替代 reviewPr（并发上限等测试用）。 */
  review?: WorkerDeps['review'];
  /** 注入限时等待器（优雅退出超时路径测试用）。 */
  waitAll?: GraceWaiter;
}

export function createDaemonWorld(options: DaemonWorldOptions = {}): DaemonWorld {
  const tmp = createTmpEnv('glm-review-daemon-test');
  const clock = fixedClock(options.clockAt ?? NON_PEAK_AT);
  const state = openState(path.join(tmp.homeDir, 'state.db'));
  const log = createMemoryLogger();
  const repos = options.repos ?? [];
  const claudeRule = options.claude ?? { stdout: claudeEnvelope() };

  writeConfig(tmp, repos, options.configExtra ?? []);
  const config: GlobalConfig = loadGlobalConfig(tmp.configPath, { log });
  // 仓库配置缓存：deps 每次取用时的 ctx（rebuild 换 fakebin 后 env 已更新）。
  const repoConfigCache = createRepoConfigCache(() => ({
    exec: ctx.deps.exec,
    env: ctx.deps.env,
    now: () => clock.now(),
  }));

  let fake = createFakeBin({ bins: ['gh', 'claude', 'git', 'pgrep'] });
  let out = '';
  let err = '';

  const installRules = (): void => {
    for (const repoSpec of repos) {
      const { repo } = repoSpec;
      if (repoSpec.listError !== undefined) {
        fake.rule('gh', {
          match: ['pr', 'list', '--repo', repo, '--state', 'open', '--limit', '100', '--json', PR_FIELDS],
          code: repoSpec.listError.code,
          stderr: repoSpec.listError.stderr,
        });
      } else {
        fake.rule('gh', {
          match: ['pr', 'list', '--repo', repo, '--state', 'open', '--limit', '100', '--json', PR_FIELDS],
          stdout: JSON.stringify(repoSpec.prs.map(prJson)),
        });
      }
      for (const pr of repoSpec.prs) {
        const prNo = String(pr.number);
        if (pr.viewError !== undefined) {
          fake.rule('gh', {
            match: ['pr', 'view', prNo, '--repo', repo, '--json', PR_FIELDS],
            code: pr.viewError.code,
            stderr: pr.viewError.stderr,
          });
        } else {
          fake.rule('gh', {
            match: ['pr', 'view', prNo, '--repo', repo, '--json', PR_FIELDS],
            stdout: JSON.stringify(prJson(pr)),
          });
        }
        fake.rule('gh', {
          match: ['pr', 'view', prNo, '--repo', repo, '--json', 'body'],
          stdout: JSON.stringify({ body: '支持多币种分账，汇率取自配置。' }),
        });
        fake.rule('gh', { match: ['pr', 'diff', prNo, '--repo', repo], stdout: SAMPLE_DIFF });
        fake.rule('gh', {
          match: ['api', `repos/${repo}/pulls/${pr.number}/reviews`, '--paginate'],
          stdout: JSON.stringify([]),
        });
        fake.rule('gh', {
          match: ['api', `repos/${repo}/issues/${pr.number}/comments`, '--paginate'],
          stdout: JSON.stringify(
            (pr.comments ?? []).map((comment) => ({
              id: comment.id,
              user: { login: comment.author ?? repo.split('/')[0] },
              body: comment.body,
              created_at: comment.createdAt,
            })),
          ),
        });
        fake.rule('gh', {
          match: ['api', '--method', 'POST', `repos/${repo}/pulls/${pr.number}/reviews`, '--input', '-'],
          stdout: JSON.stringify({ html_url: `https://github.com/${repo}/pull/${pr.number}#pullrequestreview-1` }),
        });
      }
      fake.rule('gh', {
        match: ['api', `repos/${repo}/contents/.glm-review.yml`],
        code: 1,
        stderr: 'gh: Not Found',
      });
    }
    fake.rule('gh', { match: ['repo', 'clone'], mode: 'prefix', stdout: '' });
    fake.rule('git', { stdout: '' });
    fake.rule('pgrep', { code: 1, stdout: '' });
    fake.rule('claude', claudeRule);
  };

  const makeHarness = (resetOutput: boolean): CliContext => {
    if (resetOutput) {
      out = '';
      err = '';
    }
    const env = { ...tmp.env, PATH: `${fake.binDir}:${process.env.PATH ?? ''}` };
    return {
      deps: { exec, clock, env, paths: resolvePaths(env), log },
      stdout: (text: string) => {
        out += text;
      },
      stderr: (text: string) => {
        err += text;
      },
    };
  };

  installRules();
  let ctx = makeHarness(true);

  const world: DaemonWorld = {
    tmp,
    clock,
    state,
    log,
    fake,
    repos,
    harness: {
      stdout: () => out,
      stderr: () => err,
    },
    rebuild(): void {
      // 保留调用记录：rebuild 只换应答规则，claudeCalls() 等计数器应跨 rebuild 累计。
      let previousCalls: string | undefined;
      try {
        previousCalls = readFileSync(path.join(fake.binDir, 'calls.jsonl'), 'utf8');
      } catch {
        previousCalls = undefined;
      }
      fake.remove();
      fake = createFakeBin({ bins: ['gh', 'claude', 'git', 'pgrep'] });
      if (previousCalls !== undefined && previousCalls.trim() !== '') {
        writeFileSync(path.join(fake.binDir, 'calls.jsonl'), previousCalls);
      }
      world.fake = fake;
      installRules();
      ctx = makeHarness(false);
    },
    runDaemon(runOptions = { once: true }) {
      return runDaemon(
        { once: runOptions.once !== false, dryRun: runOptions.dryRun === true },
        {
          exec: ctx.deps.exec,
          clock,
          paths: ctx.deps.paths,
          env: ctx.deps.env,
          log,
          state,
          config,
          ...(runOptions.review === undefined ? {} : { review: runOptions.review }),
          ...(runOptions.waitAll === undefined ? {} : { waitAll: runOptions.waitAll }),
          out: (text: string) => ctx.stdout(`${text}\n`),
          installSignals: () => () => {},
        },
      );
    },
    pollOnce() {
      return pollOnce(
        {
          exec: ctx.deps.exec,
          clock,
          paths: ctx.deps.paths,
          env: ctx.deps.env,
          log,
          state,
          config,
        },
        repoConfigCache,
      );
    },
    async runCli(argv: string[]) {
      return runCli(argv, { ctx });
    },
    claudeCalls: () => fake.calls().filter((call) => call.bin === 'claude'),
    postCalls: () => fake.calls().filter((call) => call.bin === 'gh' && call.argv.includes('POST')),
    ghListCalls: () =>
      fake.calls().filter((call) => call.bin === 'gh' && call.argv.includes('list') && call.argv.includes('--state')),
    configCalls: () =>
      fake.calls().filter((call) => call.bin === 'gh' && call.argv.some((a) => a.includes('.glm-review.yml'))),
    cleanup(): void {
      try {
        state.close();
      } catch {
        // 已关闭则忽略。
      }
      fake.remove();
      tmp.cleanup();
    },
  };
  return world;
}

/** 写全局配置：白名单 = repos 里出现的仓库，pauseFile / 各目录都在临时环境内。 */
function writeConfig(tmp: TmpEnv, repos: RepoSpec[], extra: string[]): void {
  const lines = [
    ...(repos.length === 0 ? ['repos: []'] : ['repos:', ...repos.map((r) => `  - ${r.repo}`)]),
    'pollIntervalSec: 30',
    `pauseFile: ${path.join(tmp.baseDir, 'GLM_PAUSE')}`,
    ...extra,
  ];
  writeFileSync(tmp.configPath, `${lines.join('\n')}\n`);
}
