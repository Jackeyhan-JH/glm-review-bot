/**
 * errors.ts 的测试：gh / git 失败输出 → 可识别错误类型（中文信息）的映射。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixedClock } from '../../src/lib/clock.ts';
import { nullLogger } from '../../src/lib/log.ts';
import { resolvePaths } from '../../src/lib/paths.ts';
import {
  GhCommandError,
  GhNetworkError,
  GhNotLoggedInError,
  GhUnavailableError,
  RateLimitError,
  RepoNotFoundError,
  mapCommandFailure,
  parseRetrySeconds,
} from '../../src/github/errors.ts';
import type { GithubDeps } from '../../src/github/run.ts';
import { getPr, listOpenPrs } from '../../src/github/prs.ts';
import { listReviews } from '../../src/github/reviews.ts';
import { createFakeBin } from '../helpers/fakebin.ts';
import { createTmpEnv } from '../helpers/tmp.ts';
import { fakeDeps, REPO } from './helpers.ts';

test('未登录：映射为 GhNotLoggedInError，中文提示 gh auth login', async () => {
  const fake = createFakeBin();
  const tmp = createTmpEnv('glm-review-github-errors');
  try {
    fake.rule('gh', {
      mode: 'prefix',
      match: ['pr', 'view'],
      stderr: 'gh: To get started with GitHub CLI, please run: gh auth login.\n',
      code: 4,
    });
    await assert.rejects(
      getPr(fakeDeps(fake, tmp), REPO, 45),
      (err: unknown) => {
        assert.ok(err instanceof GhNotLoggedInError);
        assert.equal(err.name, 'GhNotLoggedInError');
        assert.match(err.message, /未登录/);
        assert.match(err.message, /gh auth login/);
        return true;
      },
    );
  } finally {
    tmp.cleanup();
    fake.remove();
  }
});

test('仓库 404：Could not resolve to a Repository → RepoNotFoundError', async () => {
  const fake = createFakeBin();
  const tmp = createTmpEnv('glm-review-github-errors');
  try {
    fake.rule('gh', {
      mode: 'prefix',
      match: ['pr', 'list'],
      stderr: "gh: GraphQL: Could not resolve to a Repository with the name 'nope/missing'. (repository)\n",
      code: 1,
    });
    await assert.rejects(
      listOpenPrs(fakeDeps(fake, tmp), 'nope/missing'),
      (err: unknown) => {
        assert.ok(err instanceof RepoNotFoundError);
        assert.equal(err.name, 'RepoNotFoundError');
        assert.match(err.message, /仓库不存在或当前账号无权限/);
        assert.match(err.message, /Could not resolve to a Repository/);
        return true;
      },
    );
  } finally {
    tmp.cleanup();
    fake.remove();
  }
});

test('PR 404：Could not resolve to a PullRequest → RepoNotFoundError（提示 PR）', async () => {
  const fake = createFakeBin();
  const tmp = createTmpEnv('glm-review-github-errors');
  try {
    fake.rule('gh', {
      mode: 'prefix',
      match: ['pr', 'view'],
      stderr: "gh: GraphQL: Could not resolve to a PullRequest with the number of 999. (repository)\n",
      code: 1,
    });
    await assert.rejects(
      getPr(fakeDeps(fake, tmp), REPO, 999),
      (err: unknown) => {
        assert.ok(err instanceof RepoNotFoundError);
        assert.match(err.message, /PR/);
        return true;
      },
    );
  } finally {
    tmp.cleanup();
    fake.remove();
  }
});

test('限流：API rate limit exceeded → RateLimitError，解析建议等待秒数', async () => {
  const fake = createFakeBin();
  const tmp = createTmpEnv('glm-review-github-errors');
  try {
    fake.rule('gh', {
      mode: 'prefix',
      match: ['api'],
      stderr: 'gh: API rate limit exceeded for 12345678. Re-trying in 57 seconds 00:00:57 (try #1).\n',
      code: 1,
    });
    await assert.rejects(
      listReviews(fakeDeps(fake, tmp), REPO, 45),
      (err: unknown) => {
        assert.ok(err instanceof RateLimitError);
        assert.equal(err.name, 'RateLimitError');
        assert.equal(err.retryAfterSeconds, 57);
        assert.match(err.message, /限流/);
        assert.match(err.message, /57 秒/);
        return true;
      },
    );
  } finally {
    tmp.cleanup();
    fake.remove();
  }
});

test('网络错误：DNS / 连接失败映射为 GhNetworkError', async () => {
  const fake = createFakeBin();
  const tmp = createTmpEnv('glm-review-github-errors');
  try {
    fake.rule('gh', {
      mode: 'prefix',
      match: ['api'],
      stderr: 'gh: error connecting to api.github.com: dial tcp: lookup api.github.com: no such host\n',
      code: 1,
    });
    await assert.rejects(
      listReviews(fakeDeps(fake, tmp), REPO, 45),
      (err: unknown) => {
        assert.ok(err instanceof GhNetworkError);
        assert.equal(err.name, 'GhNetworkError');
        assert.match(err.message, /网络错误/);
        return true;
      },
    );
  } finally {
    tmp.cleanup();
    fake.remove();
  }
});

test('无法执行 gh 命令（spawn 失败）→ GhUnavailableError', async () => {
  const tmp = createTmpEnv('glm-review-github-errors');
  try {
    const deps: GithubDeps = {
      exec: async () => {
        throw new Error('spawn gh ENOENT');
      },
      clock: fixedClock('2026-10-12T00:00:00Z'),
      env: tmp.env,
      paths: resolvePaths(tmp.env),
      log: nullLogger,
    };
    await assert.rejects(
      getPr(deps, REPO, 45),
      (err: unknown) => {
        assert.ok(err instanceof GhUnavailableError);
        assert.match(err.message, /无法执行 gh/);
        assert.match(err.message, /ENOENT/);
        return true;
      },
    );
  } finally {
    tmp.cleanup();
  }
});

test('mapCommandFailure：超时 → GhNetworkError；其余非零退出 → GhCommandError', () => {
  const timeoutErr = mapCommandFailure('gh', ['pr', 'list'], {
    code: -1,
    stdout: '',
    stderr: '',
    timedOut: true,
    durationMs: 120_000,
  });
  assert.ok(timeoutErr instanceof GhNetworkError);
  assert.match(timeoutErr.message, /超时/);

  const otherErr = mapCommandFailure('gh', ['pr', 'view', '1'], {
    code: 1,
    stdout: '',
    stderr: 'gh: 一些别的错误\n',
    timedOut: false,
    durationMs: 10,
  });
  assert.ok(otherErr instanceof GhCommandError);
  assert.equal(otherErr.exitCode, 1);
  assert.equal(otherErr.stderr, 'gh: 一些别的错误\n');
  assert.match(otherErr.message, /一些别的错误/);
});

test('parseRetrySeconds：解析各种等待提示，默认 1 小时', () => {
  assert.equal(parseRetrySeconds('Re-trying in 57 seconds 00:00:57'), 57);
  assert.equal(parseRetrySeconds('Re-trying in 5 minutes'), 300);
  assert.equal(parseRetrySeconds('please retry after 2 hours'), 7200);
  assert.equal(parseRetrySeconds('You have exceeded a secondary rate limit'), 3600);
  assert.equal(parseRetrySeconds('完全无关的文本'), 3600);
});
