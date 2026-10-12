import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  BUILTIN_IGNORE_PATTERNS,
  defaultRepoConfig,
  isIgnoredByRepoConfig,
  loadRepoConfig,
  parseRepoConfig,
} from '../../src/config/repo.ts';
import { exec } from '../../src/lib/exec.ts';
import { createFakeBin } from '../helpers/fakebin.ts';

const FULL_EXAMPLE = [
  'enabled: true',
  'language: zh',
  'minSeverity: minor',
  'maxComments: 20',
  'ignore:',
  '  - "dist/**"',
  '  - "**/*.min.js"',
  'skipDrafts: true',
  'skipLabels: ["no-review"]',
  'skipAuthors: []',
  'focus: "重点关注并发与错误处理"',
  '',
].join('\n');

test('缺省（null / 空白）：返回与 issue #3 示例一致的默认值', () => {
  for (const text of [null, '', '   \n']) {
    const { config, errors } = parseRepoConfig(text);
    assert.deepEqual(errors, []);
    assert.deepEqual(config, defaultRepoConfig());
  }
  const config = defaultRepoConfig();
  assert.equal(config.enabled, true);
  assert.equal(config.language, 'zh');
  assert.equal(config.minSeverity, 'minor');
  assert.equal(config.maxComments, 20);
  assert.deepEqual(config.ignore, []);
  assert.equal(config.skipDrafts, true);
  assert.deepEqual(config.skipLabels, ['no-review']);
  assert.deepEqual(config.skipAuthors, []);
  assert.equal(config.focus, undefined);
});

test('完整示例配置解析出全部字段', () => {
  const { config, errors } = parseRepoConfig(FULL_EXAMPLE);
  assert.deepEqual(errors, []);
  assert.equal(config.enabled, true);
  assert.equal(config.language, 'zh');
  assert.equal(config.minSeverity, 'minor');
  assert.equal(config.maxComments, 20);
  assert.deepEqual(config.ignore, ['dist/**', '**/*.min.js']);
  assert.equal(config.skipDrafts, true);
  assert.deepEqual(config.skipLabels, ['no-review']);
  assert.deepEqual(config.skipAuthors, []);
  assert.equal(config.focus, '重点关注并发与错误处理');
});

test('部分覆盖：深合并，未覆盖字段保持默认', () => {
  const { config, errors } = parseRepoConfig('maxComments: 5\nlanguage: en\n');
  assert.deepEqual(errors, []);
  assert.equal(config.maxComments, 5);
  assert.equal(config.language, 'en');
  assert.equal(config.minSeverity, 'minor');
  assert.deepEqual(config.skipLabels, ['no-review']);
});

test('未知字段 / 类型错 / 越界 / 枚举错：返回默认值 + 带前缀与字段路径的中文错误', () => {
  const cases: [string, RegExp | null][] = [
    ['foo: 1\n', /^\.glm-review\.yml: 未知字段：foo$/],
    ['maxComments: "20"\n', /^\.glm-review\.yml: maxComments 必须是整数，收到 "20"$/],
    ['skipDrafts: "true"\n', /^\.glm-review\.yml: skipDrafts 必须是布尔值（true\/false），收到 "true"$/],
    ['minSeverity: high\n', /^\.glm-review\.yml: minSeverity 必须是 blocker\/major\/minor\/nit 之一，收到 "high"$/],
    ['language: jp\n', /^\.glm-review\.yml: language 必须是 zh\/en 之一，收到 "jp"$/],
    ['maxComments: 0\n', /^\.glm-review\.yml: maxComments 必须 ≥ 1，收到 0$/],
    ['focus: "超长"\n', null], // 下面单独拼 501 字
  ];
  for (const [text, pattern] of cases) {
    if (pattern === null) continue;
    const { config, errors } = parseRepoConfig(text);
    assert.deepEqual(config, defaultRepoConfig(), text);
    assert.equal(errors.length, 1, text);
    assert.match(errors[0], pattern);
  }
  const { config, errors } = parseRepoConfig(`focus: "${'字'.repeat(501)}"\n`);
  assert.deepEqual(config, defaultRepoConfig());
  assert.match(errors[0], /focus 长度不能超过 500 字，当前 501 字/);
});

test('多个错误一次性全部返回', () => {
  const { errors } = parseRepoConfig('foo: 1\nminSeverity: high\nmaxComments: 0\n');
  assert.equal(errors.length, 3);
  assert.ok(errors.every((e) => e.startsWith('.glm-review.yml: ')));
});

