import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import path from 'node:path';
import { exec } from '../../src/lib/exec.ts';
import { createFakeBin } from './fakebin.ts';

const fixtureDir = path.join(import.meta.dirname, '..', 'fixtures', 'common');

function readPrFixture(): string {
  return readFileSync(path.join(fixtureDir, 'pr-view.sample.json'), 'utf8');
}

test('fakebin：假 gh 按前缀规则返回夹具，未匹配调用返回非零', async () => {
  const fake = createFakeBin();
  try {
    fake.rule('gh', {
      mode: 'prefix',
      match: ['pr', 'view', '12', '--json'],
      stdout: readPrFixture(),
    });

    const ok = await exec('gh', ['pr', 'view', '12', '--json', 'number,title,url'], { env: fake.env });
    assert.equal(ok.code, 0, ok.stderr);
    const parsed = JSON.parse(ok.stdout) as { number: number; title: string };
    assert.equal(parsed.number, 45);
    assert.equal(parsed.title, 'feat(pay): 支持多币种分摊');

    const miss = await exec('gh', ['api', 'repos/x/y'], { env: fake.env });
    assert.notEqual(miss.code, 0);
    assert.match(miss.stderr, /fakebin/);
  } finally {
    fake.remove();
  }
});

test('fakebin：能读回调用记录（argv、cwd、stdin）', async () => {
  const fake = createFakeBin();
  try {
    fake.rule('claude', { match: ['-p'], mode: 'prefix', stdout: 'ok' });
    const r = await exec('claude', ['-p', '请审查这个 diff', '--model', 'glm-5.3'], {
      env: fake.env,
      input: 'some stdin',
    });
    assert.equal(r.code, 0, r.stderr);

    const calls = fake.calls();
    assert.equal(calls.length, 1);
    const call = calls[0];
    assert.equal(call?.bin, 'claude');
    assert.deepEqual(call?.argv, ['-p', '请审查这个 diff', '--model', 'glm-5.3']);
    assert.equal(call?.stdin, 'some stdin');
    assert.equal(call?.cwd, process.cwd());

    fake.resetCalls();
    assert.deepEqual(fake.calls(), []);
  } finally {
    fake.remove();
  }
});

test('fakebin：精确匹配优先于前缀匹配，更长前缀优先', async () => {
  const fake = createFakeBin();
  try {
    fake.rule('gh', { match: ['pr', 'view'], mode: 'prefix', stdout: 'PREFIX\n' });
    fake.rule('gh', { match: ['pr', 'view', '12'], mode: 'prefix', stdout: 'PR12\n' });
    fake.rule('gh', { match: ['pr', 'view', '13', '--json', 'number'], stdout: 'EXACT13\n' });

    const a = await exec('gh', ['pr', 'view'], { env: fake.env });
    assert.equal(a.stdout, 'PREFIX\n');
    const b = await exec('gh', ['pr', 'view', '12', '--json', 'number'], { env: fake.env });
    assert.equal(b.stdout, 'PR12\n');
    const c = await exec('gh', ['pr', 'view', '13', '--json', 'number'], { env: fake.env });
    assert.equal(c.stdout, 'EXACT13\n');
  } finally {
    fake.remove();
  }
});

test('fakebin：兜底规则接管未匹配调用（自定义退出码与 stderr）', async () => {
  const fake = createFakeBin();
  try {
    fake.rule('git', { match: ['status'], stdout: 'nothing to commit\n' });
    fake.rule('git', { code: 7, stderr: 'fakebin: 不支持的 git 子命令\n' });

    const ok = await exec('git', ['status'], { env: fake.env });
    assert.equal(ok.code, 0);
    assert.equal(ok.stdout, 'nothing to commit\n');

    const fail = await exec('git', ['push', 'origin', 'main'], { env: fake.env });
    assert.equal(fail.code, 7);
    assert.match(fail.stderr, /不支持的 git 子命令/);
  } finally {
    fake.remove();
  }
});

test('fakebin：delayMs 延时应答，可用 exec 的 durationMs 验证', async () => {
  const fake = createFakeBin();
  try {
    fake.rule('claude', { match: ['-p'], mode: 'prefix', stdout: '{}', delayMs: 300 });
    const r = await exec('claude', ['-p', 'hi'], { env: fake.env });
    assert.equal(r.code, 0, r.stderr);
    assert.ok(r.durationMs >= 280, `耗时 ${r.durationMs}ms 应不小于 280ms`);
  } finally {
    fake.remove();
  }
});
