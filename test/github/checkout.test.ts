/**
 * checkout.ts 的测试：假 gh / 假 git 下的克隆、按 sha fetch、worktree 与清理。
 */
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { assertValidSha, ensureCheckout, parseRepoSlug, pruneCheckouts } from '../../src/github/checkout.ts';
import { InvalidRepoSlugError, InvalidShaError } from '../../src/github/errors.ts';
import { resolvePaths } from '../../src/lib/paths.ts';
import { createFakeBin } from '../helpers/fakebin.ts';
import { createTmpEnv } from '../helpers/tmp.ts';
import { fakeDeps, REPO, SHA_A, SHA_B } from './helpers.ts';

const NO_HOOKS = 'core.hooksPath=/dev/null';
const CRED = 'credential.helper=!gh auth git-credential';

function checkoutPaths(tmp: ReturnType<typeof createTmpEnv>, repo = REPO): {
  repoDir: string;
  cloneDir: string;
  wtRoot: string;
  wt: (sha: string) => string;
} {
  const paths = resolvePaths(tmp.env);
  const [owner, name] = repo.split('/') as [string, string];
  const repoDir = path.join(paths.reposDir, owner, name);
  return {
    repoDir,
    cloneDir: path.join(repoDir, 'clone.git'),
    wtRoot: path.join(repoDir, 'wt'),
    wt: (sha: string) => path.join(repoDir, 'wt', sha.toLowerCase()),
  };
}

function fakeGitAllSuccess(fake: ReturnType<typeof createFakeBin>): void {
  fake.rule('git', { mode: 'prefix', match: ['-C'], stdout: '' });
}

test('ensureCheckout 首次：gh repo clone 裸仓 → 按 sha fetch → worktree add --detach', async () => {
  const fake = createFakeBin();
  const tmp = createTmpEnv('glm-review-github-checkout');
  try {
    fake.rule('gh', { mode: 'prefix', match: ['repo', 'clone'], stdout: '' });
    fakeGitAllSuccess(fake);
    const { cloneDir, wt } = checkoutPaths(tmp);
    const wtPath = await ensureCheckout(fakeDeps(fake, tmp), REPO, SHA_A.toUpperCase());

    // SHA 归一化为小写路径，目录与完成标记就绪，根目录只读。
    assert.equal(wtPath, wt(SHA_A));
    assert.ok(existsSync(wtPath));
    assert.ok(existsSync(`${wtPath}.done`));
    assert.equal(statSync(wtPath).mode & 0o777, 0o555);

    const ghCalls = fake.calls().filter((call) => call.bin === 'gh');
    assert.deepEqual(ghCalls, [
      { bin: 'gh', argv: ['repo', 'clone', REPO, cloneDir, '--', '--bare', '--quiet'], cwd: process.cwd(), stdin: '' },
    ]);

    const gitCalls = fake.calls().filter((call) => call.bin === 'git').map((call) => call.argv);
    assert.deepEqual(gitCalls, [
      ['-C', cloneDir, '-c', CRED, 'fetch', '--quiet', 'origin', SHA_A.toUpperCase()],
      ['-C', cloneDir, '-c', NO_HOOKS, 'worktree', 'add', '--detach', wt(SHA_A), SHA_A.toUpperCase()],
    ]);
  } finally {
    tmp.cleanup();
    fake.remove();
  }
});

test('ensureCheckout 同一 sha 第二次：零命令，直接复用路径', async () => {
  const fake = createFakeBin();
  const tmp = createTmpEnv('glm-review-github-checkout');
  try {
    fake.rule('gh', { mode: 'prefix', match: ['repo', 'clone'], stdout: '' });
    fakeGitAllSuccess(fake);
    const { wt } = checkoutPaths(tmp);

    const first = await ensureCheckout(fakeDeps(fake, tmp), REPO, SHA_A);
    const callsAfterFirst = fake.calls().length;
    const second = await ensureCheckout(fakeDeps(fake, tmp), REPO, SHA_A);

    assert.equal(second, first);
    assert.equal(fake.calls().length, callsAfterFirst, '第二次不应再执行任何 gh / git 命令（包括 fetch）');
  } finally {
    tmp.cleanup();
    fake.remove();
  }
});

