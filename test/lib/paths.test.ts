import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { test } from 'node:test';
import path from 'node:path';
import { ensureDirs, resolvePaths } from '../../src/lib/paths.ts';
import { createTmpEnv } from '../helpers/tmp.ts';

test('paths 默认落在用户主目录下', () => {
  const paths = resolvePaths({ HOME: '/tmp/fake-home' });
  assert.equal(paths.home, path.join('/tmp/fake-home', '.local', 'share', 'glm-review-bot'));
  assert.equal(paths.configFile, path.join('/tmp/fake-home', '.config', 'glm-review-bot', 'config.yml'));
  assert.equal(paths.stateDb, path.join(paths.home, 'state.db'));
  assert.equal(paths.logsDir, path.join(paths.home, 'logs'));
  assert.equal(paths.reposDir, path.join(paths.home, 'repos'));
  assert.equal(paths.lockFile, path.join(paths.home, 'daemon.lock'));
});

test('paths 支持 GLM_REVIEW_HOME 与 GLM_REVIEW_CONFIG 覆盖', () => {
  const paths = resolvePaths({
    HOME: '/tmp/fake-home',
    GLM_REVIEW_HOME: '/data/glm-review',
    GLM_REVIEW_CONFIG: '/conf/glm-review.yml',
  });
  assert.equal(paths.home, '/data/glm-review');
  assert.equal(paths.stateDb, '/data/glm-review/state.db');
  assert.equal(paths.configFile, '/conf/glm-review.yml');
});

test('paths 视空字符串环境变量为未设置', () => {
  const paths = resolvePaths({ HOME: '/tmp/fake-home', GLM_REVIEW_HOME: '', GLM_REVIEW_CONFIG: '' });
  assert.equal(paths.home, path.join('/tmp/fake-home', '.local', 'share', 'glm-review-bot'));
  assert.equal(paths.configFile, path.join('/tmp/fake-home', '.config', 'glm-review-bot', 'config.yml'));
});

test('ensureDirs 创建 home/logs/repos 目录', () => {
  const tmp = createTmpEnv('glm-review-paths-test');
  try {
    const home = path.join(tmp.baseDir, 'data-home');
    const paths = resolvePaths({ GLM_REVIEW_HOME: home });
    ensureDirs(paths);
    assert.ok(existsSync(paths.home));
    assert.ok(existsSync(paths.logsDir));
    assert.ok(existsSync(paths.reposDir));
  } finally {
    tmp.cleanup();
  }
});
