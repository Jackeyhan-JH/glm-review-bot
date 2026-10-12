import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ArgError, parseArgs } from '../../src/lib/args.ts';

test('args 解析 --k v 形式与位置参数', () => {
  const parsed = parseArgs(['--repo', 'Jackeyhan-JH/glm-toolbox', '--number', '45', 'extra'], {
    strings: ['repo', 'number'],
  });
  assert.deepEqual(parsed.values, { repo: 'Jackeyhan-JH/glm-toolbox', number: '45' });
  assert.deepEqual(parsed.positionals, ['extra']);
});

test('args 解析 --k=v 形式', () => {
  const parsed = parseArgs(['--model=glm-5.3', '--json=number,title'], {
    strings: ['model', 'json'],
  });
  assert.deepEqual(parsed.values, { model: 'glm-5.3', json: 'number,title' });
});

test('args 解析布尔开关（--flag 与 --flag=false）', () => {
  const parsed = parseArgs(['--dry-run', '--verbose=false'], {
    booleans: ['dry-run', 'verbose'],
  });
  assert.deepEqual(parsed.values, { 'dry-run': true, verbose: false });
});

test('args 布尔开关给非法取值时报错', () => {
  assert.throws(() => parseArgs(['--verbose=yes'], { booleans: ['verbose'] }), ArgError);
});

test('args 未知选项报错', () => {
  assert.throws(() => parseArgs(['--nope', 'x'], { strings: ['known'] }), /未知选项：--nope/);
});

test('args 取值选项缺取值报错', () => {
  assert.throws(() => parseArgs(['--repo'], { strings: ['repo'] }), /缺少取值/);
  assert.throws(() => parseArgs(['--repo', '--json', 'x'], { strings: ['repo', 'json'] }), /缺少取值/);
});

test('args -- 之后的内容一律是位置参数', () => {
  const parsed = parseArgs(['--', '--not-a-flag', 'x'], { strings: [] });
  assert.deepEqual(parsed.positionals, ['--not-a-flag', 'x']);
  assert.deepEqual(parsed.values, {});
});