test('ensureCheckout 换新 sha：不再 clone，只 fetch 新 sha 并加 worktree', async () => {
  const fake = createFakeBin();
  const tmp = createTmpEnv('glm-review-github-checkout');
  try {
    fake.rule('gh', { mode: 'prefix', match: ['repo', 'clone'], stdout: '' });
    fakeGitAllSuccess(fake);
    const { cloneDir, wt } = checkoutPaths(tmp);

    await ensureCheckout(fakeDeps(fake, tmp), REPO, SHA_A);
    // 假 gh 不会真的建目录：手工补上裸仓，模拟首次 gh repo clone 的效果。
    mkdirSync(cloneDir, { recursive: true });
    fake.resetCalls();
    await ensureCheckout(fakeDeps(fake, tmp), REPO, SHA_B);

    assert.equal(fake.calls().filter((call) => call.bin === 'gh').length, 0, '裸仓已存在，不应再 clone');
    const gitCalls = fake.calls().filter((call) => call.bin === 'git').map((call) => call.argv);
    assert.deepEqual(gitCalls, [
      ['-C', cloneDir, '-c', CRED, 'fetch', '--quiet', 'origin', SHA_B],
      ['-C', cloneDir, '-c', NO_HOOKS, 'worktree', 'add', '--detach', wt(SHA_B), SHA_B],
    ]);
    assert.ok(existsSync(`${wt(SHA_B)}.done`));
  } finally {
    tmp.cleanup();
    fake.remove();
  }
});

test('ensureCheckout 参数校验：非法 repo / sha 直接拒绝，不执行任何命令', async () => {
  const fake = createFakeBin();
  const tmp = createTmpEnv('glm-review-github-checkout');
  try {
    fakeGitAllSuccess(fake);
    const deps = fakeDeps(fake, tmp);
    await assert.rejects(ensureCheckout(deps, '../etc/passwd', SHA_A), InvalidRepoSlugError);
    await assert.rejects(ensureCheckout(deps, 'owner/name/extra', SHA_A), InvalidRepoSlugError);
    await assert.rejects(ensureCheckout(deps, REPO, 'HEAD; rm -rf /'), InvalidShaError);
    await assert.rejects(ensureCheckout(deps, REPO, 'abc123'), InvalidShaError);
    assert.equal(fake.calls().length, 0);
    assert.equal(parseRepoSlug(REPO).owner, 'jackeyhan-JH');
    assert.equal(parseRepoSlug(REPO).name, 'split-bill');
    assert.throws(() => assertValidSha('zzz'), InvalidShaError);
  } finally {
    tmp.cleanup();
    fake.remove();
  }
});

test('ensureCheckout worktree 失败：清理残留目录、补 worktree prune、不留完成标记', async () => {
  const fake = createFakeBin();
  const tmp = createTmpEnv('glm-review-github-checkout');
  try {
    fake.rule('gh', { mode: 'prefix', match: ['repo', 'clone'], stdout: '' });
    fakeGitAllSuccess(fake);
    const { cloneDir, wt } = checkoutPaths(tmp);
    // 模拟 gh repo clone 已完成（裸仓目录存在），只让 SHA_A 的 worktree add 失败
    //（前缀比兜底规则长，优先生效）。
    mkdirSync(cloneDir, { recursive: true });
    fake.rule('git', {
      mode: 'prefix',
      match: ['-C', cloneDir, '-c', NO_HOOKS, 'worktree', 'add', '--detach', wt(SHA_A)],
      stderr: 'fatal: invalid reference: 9f2b\n',
      code: 128,
    });
    const deps = fakeDeps(fake, tmp);

    await assert.rejects(ensureCheckout(deps, REPO, SHA_A), /invalid reference/);
    assert.ok(!existsSync(wt(SHA_A)), '失败的半成品目录应被清理');
    assert.ok(!existsSync(`${wt(SHA_A)}.done`), '不应留下完成标记');
    const gitArgv = fake.calls().filter((call) => call.bin === 'git').map((call) => call.argv);
    assert.deepEqual(gitArgv[gitArgv.length - 1], ['-C', cloneDir, 'worktree', 'prune'], '失败后应补 worktree prune');

    // 同一 sha 重试（换掉失败规则的影响：用新 fakebin 全部成功）——见下一个测试的常规路径。
  } finally {
    tmp.cleanup();
    fake.remove();
  }
});

