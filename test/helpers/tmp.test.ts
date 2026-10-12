import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { test } from 'node:test';
import { resolvePaths } from '../../src/lib/paths.ts';
import { createTmpEnv } from './tmp.ts';

test('tmp：创建隔离的 GLM_REVIEW_HOME 与配置目录，cleanup 删除', () => {
  const tmp = createTmpEnv('glm-review-tmp-test');
  try {
    assert.ok(existsSync(tmp.homeDir));
    assert.ok(existsSync(tmp.configDir));
    assert.equal(tmp.env.GLM_REVIEW_HOME, tmp.homeDir);
    assert.equal(tmp.env.GLM_REVIEW_CONFIG, tmp.configPath);
    const paths = resolvePaths(tmp.env);
    assert.equal(paths.home, tmp.homeDir);
    assert.equal(paths.configFile, tmp.configPath);
    assert.notEqual(paths.home, resolvePaths(process.env).home);
  } finally {
    tmp.cleanup();
  }
  assert.ok(!existsSync(tmp.baseDir));
});