test('YAML 语法错误：返回默认值 + 带行号的中文错误', () => {
  const { config, errors } = parseRepoConfig('ignore:\n  - "dist/**"\n language: en\n');
  assert.deepEqual(config, defaultRepoConfig());
  assert.equal(errors.length, 1);
  assert.match(errors[0], /^\.glm-review\.yml：YAML 语法错误（第 3 行）/);
});

test('内置忽略列表总是生效，并与配置的 ignore 叠加', () => {
  const { config } = parseRepoConfig(null);
  const builtin = [
    'package-lock.json',
    'sub/dir/package-lock.json',
    'pnpm-lock.yaml',
    'yarn.lock',
    'vendor/lib.c',
    'a/vendor/lib.c',
    'node_modules/pkg/index.js',
    'a/b/node_modules/x.js',
    'app.min.js',
    'dist/app.min.css',
    'bundle.js.map',
    'src/__snapshots__/a.test.ts.snap',
    'assets/logo.png',
    'assets/logo.jpg',
    'fonts/font.woff2',
    'archive.zip',
    'bin/app.exe',
  ];
  for (const file of builtin) {
    assert.equal(isIgnoredByRepoConfig(file, config), true, file);
  }
  for (const file of ['src/main.ts', 'README.md', 'src/logo.png.ts', 'a/min.js']) {
    assert.equal(isIgnoredByRepoConfig(file, config), false, file);
  }
  // 配置的 ignore 叠加在内置之上（且不能关掉内置）
  const { config: custom } = parseRepoConfig('ignore:\n  - "dist/**"\n');
  assert.equal(isIgnoredByRepoConfig('dist/a.js', custom), true);
  assert.equal(isIgnoredByRepoConfig('src/a.ts', custom), false);
  assert.equal(isIgnoredByRepoConfig('x/y/package-lock.json', custom), true);
  assert.ok(BUILTIN_IGNORE_PATTERNS.includes('**/*.map'));
});

test('loadRepoConfig：假 gh 返回 base64 内容，解码并解析', async () => {
  const fake = createFakeBin();
  try {
    // 模拟 GitHub contents API：base64 每 60 字符插一个换行
    const b64 = Buffer.from(FULL_EXAMPLE, 'utf8').toString('base64').replace(/(.{60})/g, '$1\n');
    fake.rule('gh', {
      match: ['api', 'repos/Jackeyhan-JH/glm-toolbox/contents/.glm-review.yml'],
      stdout: JSON.stringify({ name: '.glm-review.yml', content: b64, encoding: 'base64' }),
    });
    const { config, errors } = await loadRepoConfig('Jackeyhan-JH/glm-toolbox', {
      exec,
      env: fake.env,
    });
    assert.deepEqual(errors, []);
    assert.deepEqual(config.ignore, ['dist/**', '**/*.min.js']);
    assert.equal(config.focus, '重点关注并发与错误处理');
    const calls = fake.calls();
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0]?.argv, ['api', 'repos/Jackeyhan-JH/glm-toolbox/contents/.glm-review.yml']);
  } finally {
    fake.remove();
  }
});

test('loadRepoConfig：404 视为缺省，无错误', async () => {
  const fake = createFakeBin();
  try {
    fake.rule('gh', {
      match: ['api', 'repos/Jackeyhan-JH/glm-toolbox/contents/.glm-review.yml'],
      code: 1,
      stderr: 'gh: Not Found\n',
    });
    const { config, errors } = await loadRepoConfig('Jackeyhan-JH/glm-toolbox', {
      exec,
      env: fake.env,
    });
    assert.deepEqual(errors, []);
    assert.deepEqual(config, defaultRepoConfig());
  } finally {
    fake.remove();
  }
});

test('loadRepoConfig：其他 gh 错误抛中文异常', async () => {
  const fake = createFakeBin();
  try {
    fake.rule('gh', {
      mode: 'prefix',
      match: ['api'],
      code: 1,
      stderr: 'gh: Bad credentials\n',
    });
    await assert.rejects(
      loadRepoConfig('Jackeyhan-JH/glm-toolbox', { exec, env: fake.env }),
      /读取 \.glm-review\.yml 失败（gh 退出码 1）：gh: Bad credentials/,
    );
  } finally {
    fake.remove();
  }
});

test('loadRepoConfig：仓库标识不合法直接抛错，不调用 gh', async () => {
  const fake = createFakeBin();
  try {
    await assert.rejects(loadRepoConfig('bad slug', { exec, env: fake.env }), /owner\/name/);
    assert.equal(fake.calls().length, 0);
  } finally {
    fake.remove();
  }
});
