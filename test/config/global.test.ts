import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { test } from 'node:test';
import type { Logger } from '../../src/lib/log.ts';
import { createTmpEnv } from '../helpers/tmp.ts';
import { defaultGlobalConfig, loadGlobalConfig } from '../../src/config/global.ts';

function captureLogger(): Logger & { warnings: string[] } {
  const warnings: string[] = [];
  return {
    warnings,
    debug: () => {},
    info: () => {},
    warn: (msg) => {
      warnings.push(msg);
    },
    error: () => {},
  };
}

test('文件不存在：返回默认值并打警告日志', () => {
  const tmp = createTmpEnv('glm-review-global-default');
  try {
    const log = captureLogger();
    const config = loadGlobalConfig(tmp.configPath, { log });
    assert.deepEqual(config, defaultGlobalConfig());
    assert.deepEqual(config.repos, []);
    assert.equal(log.warnings.length, 1);
    assert.match(log.warnings[0], /全局配置文件不存在/);
  } finally {
    tmp.cleanup();
  }
});

test('默认值与 issue #3 示例一致', () => {
  const config = defaultGlobalConfig();
  assert.deepEqual(config.repos, []);
  assert.equal(config.pollIntervalSec, 120);
  assert.equal(config.maxConcurrent, 1);
  assert.equal(config.boxClaudeLimit, 4);
  assert.equal(config.pauseFile, '/workspace/GLM_PAUSE');
  assert.deepEqual(config.models, { small: 'glm-5.3-flash', large: 'glm-5.3', smallDiffLines: 300 });
  assert.deepEqual(config.claude, {
    bin: 'claude',
    effort: 'high',
    timeoutSec: 900,
    maxChunkLines: 800,
    maxChunksPerReview: 8,
  });
  assert.deepEqual(config.retry, { maxAttempts: 3, backoffSec: [60, 300, 1800] });
  assert.equal(config.statusPort, 47180);
  assert.deepEqual(config.peak, { enabled: true });
});

test('完整示例配置加载出全部字段', () => {
  const tmp = createTmpEnv('glm-review-global-full');
  try {
    writeFileSync(
      tmp.configPath,
      [
        'repos:',
        '  - Jackeyhan-JH/glm-toolbox',
        '  - Jackeyhan-JH/split-bill',
        '  - Jackeyhan-JH/glm-night-shift',
        '  - Jackeyhan-JH/glm-peak-clock',
        'pollIntervalSec: 120',
        'maxConcurrent: 1',
        'boxClaudeLimit: 4',
        'pauseFile: /workspace/GLM_PAUSE',
        'models:',
        '  small: glm-5.3-flash',
        '  large: glm-5.3',
        '  smallDiffLines: 300',
        'claude:',
        '  bin: claude',
        '  effort: high',
        '  timeoutSec: 900',
        '  maxChunkLines: 800',
        '  maxChunksPerReview: 8',
        'retry: { maxAttempts: 3, backoffSec: [60, 300, 1800] }',
        'statusPort: 47180',
        'peak: { enabled: true }',
        '',
      ].join('\n'),
    );
    const config = loadGlobalConfig(tmp.configPath, { log: captureLogger() });
    assert.deepEqual(config.repos, [
      'Jackeyhan-JH/glm-toolbox',
      'Jackeyhan-JH/split-bill',
      'Jackeyhan-JH/glm-night-shift',
      'Jackeyhan-JH/glm-peak-clock',
    ]);
    assert.equal(config.pollIntervalSec, 120);
    assert.deepEqual(config.models, { small: 'glm-5.3-flash', large: 'glm-5.3', smallDiffLines: 300 });
    assert.deepEqual(config.retry, { maxAttempts: 3, backoffSec: [60, 300, 1800] });
    assert.deepEqual(config.peak, { enabled: true });
  } finally {
    tmp.cleanup();
  }
});

test('部分覆盖：对象深合并，未覆盖字段保持默认', () => {
  const tmp = createTmpEnv('glm-review-global-partial');
  try {
    writeFileSync(
      tmp.configPath,
      ['pollIntervalSec: 60', 'models:', '  small: my-flash', 'peak: { enabled: false }', ''].join('\n'),
    );
    const config = loadGlobalConfig(tmp.configPath, { log: captureLogger() });
    assert.equal(config.pollIntervalSec, 60);
    assert.equal(config.models.small, 'my-flash');
    assert.equal(config.models.large, 'glm-5.3');
    assert.equal(config.models.smallDiffLines, 300);
    assert.deepEqual(config.peak, { enabled: false });
    assert.equal(config.maxConcurrent, 1);
    assert.deepEqual(config.retry, { maxAttempts: 3, backoffSec: [60, 300, 1800] });
  } finally {
    tmp.cleanup();
  }
});

test('数组整体替换，不与默认值拼接', () => {
  const tmp = createTmpEnv('glm-review-global-array');
  try {
    writeFileSync(
      tmp.configPath,
      ['repos:', '  - a/b', 'retry:', '  backoffSec: [10]', ''].join('\n'),
    );
    const config = loadGlobalConfig(tmp.configPath, { log: captureLogger() });
    assert.deepEqual(config.repos, ['a/b']);
    assert.deepEqual(config.retry.backoffSec, [10]);
    assert.equal(config.retry.maxAttempts, 3);
  } finally {
    tmp.cleanup();
  }
});

