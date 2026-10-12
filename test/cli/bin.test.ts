import assert from 'node:assert/strict';
import { test } from 'node:test';
import path from 'node:path';
import { exec } from '../../src/lib/exec.ts';

const bin = path.join(import.meta.dirname, '..', '..', 'bin', 'glm-review');

test('bin/glm-review help 列出 help 与 version', async () => {
  const result = await exec(bin, ['help']);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /help\s+显示帮助/);
  assert.match(result.stdout, /version\s+显示版本号/);
});

test('bin/glm-review version 输出 glm-review-bot 0.1.0', async () => {
  const result = await exec(bin, ['version']);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout, 'glm-review-bot 0.1.0\n');
});

test('bin/glm-review 未知子命令：stderr 中文报错、退出码 2', async () => {
  const result = await exec(bin, ['nope']);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /未知子命令：nope/);
});
