import assert from 'node:assert/strict';
import { test } from 'node:test';
import { expandBraces, globToRegExp, isIgnored } from '../../src/config/glob.ts';

test('dist/** 匹配 dist 下任意深度，不匹配 src/dist.js', () => {
  assert.equal(isIgnored('dist/a/b.js', ['dist/**']), true);
  assert.equal(isIgnored('dist/x.js', ['dist/**']), true);
  assert.equal(isIgnored('dist', ['dist/**']), true);
  assert.equal(isIgnored('src/dist.js', ['dist/**']), false);
  assert.equal(isIgnored('distx/a.js', ['dist/**']), false);
});

test('**/*.min.js 匹配任意深度的 .min.js', () => {
  assert.equal(isIgnored('a.min.js', ['**/*.min.js']), true);
  assert.equal(isIgnored('x/y/z.min.js', ['**/*.min.js']), true);
  assert.equal(isIgnored('a.js', ['**/*.min.js']), false);
  assert.equal(isIgnored('a.min.js.map', ['**/*.min.js']), false);
});

test('{a,b}/*.ts 花括号按并集展开', () => {
  assert.deepEqual(expandBraces('{a,b}/*.ts'), ['a/*.ts', 'b/*.ts']);
  assert.deepEqual(expandBraces('src/{a,b}/c.{ts,js}'), [
    'src/a/c.ts',
    'src/a/c.js',
    'src/b/c.ts',
    'src/b/c.js',
  ]);
  assert.equal(isIgnored('a/x.ts', ['{a,b}/*.ts']), true);
  assert.equal(isIgnored('b/y.ts', ['{a,b}/*.ts']), true);
  assert.equal(isIgnored('c/x.ts', ['{a,b}/*.ts']), false);
  // 未闭合的花括号按字面量处理
  assert.equal(isIgnored('a{x/y.ts', ['a{x/y.ts']), true);
});

test('? 恰好匹配单个字符，不跨 /', () => {
  assert.equal(isIgnored('src/a.ts', ['src/?.ts']), true);
  assert.equal(isIgnored('src/ab.ts', ['src/?.ts']), false);
  assert.equal(isIgnored('src/x/ab.ts', ['src/?.ts']), false);
});

test('* 不跨越目录分隔符', () => {
  assert.equal(isIgnored('src/a.ts', ['src/*.ts']), true);
  assert.equal(isIgnored('src/x/a.ts', ['src/*.ts']), false);
});

test('** 单独成段跨越任意层目录', () => {
  assert.equal(isIgnored('a/b/c.js', ['**']), true);
  assert.equal(isIgnored('x.ts', ['**/x.ts']), true);
  assert.equal(isIgnored('a/b/x.ts', ['**/x.ts']), true);
  assert.equal(isIgnored('a/x.ts', ['a/**/x.ts']), true);
  assert.equal(isIgnored('a/b/c/x.ts', ['a/**/x.ts']), true);
  assert.equal(isIgnored('b/a/x.ts', ['a/**/x.ts']), false);
});

test('不含 / 的模式按任意一段匹配（类似 .gitignore）', () => {
  assert.equal(isIgnored('package-lock.json', ['package-lock.json']), true);
  assert.equal(isIgnored('sub/dir/package-lock.json', ['package-lock.json']), true);
  assert.equal(isIgnored('dist/a.js', ['dist']), true);
  assert.equal(isIgnored('a/dist/b.js', ['dist']), true);
  assert.equal(isIgnored('distx/a.js', ['dist']), false);
});

test('多个模式任一命中即忽略；空列表与空模式不忽略', () => {
  assert.equal(isIgnored('src/a.min.js', ['dist/**', '*.min.js']), true);
  assert.equal(isIgnored('dist/a.js', ['dist/**', '*.min.js']), true);
  assert.equal(isIgnored('src/a.js', ['dist/**', '*.min.js']), false);
  assert.equal(isIgnored('src/a.js', []), false);
  assert.equal(isIgnored('src/a.js', ['']), false);
});

test('反斜杠与 ./ 前缀在模式与路径两侧都被归一化', () => {
  assert.equal(isIgnored('./dist/a.js', ['dist/**']), true);
  assert.equal(isIgnored('dist\\a.js', ['dist/**']), true);
  assert.equal(isIgnored('dist/a.js', ['./dist/**']), true);
});

test('globToRegExp 返回整条路径锚定的正则并缓存', () => {
  const re = globToRegExp('dist/**');
  assert.equal(re.source, globToRegExp('dist/**').source);
  assert.equal(re.test('dist/a.js'), true);
  assert.equal(re.test('xdist/a.js'), false);
  // 模式中的正则特殊字符被转义
  const dot = globToRegExp('a.b/*.ts');
  assert.equal(dot.test('axb/c.ts'), false);
  assert.equal(dot.test('a.b/c.ts'), true);
});