test('未知字段：中文错误并带字段路径', () => {
  const tmp = createTmpEnv('glm-review-global-unknown');
  try {
    writeFileSync(tmp.configPath, 'pollIntervalSecs: 60\n');
    assert.throws(
      () => loadGlobalConfig(tmp.configPath, { log: captureLogger() }),
      /全局配置校验失败[\s\S]*未知字段：pollIntervalSecs/,
    );
  } finally {
    tmp.cleanup();
  }
});

test('类型错误：中文错误并带字段路径', () => {
  const tmp = createTmpEnv('glm-review-global-type');
  try {
    writeFileSync(tmp.configPath, 'pollIntervalSec: "abc"\n');
    assert.throws(
      () => loadGlobalConfig(tmp.configPath, { log: captureLogger() }),
      /pollIntervalSec 必须是整数，收到 "abc"/,
    );
    writeFileSync(tmp.configPath, 'peak: { enabled: "yes" }\n');
    assert.throws(
      () => loadGlobalConfig(tmp.configPath, { log: captureLogger() }),
      /peak\.enabled 必须是布尔值（true\/false），收到 "yes"/,
    );
    writeFileSync(tmp.configPath, 'models: []\n');
    assert.throws(
      () => loadGlobalConfig(tmp.configPath, { log: captureLogger() }),
      /models 必须是键值映射，收到 数组（0 项）/,
    );
    writeFileSync(tmp.configPath, 'repos: "a/b"\n');
    assert.throws(
      () => loadGlobalConfig(tmp.configPath, { log: captureLogger() }),
      /repos 必须是数组，收到 "a\/b"/,
    );
  } finally {
    tmp.cleanup();
  }
});

test('取值越界与非法枚举：中文错误并带字段路径', () => {
  const tmp = createTmpEnv('glm-review-global-range');
  try {
    writeFileSync(tmp.configPath, 'pollIntervalSec: 10\n');
    assert.throws(
      () => loadGlobalConfig(tmp.configPath, { log: captureLogger() }),
      /pollIntervalSec 必须 ≥ 30，收到 10/,
    );
    writeFileSync(tmp.configPath, 'maxConcurrent: 9\n');
    assert.throws(
      () => loadGlobalConfig(tmp.configPath, { log: captureLogger() }),
      /maxConcurrent 必须在 1–4 之间，收到 9/,
    );
    writeFileSync(tmp.configPath, 'statusPort: 70000\n');
    assert.throws(
      () => loadGlobalConfig(tmp.configPath, { log: captureLogger() }),
      /statusPort 必须在 1–65535 之间，收到 70000/,
    );
    writeFileSync(tmp.configPath, 'claude: { effort: ultra }\n');
    assert.throws(
      () => loadGlobalConfig(tmp.configPath, { log: captureLogger() }),
      /claude\.effort 必须是 low\/medium\/high 之一，收到 "ultra"/,
    );
    writeFileSync(tmp.configPath, 'repos:\n  - "不是合法仓库"\n');
    assert.throws(
      () => loadGlobalConfig(tmp.configPath, { log: captureLogger() }),
      /repos\[0\] 必须是 "owner\/name" 形式的仓库，收到 "不是合法仓库"/,
    );
  } finally {
    tmp.cleanup();
  }
});

test('多个错误一次性全部报出', () => {
  const tmp = createTmpEnv('glm-review-global-multi');
  try {
    writeFileSync(tmp.configPath, 'foo: 1\npollIntervalSec: 10\nmaxConcurrent: 9\n');
    assert.throws(
      () => loadGlobalConfig(tmp.configPath, { log: captureLogger() }),
      (err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        return (
          message.includes('未知字段：foo') &&
          message.includes('pollIntervalSec 必须 ≥ 30') &&
          message.includes('maxConcurrent 必须在 1–4 之间')
        );
      },
    );
  } finally {
    tmp.cleanup();
  }
});

test('YAML 语法错误：中文错误并带行号', () => {
  const tmp = createTmpEnv('glm-review-global-syntax');
  try {
    writeFileSync(tmp.configPath, 'repos:\n  - a/b\n pollIntervalSec: 120\n');
    assert.throws(
      () => loadGlobalConfig(tmp.configPath, { log: captureLogger() }),
      (err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        return /YAML 语法错误（第 3 行）/.test(message) && message.includes('全局配置');
      },
    );
  } finally {
    tmp.cleanup();
  }
});

test('根节点不是键值映射：中文错误', () => {
  const tmp = createTmpEnv('glm-review-global-root');
  try {
    writeFileSync(tmp.configPath, '- a\n- b\n');
    assert.throws(
      () => loadGlobalConfig(tmp.configPath, { log: captureLogger() }),
      /根节点 必须是键值映射，收到 数组（2 项）/,
    );
    writeFileSync(tmp.configPath, '\n\n');
    const config = loadGlobalConfig(tmp.configPath, { log: captureLogger() });
    assert.deepEqual(config, defaultGlobalConfig());
  } finally {
    tmp.cleanup();
  }
});