test('pruneCheckouts：跨仓库只保留最近使用的 N 个，删掉旧的并 worktree prune', async () => {
  const fake = createFakeBin();
  const tmp = createTmpEnv('glm-review-github-checkout');
  try {
    fakeGitAllSuccess(fake);
    const paths = resolvePaths(tmp.env);
    const reposRoot = paths.reposDir;
    // 两个仓库共 4 个 worktree：o1/n1 有 sha1(旧)/sha2(新)，o2/n2 有 sha3(中)/sha4(最新)。
    const mk = (repoDir: string, sha: string, usedAt: Date, readonly: boolean): void => {
      const wtPath = path.join(repoDir, 'wt', sha);
      mkdirSync(wtPath, { recursive: true });
      writeFileSync(path.join(wtPath, 'file.txt'), 'x');
      writeFileSync(`${wtPath}.done`, `${sha}\n`);
      mkdirSync(path.join(repoDir, 'clone.git'), { recursive: true });
      utimesSync(wtPath, usedAt, usedAt);
      if (readonly) chmodSync(wtPath, 0o555);
    };
    const repoDir1 = path.join(reposRoot, 'o1', 'n1');
    const repoDir2 = path.join(reposRoot, 'o2', 'n2');
    const day = (n: number) => new Date(Date.UTC(2026, 9, n, 12));
    const sha = (n: number) => String(n).padStart(40, 'a');
    // o1/n1/sha1 故意置为只读，验证清理前会先恢复写权限。
    mk(repoDir1, sha(1), day(1), true);
    mk(repoDir1, sha(2), day(4), false);
    mk(repoDir2, sha(3), day(2), false);
    mk(repoDir2, sha(4), day(5), false);

    const result = await pruneCheckouts(fakeDeps(fake, tmp), 2);

    assert.deepEqual(result.kept, [path.join(repoDir2, 'wt', sha(4)), path.join(repoDir1, 'wt', sha(2))]);
    assert.deepEqual(result.removed, [
      path.join(repoDir2, 'wt', sha(3)),
      path.join(repoDir1, 'wt', sha(1)),
    ]);
    assert.ok(existsSync(path.join(repoDir1, 'wt', sha(2))));
    assert.ok(!existsSync(path.join(repoDir1, 'wt', sha(1))));
    assert.ok(!existsSync(path.join(repoDir1, 'wt', `${sha(1)}.done`)));
    assert.ok(!existsSync(path.join(repoDir2, 'wt', sha(3))));

    // 有删除的两个仓库都补了 worktree prune（顺序不定，按集合断言）。
    const prunes = fake
      .calls()
      .filter((call) => call.bin === 'git' && call.argv.includes('prune'))
      .map((call) => call.argv.join(' '))
      .sort();
    assert.deepEqual(prunes, [`-C ${path.join(repoDir1, 'clone.git')} worktree prune`, `-C ${path.join(repoDir2, 'clone.git')} worktree prune`]);
  } finally {
    tmp.cleanup();
    fake.remove();
  }
});

test('pruneCheckouts：缓存目录不存在时返回空，不执行命令', async () => {
  const fake = createFakeBin();
  const tmp = createTmpEnv('glm-review-github-checkout');
  try {
    fakeGitAllSuccess(fake);
    const result = await pruneCheckouts(fakeDeps(fake, tmp), 3);
    assert.deepEqual(result, { kept: [], removed: [] });
    assert.equal(fake.calls().length, 0);
  } finally {
    tmp.cleanup();
    fake.remove();
  }
});

test('pruneCheckouts：keep 覆盖全部时不删任何目录', async () => {
  const fake = createFakeBin();
  const tmp = createTmpEnv('glm-review-github-checkout');
  try {
    fakeGitAllSuccess(fake);
    const { wt } = checkoutPaths(tmp);
    const a = wt('b'.repeat(40));
    const b = wt('c'.repeat(40));
    for (const dir of [a, b]) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(`${dir}.done`, 'x');
    }
    const result = await pruneCheckouts(fakeDeps(fake, tmp), 5);
    assert.deepEqual(result.removed, []);
    assert.ok(existsSync(a) && existsSync(b));
    assert.equal(fake.calls().length, 0, '没有删除就不需要 worktree prune');
  } finally {
    rmSync(resolvePaths(tmp.env).reposDir, { recursive: true, force: true });
    tmp.cleanup();
    fake.remove();
  }
});
