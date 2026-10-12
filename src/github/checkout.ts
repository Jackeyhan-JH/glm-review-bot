/**
 * PR head 代码的本地只读缓存检出（见 #6）。
 *
 * 目录布局（reposDir = GLM_REVIEW_HOME/repos）：
 *   repos/<owner>/<name>/clone.git/     裸仓缓存（首次 `gh repo clone -- --bare`，之后按 sha fetch）
 *   repos/<owner>/<name>/wt/<sha>/      只读 worktree（`git worktree add --detach`）
 *   repos/<owner>/<name>/wt/<sha>.done  检出完成标记（存在 = 该 sha 已就绪，直接复用）
 *
 * - 同一 sha 第二次调用零命令（读标记直接返回路径）；
 * - fetch / worktree 通过 `-c credential.helper=!gh auth git-credential` 复用 gh 的登录凭证，
 *   本模块不读 token；worktree 时 `-c core.hooksPath=/dev/null` 禁止执行任何钩子；
 * - 只跑 clone / fetch / worktree，绝不在被审仓库里执行钩子、npm 脚本或构建命令；
 * - worktree 根目录置为只读（0555）；完整的只读保证由 #8 的只读工具白名单负责；
 * - pruneCheckouts(keep) 跨仓库按「最近使用」只保留 N 个 worktree。
 */
import { chmodSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { InvalidRepoSlugError, InvalidShaError } from './errors.ts';
import { runGh, runGit, type GithubDeps } from './run.ts';

const REPO_SLUG_RE = /^[\w.-]+\/[\w.-]+$/;
const SHA_RE = /^(?:[0-9a-fA-F]{40}|[0-9a-fA-F]{64})$/;
/** 复用 gh 的登录凭证做 fetch（git 调 gh，本模块不碰 token）。 */
const GH_CREDENTIAL_HELPER = 'credential.helper=!gh auth git-credential';
/** 禁止在检出 / worktree 过程中执行任何 git 钩子。 */
const NO_HOOKS = 'core.hooksPath=/dev/null';

const CLONE_TIMEOUT_MS = 600_000;
const FETCH_TIMEOUT_MS = 600_000;
const WORKTREE_TIMEOUT_MS = 600_000;

/** 校验并拆分 owner/name（拼本地路径前必须校验，防注入）。 */
export function parseRepoSlug(repo: string): { owner: string; name: string } {
  if (!REPO_SLUG_RE.test(repo)) {
    throw new InvalidRepoSlugError(`仓库标识非法（应为 owner/name）：${repo}`);
  }
  const [owner, name] = repo.split('/') as [string, string];
  return { owner, name };
}

export function assertValidSha(sha: string): void {
  if (!SHA_RE.test(sha)) {
    throw new InvalidShaError(`commit SHA 非法（应为 40 / 64 位十六进制）：${sha}`);
  }
}

/** 同一 (repo, sha) 的并发调用共享同一次检出。 */
const inflight = new Map<string, Promise<string>>();

/** 确保 PR head 的只读检出存在，返回 worktree 路径。 */
export async function ensureCheckout(deps: GithubDeps, repo: string, headSha: string): Promise<string> {
  parseRepoSlug(repo);
  assertValidSha(headSha);
  const key = `${repo}@${headSha.toLowerCase()}`;
  const running = inflight.get(key);
  if (running !== undefined) return running;
  const task = ensureCheckoutSlow(deps, repo, headSha).finally(() => {
    inflight.delete(key);
  });
  inflight.set(key, task);
  return task;
}

async function ensureCheckoutSlow(deps: GithubDeps, repo: string, headSha: string): Promise<string> {
  const { owner, name } = parseRepoSlug(repo);
  const repoDir = path.join(deps.paths.reposDir, owner, name);
  const cloneDir = path.join(repoDir, 'clone.git');
  const wtRoot = path.join(repoDir, 'wt');
  const wtPath = path.join(wtRoot, headSha.toLowerCase());
  const stampPath = `${wtPath}.done`;
  mkdirSync(wtRoot, { recursive: true });

  if (!existsSync(stampPath)) {
    if (!existsSync(cloneDir)) {
      await runGh(deps, ['repo', 'clone', repo, cloneDir, '--', '--bare', '--quiet'], {
        timeoutMs: CLONE_TIMEOUT_MS,
      });
    }
    await runGit(deps, ['-C', cloneDir, '-c', GH_CREDENTIAL_HELPER, 'fetch', '--quiet', 'origin', headSha], {
      timeoutMs: FETCH_TIMEOUT_MS,
    });
    // 预置空目录：git worktree add 允许目标为空目录；失败的残留会在下面清掉。
    mkdirSync(wtPath, { recursive: true });
    try {
      await runGit(deps, ['-C', cloneDir, '-c', NO_HOOKS, 'worktree', 'add', '--detach', wtPath, headSha], {
        timeoutMs: WORKTREE_TIMEOUT_MS,
      });
    } catch (err) {
      rmSync(wtPath, { recursive: true, force: true });
      // 清理裸仓里可能残留的 worktree 登记，下一次调用可以重试。
      try {
        if (existsSync(cloneDir)) {
          await runGit(deps, ['-C', cloneDir, 'worktree', 'prune']);
        }
      } catch (pruneErr) {
        deps.log?.warn('git worktree prune 失败', { err: String(pruneErr) });
      }
      throw err;
    }
    markReadOnly(deps, wtPath);
    writeFileSync(stampPath, `${headSha}\n`);
  }
  touchDir(deps, wtPath);
  return wtPath;
}

/** worktree 根目录置只读，防误写（失败只告警，不影响检出结果）。 */
function markReadOnly(deps: GithubDeps, wtPath: string): void {
  try {
    chmodSync(wtPath, 0o555);
  } catch (err) {
    deps.log?.warn('置只读失败', { wtPath, err: String(err) });
  }
}

/** 刷新目录 mtime = 最近使用时间（prune 按「最近使用」保留）。 */
function touchDir(deps: GithubDeps, wtPath: string): void {
  try {
    const now = deps.clock.now();
    utimesSync(wtPath, now, now);
  } catch (err) {
    deps.log?.warn('刷新使用时间失败', { wtPath, err: String(err) });
  }
}

export interface PruneResult {
  /** 保留的 worktree 路径（按最近使用在前）。 */
  kept: string[];
  /** 删除的 worktree 路径（按最近使用在前）。 */
  removed: string[];
}

interface CheckoutEntry {
  wtPath: string;
  stampPath: string;
  repoDir: string;
  usedAtMs: number;
}

/** 跨全部缓存仓库，只保留最近使用的 keep 个 worktree，其余删除。 */
export async function pruneCheckouts(deps: GithubDeps, keep = 5): Promise<PruneResult> {
  const entries = collectCheckouts(deps.paths.reposDir);
  entries.sort((a, b) => b.usedAtMs - a.usedAtMs);
  const removedEntries = entries.slice(keep);
  const prunedRepos = new Set<string>();
  for (const entry of removedEntries) {
    try {
      chmodSync(entry.wtPath, 0o755);
    } catch {
      // 目录可能已不存在，继续尝试删除。
    }
    rmSync(entry.wtPath, { recursive: true, force: true });
    rmSync(entry.stampPath, { force: true });
    prunedRepos.add(entry.repoDir);
  }
  for (const repoDir of prunedRepos) {
    const cloneDir = path.join(repoDir, 'clone.git');
    if (!existsSync(cloneDir)) continue;
    try {
      await runGit(deps, ['-C', cloneDir, 'worktree', 'prune']);
    } catch (err) {
      deps.log?.warn('git worktree prune 失败', { repoDir, err: String(err) });
    }
  }
  return {
    kept: entries.slice(0, keep).map((entry) => entry.wtPath),
    removed: removedEntries.map((entry) => entry.wtPath),
  };
}

function collectCheckouts(reposRoot: string): CheckoutEntry[] {
  if (!existsSync(reposRoot)) return [];
  const entries: CheckoutEntry[] = [];
  for (const owner of listDirs(reposRoot)) {
    for (const name of listDirs(path.join(reposRoot, owner))) {
      const repoDir = path.join(reposRoot, owner, name);
      const wtRoot = path.join(repoDir, 'wt');
      if (!existsSync(wtRoot)) continue;
      for (const sha of listDirs(wtRoot)) {
        const wtPath = path.join(wtRoot, sha);
        try {
          entries.push({ wtPath, stampPath: `${wtPath}.done`, repoDir, usedAtMs: statSync(wtPath).mtimeMs });
        } catch {
          // 目录恰好被并发删除则跳过。
        }
      }
    }
  }
  return entries;
}

function listDirs(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}
