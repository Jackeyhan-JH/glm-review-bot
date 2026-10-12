import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ExecFn } from '../../src/lib/exec.ts';
import { exec } from '../../src/lib/exec.ts';
import { buildClaudeArgs, runClaude, type ClaudeCallRecord } from '../../src/llm/claude.ts';
import { withRetry } from '../../src/llm/retry.ts';
import { createFakeBin } from '../helpers/fakebin.ts';
import { createTmpEnv } from '../helpers/tmp.ts';

/** 成功时的 `--output-format json` 输出（字段名与 claude 2.1.292 实测一致）。 */
const OK_ENVELOPE = JSON.stringify({
  type: 'result',
  subtype: 'success',
  is_error: false,
  result: '{"ok":true}',
  structured_output: { ok: true },
  usage: { input_tokens: 3065, output_tokens: 112 },
  total_cost_usd: 0.018125,
  duration_ms: 15684,
  num_turns: 2,
});

const SCHEMA = {
  type: 'object',
  properties: { ok: { type: 'boolean' } },
  required: ['ok'],
  additionalProperties: false,
};

test('完整 argv：只读工具、JSON 输出、json-schema、模型名；提示词只经 stdin', async () => {
  const fake = createFakeBin();
  const tmp = createTmpEnv('glm-review-llm-argv');
  try {
    fake.rule('claude', { stdout: OK_ENVELOPE });
    const prompt = '请审查这个 diff（含 "引号" 与 $() 等特殊字符）';
    const result = await runClaude(
      { prompt, cwd: tmp.baseDir, model: 'glm-5.3', jsonSchema: SCHEMA },
      { exec, env: fake.env },
    );
    assert.equal(result.ok, true);

    const calls = fake.calls();
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.bin, 'claude');
    assert.equal(calls[0]?.cwd, tmp.baseDir);
    // 提示词只经 stdin 传入，argv 里不出现
    assert.equal(calls[0]?.stdin, prompt);
    assert.deepEqual(calls[0]?.argv, [
      '-p',
      '--model',
      'glm-5.3',
      '--effort',
      'medium',
      '--output-format',
      'json',
      '--json-schema',
      JSON.stringify(SCHEMA),
      '--tools',
      'Read',
      'Grep',
      'Glob',
      '--permission-mode',
      'default',
      '--no-session-persistence',
    ]);
    assert.ok(!calls[0]?.argv.join(' ').includes(prompt));
  } finally {
    fake.remove();
    tmp.cleanup();
  }
});

test('argv 不含任何写入/执行类工具或跳过权限的参数', () => {
  const forbidden = [
    'Bash',
    'Edit',
    'Write',
    'WebFetch',
    'WebSearch',
    'dangerously-skip-permissions',
    'bypassPermissions',
  ];
  const variants = [
    { prompt: 'p', cwd: '/tmp', model: 'glm-5.3-flash' },
    { prompt: 'p', cwd: '/tmp', model: 'glm-5.3', effort: 'high', jsonSchema: SCHEMA },
  ];
  for (const variant of variants) {
    const joined = buildClaudeArgs(variant).join(' ');
    for (const word of forbidden) {
      assert.ok(!joined.includes(word), `argv 不应包含 ${word}：${joined}`);
    }
  }
});

test('自定义 effort 与省略 jsonSchema 时的 argv', () => {
  assert.deepEqual(
    buildClaudeArgs({ prompt: 'p', cwd: '/tmp', model: 'm', effort: 'low' }),
    [
      '-p',
      '--model',
      'm',
      '--effort',
      'low',
      '--output-format',
      'json',
      '--tools',
      'Read',
      'Grep',
      'Glob',
      '--permission-mode',
      'default',
      '--no-session-persistence',
    ],
  );
});

test('正常结构化输出：ok、output、usage 映射、时长与回合数', async () => {
  const fake = createFakeBin();
  const tmp = createTmpEnv('glm-review-llm-ok');
  try {
    fake.rule('claude', { stdout: OK_ENVELOPE });
    const result = await runClaude(
      { prompt: '只回复 {"ok":true}', cwd: tmp.baseDir, model: 'glm-5.3-flash', jsonSchema: SCHEMA },
      { exec, env: fake.env },
    );
    assert.deepEqual(result, {
      ok: true,
      output: { ok: true },
      usage: { inputTokens: 3065, outputTokens: 112, totalCostUsd: 0.018125, numTurns: 2 },
      durationMs: 15684,
      exitCode: 0,
      retryable: false,
    });
  } finally {
    fake.remove();
    tmp.cleanup();
  }
});

test('结构化输出缺失：从 result 文本里提取第一个 JSON 对象', async () => {
  const fake = createFakeBin();
  const tmp = createTmpEnv('glm-review-llm-extract');
  try {
    fake.rule('claude', {
      stdout: JSON.stringify({
        type: 'result',
        is_error: false,
        result: '审查完成，结果如下：{"summary":"整体不错","findings":[]} 请查收',
        usage: { input_tokens: 10, output_tokens: 5 },
        duration_ms: 999,
        num_turns: 1,
      }),
    });
    const result = await runClaude(
      { prompt: '审查', cwd: tmp.baseDir, model: 'glm-5.3-flash', jsonSchema: SCHEMA },
      { exec, env: fake.env },
    );
    assert.equal(result.ok, true);
    assert.deepEqual(result.output, { summary: '整体不错', findings: [] });
    assert.equal(result.usage?.numTurns, 1);
  } finally {
    fake.remove();
    tmp.cleanup();
  }
});

