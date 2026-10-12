import assert from 'node:assert/strict';
import { test } from 'node:test';
import { exec } from '../../src/lib/exec.ts';

test('exec 捕获 stdout、stderr 与退出码', async () => {
  const result = await exec(process.execPath, [
    '-e',
    'console.log("标准输出"); console.error("错误输出"); process.exit(3)',
  ]);
  assert.equal(result.code, 3);
  assert.equal(result.stdout, '标准输出\n');
  assert.equal(result.stderr, '错误输出\n');
  assert.equal(result.timedOut, false);
});

test('exec 参数含空格、引号、$() 时原样传递，不经 shell', async () => {
  const tricky = "a b'c\"d\"e$(touch /tmp/glm-review-shell-pwned)`f`";
  const result = await exec(process.execPath, [
    '-e',
    'process.stdout.write(process.argv[1])',
    tricky,
  ]);
  assert.equal(result.stdout, tricky);
  assert.equal(result.timedOut, false);
});

test('exec 把 input 写入子进程 stdin', async () => {
  const result = await exec(
    process.execPath,
    ['-e', 'let d="";process.stdin.setEncoding("utf8").on("data",c=>d+=c).on("end",()=>process.stdout.write(d.trim().toUpperCase()))'],
    { input: 'hello glm' },
  );
  assert.equal(result.stdout, 'HELLO GLM');
});

test('exec 超时后终止子进程并返回 timedOut: true', async () => {
  const result = await exec(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    timeoutMs: 250,
    // 缩短短宽限期：即使子进程忽略 SIGINT，也会在约 550ms 内被 SIGKILL，
    // 断言不受环境影响。
    killGraceMs: 300,
  });
  assert.equal(result.timedOut, true);
  assert.notEqual(result.code, 0);
  assert.ok(result.durationMs < 4000, `耗时 ${result.durationMs}ms 应远小于 4s`);
});

test('exec 超时后忽略 SIGINT 的进程在宽限期后被 SIGKILL', async () => {
  const result = await exec(
    process.execPath,
    ['-e', 'process.on("SIGINT", () => {}); setInterval(() => {}, 1000)'],
    { timeoutMs: 200, killGraceMs: 150 },
  );
  assert.equal(result.timedOut, true);
  assert.ok(result.durationMs < 2000, `耗时 ${result.durationMs}ms 应远小于 2s`);
});

test('exec 自定义 env 传给子进程', async () => {
  const result = await exec(process.execPath, ['-e', 'process.stdout.write(process.env.GLM_TEST_VAR ?? "")'], {
    env: { ...process.env, GLM_TEST_VAR: '自定义环境' },
  });
  assert.equal(result.stdout, '自定义环境');
});

test('exec 命令不存在时抛出错误', async () => {
  await assert.rejects(exec('glm-review-绝对不存在的命令-xyz', ['--foo']));
});
