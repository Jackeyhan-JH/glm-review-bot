/**
 * 打印演示数据的终端渲染与 JSON（开发辅助，不是测试）：
 * 用于核对排版、生成快照测试的期望值。用法：node test/status/print-demo.ts
 */
import { collectStatus } from '../../src/status/collect.ts';
import { renderStatusText } from '../../src/status/render-text.ts';
import { DEMO_NOW, openTmpStatus, seedDemoState } from './helpers.ts';

const t = openTmpStatus('glm-review-print-demo');
try {
  seedDemoState(t.state);
  const snapshot = collectStatus(t.state, DEMO_NOW, { pauseFile: t.pauseFile });
  process.stdout.write(renderStatusText(snapshot));
  process.stdout.write('\n===== JSON =====\n');
  process.stdout.write(`${JSON.stringify(snapshot)}\n`);
} finally {
  t.cleanup();
}
