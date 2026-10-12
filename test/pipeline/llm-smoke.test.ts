/**
 * `glm-review llm-smoke` 命令测试：高峰拒绝（退出码 3）、暂停文件拦截、
 * 成功路径的输出（模型 / 耗时 / token / 解析出的 JSON）与 --model 透传。
 * claude 一律用 fakebin 假实现，不做真实调用。
 */
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { runCli } from '../../src/cli.ts';
import { fixedClock } from '../../src/lib/clock.ts';
import { createFakeBin } from '../helpers/fakebin.ts';
import { createTmpEnv } from '../helpers/tmp.ts';
import { claudeEnvelope, createCliHarness, NON_PEAK_AT, PEAK_AT } from './helpers.ts';

/** 冒烟成功用的假 claude 输出。 */
const SMOKE_OUTPUT = { ok: true, message: '你好，冒烟测试通过' };

function smokeEnv(clockAt: string): {
  fake: ReturnType<typeof createFakeBin>;
  tmp: ReturnType<typeof createTmpEnv>;
  harness: ReturnType<typeof createCliHarness>;
  cleanup(): void;
} {
  const tmp = createTmpEnv('glm-review-smoke-test');
  const fake = createFakeBin({ bins: ['claude'] });
  fake.rule('claude', { stdout: claudeEnvelope(SMOKE_OUTPUT) });
  const harness = createCliHarness(fake, tmp, fixedClock(clockAt));
  return { fake, tmp, harness, cleanup: () => { fake.remove(); tmp.cleanup(); } };
}

test('llm-smoke：非高峰成功 → 退出码 0，打印模型、耗时、token 与解析出的 JSON', async () => {
  const env = smokeEnv(NON_PEAK_AT);
  try {
    const code = await runCli(['llm-smoke'], { ctx: env.harness.ctx });
    assert.equal(code, 0);
    const out = env.harness.stdout();
    assert.ok(out.includes('模型：glm-5.3-flash')); // 缺省配置的小模型
    assert.ok(out.includes('耗时：'));
    assert.ok(out.includes('token：输入 120 / 输出 80'));
    assert.ok(out.includes('"ok":true'));
    assert.ok(out.includes('冒烟测试通过 ✅'));
    // 假 claude 被真实调用了一次，且带只读工具与 JSON schema
    const calls = env.fake.calls().filter((call) => call.bin === 'claude');
    assert.equal(calls.length, 1);
    assert.ok(calls[0]?.argv.includes('--model'));
    assert.ok(calls[0]?.argv.includes('Read'));
    assert.ok(calls[0]?.stdin.includes('冒烟测试'));
    // --json-schema 不带 $schema 元键（本机 claude 校验器拒绝 2020-12 元 URI）
    const schemaArg = calls[0]?.argv[calls[0].argv.indexOf('--json-schema') + 1] ?? '';
    const schema = JSON.parse(schemaArg) as Record<string, unknown>;
    assert.equal('$schema' in schema, false);
    assert.ok('ok' in (schema.properties as Record<string, unknown>));
  } finally {
    env.cleanup();
  }
});

test('llm-smoke --model：模型名透传到 claude 并体现在输出', async () => {
  const env = smokeEnv(NON_PEAK_AT);
  try {
    const code = await runCli(['llm-smoke', '--model', 'glm-5.3'], { ctx: env.harness.ctx });
    assert.equal(code, 0);
    assert.ok(env.harness.stdout().includes('模型：glm-5.3'));
    const call = env.fake.calls().find((c) => c.bin === 'claude');
    const index = call?.argv.indexOf('--model') ?? -1;
    assert.equal(call?.argv[index + 1], 'glm-5.3');
  } finally {
    env.cleanup();
  }
});

test('llm-smoke：高峰期拒绝运行 → 退出码 3，不调用 claude', async () => {
  const env = smokeEnv(PEAK_AT);
  try {
    const code = await runCli(['llm-smoke'], { ctx: env.harness.ctx });
    assert.equal(code, 3);
    assert.ok(env.harness.stderr().includes('高峰期'));
    assert.equal(env.fake.calls().length, 0);
  } finally {
    env.cleanup();
  }
});

test('llm-smoke：额度暂停文件存在 → 退出码 1，不调用 claude', async () => {
  const tmp = createTmpEnv('glm-review-smoke-test');
  const fake = createFakeBin({ bins: ['claude'] });
  fake.rule('claude', { stdout: claudeEnvelope(SMOKE_OUTPUT) });
  try {
    const pausePath = path.join(tmp.baseDir, 'GLM_PAUSE');
    writeFileSync(tmp.configPath, `repos: []\npauseFile: ${pausePath}\n`);
    writeFileSync(pausePath, '');
    const harness = createCliHarness(fake, tmp, fixedClock(NON_PEAK_AT));
    const code = await runCli(['llm-smoke'], { ctx: harness.ctx });
    assert.equal(code, 1);
    assert.ok(harness.stderr().includes('额度暂停文件'));
    assert.equal(fake.calls().length, 0);
  } finally {
    fake.remove();
    tmp.cleanup();
  }
});

test('llm-smoke：claude 调用失败 → 退出码 1，错误走 stderr', async () => {
  const tmp = createTmpEnv('glm-review-smoke-test');
  const fake = createFakeBin({ bins: ['claude'] });
  fake.rule('claude', { code: 1, stderr: 'Error: invalid api key' });
  try {
    const harness = createCliHarness(fake, tmp, fixedClock(NON_PEAK_AT));
    const code = await runCli(['llm-smoke'], { ctx: harness.ctx });
    assert.equal(code, 1);
    assert.ok(harness.stderr().includes('冒烟测试失败'));
  } finally {
    fake.remove();
    tmp.cleanup();
  }
});

test('llm-smoke：参数错误 → 退出码 2', async () => {
  const env = smokeEnv(NON_PEAK_AT);
  try {
    for (const argv of [['llm-smoke', '多余参数'], ['llm-smoke', '--wat'], ['llm-smoke', '--model', '']]) {
      const code = await runCli(argv, { ctx: env.harness.ctx });
      assert.equal(code, 2, `参数 ${JSON.stringify(argv)} 应退出码 2`);
    }
  } finally {
    env.cleanup();
  }
});
