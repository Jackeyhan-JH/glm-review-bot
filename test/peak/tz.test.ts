/**
 * 证明高峰计算不受本机 TZ 影响：分别在 TZ=America/New_York、UTC、Asia/Shanghai、
 * Australia/Sydney（南半球夏令时）下各起一个真实 node 子进程跑一遍，
 * 结果必须完全相同，且与验收标准钉死的时刻一致。
 *
 * 子进程只跑本仓库的纯函数与 CLI（node src/…），不碰网络 / gh / claude。
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..');
const PEAK_MODULE_URL = pathToFileURL(path.join(REPO_ROOT, 'src', 'peak', 'peak.ts')).href;

/** 覆盖验收标准的时刻：EDT/EST 两个高峰开始、高峰结束、高峰中、周六。 */
const SAMPLES: Array<{ now: string; peak: boolean; nextSwitch: string }> = [
  { now: '2026-10-12T06:00:00Z', peak: true, nextSwitch: '2026-10-12T10:00:00.000Z' }, // 美东周一 02:00（EDT）
  { now: '2026-11-02T06:00:00Z', peak: true, nextSwitch: '2026-11-02T10:00:00.000Z' }, // 美东周一 01:00（EST）
  { now: '2026-10-12T07:00:00Z', peak: true, nextSwitch: '2026-10-12T10:00:00.000Z' }, // 高峰中
  { now: '2026-10-12T10:00:00Z', peak: false, nextSwitch: '2026-10-13T06:00:00.000Z' }, // 高峰结束（右开）
  { now: '2026-10-17T02:30:00Z', peak: false, nextSwitch: '2026-10-19T06:00:00.000Z' }, // 周六全天非高峰
];

const TIME_ZONES = ['America/New_York', 'UTC', 'Asia/Shanghai', 'Australia/Sydney'];

/** 在指定 TZ 的子进程里逐个算 SAMPLES，返回与 SAMPLES 对齐的 JSON 行。 */
function runInTimeZone(tz: string): Array<{ peak: boolean; nextSwitch: string; toPeak: boolean; ms: number }> {
  // 对每个时区只起一个子进程：动态 import 真实 src/peak/peak.ts 后逐个时刻输出。
  const script = `
import(${JSON.stringify(PEAK_MODULE_URL)}).then((mod) => {
  const isos = process.argv.slice(1);
  const lines = isos.map((iso) => {
    const d = new Date(iso);
    const sw = mod.nextSwitch(d);
    return JSON.stringify({
      peak: mod.isPeak(d),
      nextSwitch: sw.at.toISOString(),
      toPeak: sw.toPeak,
      ms: sw.at.getTime() - d.getTime(),
    });
  });
  console.log(lines.join('\\n'));
}, (err) => {
  console.error(String(err));
  process.exitCode = 1;
});
`;
  const result = spawnSync(process.execPath, ['-e', script, ...SAMPLES.map((s) => s.now)], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout: 60_000,
    env: { ...process.env, TZ: tz },
  });
  assert.equal(result.status, 0, `TZ=${tz} 子进程退出码（stderr: ${result.stderr}）`);
  const lines = result.stdout.trim().split('\n');
  assert.equal(lines.length, SAMPLES.length, `TZ=${tz} 输出行数`);
  return lines.map((line) => JSON.parse(line) as { peak: boolean; nextSwitch: string; toPeak: boolean; ms: number });
}

test('高峰计算不受本机 TZ 影响：四个时区下逐点结果一致且符合验收时刻', () => {
  const baseline = runInTimeZone('America/New_York');
  for (const tz of TIME_ZONES) {
    const results = runInTimeZone(tz);
    assert.deepEqual(results, baseline, `TZ=${tz} 与 TZ=America/New_York 结果不同`);
    for (let i = 0; i < SAMPLES.length; i++) {
      assert.equal(results[i]?.peak, SAMPLES[i]?.peak, `TZ=${tz} peak @ ${SAMPLES[i]?.now}`);
      assert.equal(results[i]?.nextSwitch, SAMPLES[i]?.nextSwitch, `TZ=${tz} nextSwitch @ ${SAMPLES[i]?.now}`);
      assert.equal(results[i]?.toPeak, !SAMPLES[i]?.peak, `TZ=${tz} toPeak @ ${SAMPLES[i]?.now}`);
    }
  }
});

test('CLI 端到端也不受本机 TZ 影响：--json 输出逐字节一致', () => {
  const outputs: string[] = [];
  for (const tz of TIME_ZONES) {
    const result = spawnSync(
      process.execPath,
      ['src/cli.ts', 'peak', '--now', '2026-10-12T07:00:00Z', '--json'],
      { cwd: REPO_ROOT, encoding: 'utf8', timeout: 60_000, env: { ...process.env, TZ: tz } },
    );
    assert.equal(result.status, 0, `TZ=${tz}`);
    assert.equal(result.stderr, '', `TZ=${tz}`);
    outputs.push(result.stdout);
  }
  assert.ok(outputs.every((out) => out === outputs[0]));
  assert.equal(outputs[0], '{"peak":true,"nextSwitch":"2026-10-12T10:00:00.000Z","msUntilSwitch":10800000}\n');
});