test('文本提取能跨过字符串里的花括号', async () => {
  const fake = createFakeBin();
  const tmp = createTmpEnv('glm-review-llm-extract2');
  try {
    fake.rule('claude', {
      stdout: JSON.stringify({
        type: 'result',
        is_error: false,
        result: '前 {"note":"内含 } 与 { 花括号","path":"a{b}c.txt","ok":true} 后',
      }),
    });
    const result = await runClaude({ prompt: '审查', cwd: tmp.baseDir, model: 'glm-5.3' }, { exec, env: fake.env });
    assert.equal(result.ok, true);
    assert.deepEqual(result.output, { note: '内含 } 与 { 花括号', path: 'a{b}c.txt', ok: true });
  } finally {
    fake.remove();
    tmp.cleanup();
  }
});

test('没有 JSON 也没有 structured_output 时，output 退化为 result 文本', async () => {
  const fake = createFakeBin();
  const tmp = createTmpEnv('glm-review-llm-text');
  try {
    fake.rule('claude', {
      stdout: JSON.stringify({ type: 'result', is_error: false, result: '纯文字结论：没有问题。' }),
    });
    const result = await runClaude({ prompt: '审查', cwd: tmp.baseDir, model: 'glm-5.3' }, { exec, env: fake.env });
    assert.equal(result.ok, true);
    assert.equal(result.output, '纯文字结论：没有问题。');
    assert.equal(result.usage, undefined);
  } finally {
    fake.remove();
    tmp.cleanup();
  }
});

test('is_error: true → ok=false，错误信息带上 result 文本', async () => {
  const fake = createFakeBin();
  const tmp = createTmpEnv('glm-review-llm-iserror');
  try {
    fake.rule('claude', {
      stdout: JSON.stringify({
        type: 'result',
        subtype: 'error_max_turns',
        is_error: true,
        result: 'API Error: 500 Internal Server Error',
        usage: { input_tokens: 7, output_tokens: 3 },
        num_turns: 4,
      }),
    });
    const result = await runClaude({ prompt: '审查', cwd: tmp.baseDir, model: 'glm-5.3' }, { exec, env: fake.env });
    assert.equal(result.ok, false);
    assert.equal(result.retryable, true); // 5xx 属可重试
    assert.match(result.error ?? '', /is_error/);
    assert.match(result.error ?? '', /500 Internal Server Error/);
  } finally {
    fake.remove();
    tmp.cleanup();
  }
});

test('非 JSON 输出 → ok=false、可重试', async () => {
  const fake = createFakeBin();
  const tmp = createTmpEnv('glm-review-llm-badjson');
  try {
    fake.rule('claude', { stdout: '抱歉，这段输出不是 JSON。', code: 1 });
    const result = await runClaude({ prompt: '审查', cwd: tmp.baseDir, model: 'glm-5.3' }, { exec, env: fake.env });
    assert.equal(result.ok, false);
    assert.equal(result.retryable, true);
    assert.match(result.error ?? '', /输出不是合法 JSON/);
    assert.match(result.error ?? '', /抱歉，这段输出不是 JSON/);
  } finally {
    fake.remove();
    tmp.cleanup();
  }
});

test('空输出同样定性为可重试的解析失败', async () => {
  const fake = createFakeBin();
  const tmp = createTmpEnv('glm-review-llm-empty');
  try {
    fake.rule('claude', { code: 1, stderr: 'claude: 崩溃退出' });
    const result = await runClaude({ prompt: '审查', cwd: tmp.baseDir, model: 'glm-5.3' }, { exec, env: fake.env });
    assert.equal(result.ok, false);
    assert.equal(result.retryable, true);
    assert.match(result.error ?? '', /输出为空/);
  } finally {
    fake.remove();
    tmp.cleanup();
  }
});

test('超时 → ok=false、可重试、错误说明超时', async () => {
  const fake = createFakeBin();
  const tmp = createTmpEnv('glm-review-llm-timeout');
  try {
    fake.rule('claude', { stdout: OK_ENVELOPE, delayMs: 5000 });
    const result = await runClaude(
      { prompt: '审查', cwd: tmp.baseDir, model: 'glm-5.3', timeoutMs: 200 },
      { exec, env: fake.env },
    );
    assert.equal(result.ok, false);
    assert.equal(result.retryable, true);
    assert.match(result.error ?? '', /超时/);
    assert.match(result.error ?? '', /200ms/);
  } finally {
    fake.remove();
    tmp.cleanup();
  }
});

