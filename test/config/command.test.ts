import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { test } from 'node:test';
import path from 'node:path';
import { runCli } from '../../src/cli.ts';
import { defaultGlobalConfigTemplate } from '../../src/config/global.ts';
import { createTestContext } from '../helpers/ctx.ts';

test('config check：配置文件不存在时打印默认值，退出码 0', async () => {
  const t = createTestContext();
  try {
    const code = await runCli(['config', 'check'], { ctx: t.ctx });
    assert.equal(code, 0);
    assert.match(t.stdout(), /# 全局配置（.*config\.yml，合并默认值后）/);
    assert.match(t.stdout(), /repos: \[\]/);
    assert.match(t.stdout(), /pollIntervalSec: 120/);
    assert.match(t.stdout(), /small: glm-5\.3-flash/);
    assert.match(t.stdout(), /backoffSec:\n\s+- 60\n\s+- 300\n\s+- 1800/);
    assert.match(t.stderr(), /全局配置文件不存在/);
  } finally {
    t.cleanup();
  }
});

test('config check：合法文件打印合并后的 YAML', async () => {
  const t = createTestContext();
  try {
    writeFileSync(t.tmp.configPath, 'pollIntervalSec: 90\nrepos:\n  - a/b\n');
    const code = await runCli(['config', 'check'], { ctx: t.ctx });
    assert.equal(code, 0);
    assert.match(t.stdout(), /pollIntervalSec: 90/);
    assert.match(t.stdout(), /- a\/b/);
    assert.match(t.stdout(), /maxConcurrent: 1/); // 未覆盖字段保持默认
  } finally {
    t.cleanup();
  }
});

test('config check：坏文件（未知字段 + 越界）退出码 1，stderr 带字段路径', async () => {
  const t = createTestContext();
  try {
    writeFileSync(t.tmp.configPath, 'foo: 1\npollIntervalSec: 10\n');
    const code = await runCli(['config', 'check'], { ctx: t.ctx });
    assert.equal(code, 1);
    assert.match(t.stderr(), /全局配置校验失败/);
    assert.match(t.stderr(), /未知字段：foo/);
    assert.match(t.stderr(), /pollIntervalSec 必须 ≥ 30，收到 10/);
  } finally {
    t.cleanup();
  }
});

test('config check：YAML 语法错误退出码 1，stderr 带行号', async () => {
  const t = createTestContext();
  try {
    writeFileSync(t.tmp.configPath, 'repos:\n  - a/b\n pollIntervalSec: 120\n');
    const code = await runCli(['config', 'check'], { ctx: t.ctx });
    assert.equal(code, 1);
    assert.match(t.stderr(), /YAML 语法错误（第 3 行）/);
  } finally {
    t.cleanup();
  }
});

test('config check --repo-file：合法仓库配置打印合并结果，退出码 0', async () => {
  const t = createTestContext();
  try {
    const repoFile = path.join(t.tmp.baseDir, 'repo.yml');
    writeFileSync(repoFile, 'minSeverity: major\nignore:\n  - "dist/**"\n');
    const code = await runCli(['config', 'check', '--repo-file', repoFile], { ctx: t.ctx });
    assert.equal(code, 0);
    assert.match(t.stdout(), /# 仓库配置（.*repo\.yml，合并默认值后）/);
    assert.match(t.stdout(), /enabled: true/);
    assert.match(t.stdout(), /minSeverity: major/);
    assert.match(t.stdout(), /- dist\/\*\*/);
    assert.match(t.stdout(), /- no-review/); // skipLabels 默认值
  } finally {
    t.cleanup();
  }
});

test('config check --repo-file：有错误时退出码 1 并逐条打印', async () => {
  const t = createTestContext();
  try {
    const repoFile = path.join(t.tmp.baseDir, 'repo.yml');
    writeFileSync(repoFile, 'minSeverity: high\nwhatever: true\n');
    const code = await runCli(['config', 'check', '--repo-file', repoFile], { ctx: t.ctx });
    assert.equal(code, 1);
    assert.match(t.stderr(), /\.glm-review\.yml: minSeverity 必须是 blocker\/major\/minor\/nit 之一，收到 "high"/);
    assert.match(t.stderr(), /\.glm-review\.yml: 未知字段：whatever/);
    assert.match(t.stdout(), /minSeverity: minor/); // 出错时打印默认值
  } finally {
    t.cleanup();
  }
});

test('config check --repo-file：文件不存在退出码 1', async () => {
  const t = createTestContext();
  try {
    const code = await runCli(['config', 'check', '--repo-file', '/不存在的/repo.yml'], { ctx: t.ctx });
    assert.equal(code, 1);
    assert.match(t.stderr(), /无法读取仓库配置文件：\/不存在的\/repo\.yml/);
  } finally {
    t.cleanup();
  }
});

test('config init：写出的文件再 config check 通过', async () => {
  const t = createTestContext();
  try {
    const code = await runCli(['config', 'init'], { ctx: t.ctx });
    assert.equal(code, 0);
    assert.match(t.stdout(), /已写入默认全局配置/);
    assert.ok(existsSync(t.tmp.configPath));
    assert.equal(readFileSync(t.tmp.configPath, 'utf8'), defaultGlobalConfigTemplate());

    const checkCode = await runCli(['config', 'check'], { ctx: t.ctx });
    assert.equal(checkCode, 0, t.stderr());
    assert.match(t.stdout(), /- Jackeyhan-JH\/glm-toolbox/);
    assert.match(t.stdout(), /pollIntervalSec: 120/);
  } finally {
    t.cleanup();
  }
});

test('config init：文件已存在则不改动', async () => {
  const t = createTestContext();
  try {
    writeFileSync(t.tmp.configPath, '# 我自己的配置\npollIntervalSec: 45\n');
    const before = readFileSync(t.tmp.configPath, 'utf8');
    const code = await runCli(['config', 'init'], { ctx: t.ctx });
    assert.equal(code, 0);
    assert.match(t.stdout(), /已存在，未改动/);
    assert.equal(readFileSync(t.tmp.configPath, 'utf8'), before);
  } finally {
    t.cleanup();
  }
});

test('config：缺少 / 未知子命令退出码 2，未知选项同样报错', async () => {
  const t = createTestContext();
  try {
    assert.equal(await runCli(['config'], { ctx: t.ctx }), 2);
    assert.match(t.stderr(), /缺少子命令/);
    assert.equal(await runCli(['config', 'nope'], { ctx: t.ctx }), 2);
    assert.match(t.stderr(), /未知子命令：config nope/);
    assert.equal(await runCli(['config', 'check', '--bad'], { ctx: t.ctx }), 2);
    assert.match(t.stderr(), /未知选项：--bad/);
    assert.match(t.stderr(), /glm-review config check/);
  } finally {
    t.cleanup();
  }
});
