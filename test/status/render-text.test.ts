/**
 * 终端文本渲染测试（验收标准第 2 条前半）：空库与演示数据两个快照，
 * 外加 displayWidth / formatDuration 的单元断言。
 * 快照用固定的 pauseFile 路径保证可复现（路径本身不出现在机器上）。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { collectStatus } from '../../src/status/collect.ts';
import { displayWidth, formatDuration, renderStatusText } from '../../src/status/render-text.ts';
import { DEMO_NOW, openTmpStatus, seedDemoState } from './helpers.ts';

/** 快照专用的固定暂停文件路径（不存在，只影响文案里的路径显示）。 */
const SNAPSHOT_PAUSE_FILE = '/tmp/glm-review-status-snapshot/GLM_PAUSE';

test('文本快照：空库', () => {
  const t = openTmpStatus();
  try {
    const snapshot = collectStatus(t.state, DEMO_NOW, { pauseFile: SNAPSHOT_PAUSE_FILE });
    assert.equal(
      renderStatusText(snapshot),
      `GLM 审查机器人状态
生成时间：北京时间 10月12日 周一 15:30 / 美东 10月12日 周一 03:30（America/New_York）

守护进程：未运行或无心跳
GLM 高峰：当前高峰期（不调用 GLM）；下一次切换（回到非高峰）：北京时间 10月12日 周一 18:00 / 美东 10月12日 周一 06:00，还有 2 小时 30 分
额度暂停：未暂停（${SNAPSHOT_PAUSE_FILE} 不存在）

任务统计：排队 0 · 延后 0 · 进行中 0 · 完成 0 · 失败 0 · 跳过 0（共 0）

等待队列：空

最近审查：还没有记录

claude 用量：
  今天（北京时间 10月12日 周一）：0 次（成功 0 · 失败 0），输入 0 tokens，输出 0 tokens
  近 7 天：0 次（成功 0 · 失败 0），输入 0 tokens，输出 0 tokens
`,
    );
  } finally {
    t.cleanup();
  }
});

test('文本快照：演示数据（心跳、队列、审查、用量俱全）', () => {
  const t = openTmpStatus();
  try {
    seedDemoState(t.state);
    const snapshot = collectStatus(t.state, DEMO_NOW, { pauseFile: SNAPSHOT_PAUSE_FILE });
    assert.equal(
      renderStatusText(snapshot),
      `GLM 审查机器人状态
生成时间：北京时间 10月12日 周一 15:30 / 美东 10月12日 周一 03:30（America/New_York）

守护进程：运行中（15 秒前更新，过期阈值 3 × 120 秒）
  上一轮轮询耗时：4.2 秒
  开放 PR：Jackeyhan-JH/glm-toolbox 2、Jackeyhan-JH/split-bill 1
GLM 高峰：当前高峰期（不调用 GLM）；下一次切换（回到非高峰）：北京时间 10月12日 周一 18:00 / 美东 10月12日 周一 06:00，还有 2 小时 30 分
额度暂停：未暂停（${SNAPSHOT_PAUSE_FILE} 不存在）

任务统计：排队 1 · 延后 1 · 进行中 1 · 完成 2 · 失败 1 · 跳过 1（共 7）

等待队列（按可执行时间排序）：
  仓库                      PR   状态    可执行时间（北京时间）  还需等待      尝试  原因
  Jackeyhan-JH/glm-toolbox  #25  进行中  10月12日 周一 15:05     已可执行      1     —
  Jackeyhan-JH/split-bill   #9   排队    10月12日 周一 15:29     已可执行      1     gh 请求被限流（HTTP 403）
  Jackeyhan-JH/glm-toolbox  #24  延后    10月12日 周一 18:00     2 小时 30 分  0     peak

最近审查（最多 20 条）：
  仓库                          PR   commit   结果  问题数  模型           耗时   review
  Jackeyhan-JH/glm-peak-clock   #2   5201314  跳过  —       —              —      superseded
  Jackeyhan-JH/glm-toolbox      #23  1f3e5d7  成功  3       glm-5.3-flash  3 分   https://github.com/Jackeyhan-JH/glm-toolbox/pull/23#pullrequestreview-2405112601
  Jackeyhan-JH/split-bill       #8   0a1b2c3  成功  1       glm-5.3        15 分  https://github.com/Jackeyhan-JH/split-bill/pull/8#pullrequestreview-2405107777
  Jackeyhan-JH/glm-night-shift  #5   9f8e7d6  失败  —       —              0 秒   claude 退出码 124：调用超时

claude 用量：
  今天（北京时间 10月12日 周一）：3 次（成功 2 · 失败 1），输入 57,500 tokens，输出 11,400 tokens
  近 7 天：4 次（成功 3 · 失败 1），输入 87,500 tokens，输出 16,400 tokens
`,
    );
  } finally {
    t.cleanup();
  }
});

test('displayWidth：CJK 按两列计', () => {
  assert.equal(displayWidth('abc'), 3);
  assert.equal(displayWidth('中文'), 4);
  assert.equal(displayWidth('中文a'), 5);
  assert.equal(displayWidth('成功·失败'), 9); // 「·」是窄字符，占 1 列
  assert.equal(displayWidth(''), 0);
});

test('formatDuration：秒 / 分 / 时 / 天', () => {
  assert.equal(formatDuration(4_200), '4.2 秒');
  assert.equal(formatDuration(60_000), '1 分');
  assert.equal(formatDuration(90_000), '1 分 30 秒');
  assert.equal(formatDuration(180_000), '3 分');
  assert.equal(formatDuration(9_000_000), '2 小时 30 分');
  assert.equal(formatDuration(97_200_000), '1 天 3 小时');
  assert.equal(formatDuration(-5_000), '0 秒');
});