test('认证失败 → 不可重试', async () => {
  const fake = createFakeBin();
  const tmp = createTmpEnv('glm-review-llm-auth');
  try {
    fake.rule('claude', { code: 1, stderr: 'API Error: Invalid API key. Authentication failed.' });
    const result = await runClaude({ prompt: '审查', cwd: tmp.baseDir, model: 'glm-5.3' }, { exec, env: fake.env });
    assert.equal(result.ok, false);
    assert.equal(result.retryable, false);
    assert.match(result.error ?? '', /Invalid API key/);
  } finally {
    fake.remove();
    tmp.cleanup();
  }
});

test('参数错误（unknown option）→ 不可重试', async () => {
  const fake = createFakeBin();
  const tmp = createTmpEnv('glm-review-llm-badopt');
  try {
    fake.rule('claude', { code: 1, stderr: "error: unknown option '--nope'" });
    const result = await runClaude({ prompt: '审查', cwd: tmp.baseDir, model: 'glm-5.3' }, { exec, env: fake.env });
    assert.equal(result.ok, false);
    assert.equal(result.retryable, false);
    assert.match(result.error ?? '', /unknown option/);
  } finally {
    fake.remove();
    tmp.cleanup();
  }
});

test('onCall：成功与失败各回调一次，字段齐全', async () => {
  const fake = createFakeBin();
  const tmp = createTmpEnv('glm-review-llm-oncall');
  try {
    fake.rule('claude', { match: ['-p', '--model', 'glm-5.3-flash'], mode: 'prefix', stdout: OK_ENVELOPE });
    fake.rule('claude', { match: ['-p', '--model', 'glm-5.3'], mode: 'prefix', code: 1, stderr: 'API Error: 429 rate limit' });

    const records: ClaudeCallRecord[] = [];
    const deps = { exec, env: fake.env, onCall: (r: ClaudeCallRecord) => records.push(r) };

    const ok = await runClaude(
      { prompt: 'p1', cwd: tmp.baseDir, model: 'glm-5.3-flash', jsonSchema: SCHEMA },
      deps,
    );
    assert.equal(ok.ok, true);
    assert.equal(records.length, 1);
    assert.equal(records[0]?.model, 'glm-5.3-flash');
    assert.equal(records[0]?.ok, true);
    assert.equal(records[0]?.exitCode, 0);
    assert.equal(records[0]?.durationMs, 15684);
    assert.deepEqual(records[0]?.usage, {
      inputTokens: 3065,
      outputTokens: 112,
      totalCostUsd: 0.018125,
      numTurns: 2,
    });

    const bad = await runClaude({ prompt: 'p2', cwd: tmp.baseDir, model: 'glm-5.3' }, deps);
    assert.equal(bad.ok, false);
    assert.equal(records.length, 2);
    assert.equal(records[1]?.model, 'glm-5.3');
    assert.equal(records[1]?.ok, false);
    assert.equal(records[1]?.exitCode, 1);
    assert.match(records[1]?.error ?? '', /429/);
  } finally {
    fake.remove();
    tmp.cleanup();
  }
});

test('onCall：claude 启动失败（exec 抛错）也回调一次', async () => {
  const failing: ExecFn = async () => {
    throw new Error('spawn ENOENT（模拟命令不存在）');
  };
  const records: ClaudeCallRecord[] = [];
  const result = await runClaude(
    { prompt: 'p', cwd: '/tmp', model: 'glm-5.3' },
    { exec: failing, onCall: (r) => records.push(r) },
  );
  assert.equal(result.ok, false);
  assert.equal(result.retryable, false);
  assert.match(result.error ?? '', /claude 启动失败/);
  assert.deepEqual(records, [
    { model: 'glm-5.3', durationMs: 0, exitCode: -1, ok: false, error: result.error },
  ]);
});

test('与 withRetry 集成：可重试错误重试后成功、不可重试错误不重试', async () => {
  // 第一次乱输出（可重试），第二次正常——注入假 exec 控制时序
  let attempt = 0;
  const flaky: ExecFn = async () => {
    attempt += 1;
    if (attempt === 1) {
      return { code: 1, stdout: '输出坏掉了', stderr: '', timedOut: false, durationMs: 3 };
    }
    return { code: 0, stdout: OK_ENVELOPE, stderr: '', timedOut: false, durationMs: 4 };
  };
  const input = { prompt: '审查', cwd: '/tmp', model: 'glm-5.3-flash', jsonSchema: SCHEMA };
  const recovered = await withRetry(() => runClaude(input, { exec: flaky }), { attempts: 2, backoffMs: 0 });
  assert.equal(recovered.ok, true);
  assert.deepEqual(recovered.output, { ok: true });
  assert.equal(attempt, 2);

  // 认证失败（不可重试）：只调用一次
  let fatalCalls = 0;
  const fatal: ExecFn = async () => {
    fatalCalls += 1;
    return { code: 1, stdout: '', stderr: 'API Error: Invalid API key', timedOut: false, durationMs: 2 };
  };
  const failed = await withRetry(() => runClaude(input, { exec: fatal }), { attempts: 3, backoffMs: 0 });
  assert.equal(failed.ok, false);
  assert.equal(fatalCalls, 1);
});
