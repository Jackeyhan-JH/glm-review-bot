/**
 * 演示用状态页（#14 验收标准第 4 条：截图）：
 * 在临时目录里种一份演示数据（心跳相对当前时刻是新鲜的），启动状态网页。
 * 只监听 127.0.0.1，不碰真实 gh / claude / 网络。Ctrl+C 退出。
 *
 * 用法：node test/status/demo.ts [端口]        # 端口默认 43140
 */
import { systemClock } from '../../src/lib/clock.ts';
import { createLogger } from '../../src/lib/log.ts';
import { startStatusServer } from '../../src/status/server.ts';
import { openTmpStatus, seedDemoState } from './helpers.ts';

const port = Number(process.argv[2] ?? '43140');
if (!Number.isInteger(port) || port < 1 || port > 65_535) {
  process.stderr.write(`无效端口：${process.argv[2]}\n`);
  process.exit(2);
}

const t = openTmpStatus('glm-review-status-demo');
// 以当前时刻播种（心跳 = 15 秒前，队列 / 账本时间相对当下自洽），页面实时采集。
seedDemoState(t.state, new Date());

const server = await startStatusServer({
  db: t.state,
  clock: systemClock,
  pauseFile: t.pauseFile,
  port,
  log: createLogger({ echo: true }),
});

process.stdout.write(`演示状态页已启动：http://127.0.0.1:${server.port}/\n`);
process.stdout.write(`浅色：http://127.0.0.1:${server.port}/?theme=light\n`);
process.stdout.write(`深色：http://127.0.0.1:${server.port}/?theme=dark\n`);
process.stdout.write('Ctrl+C 退出。\n');

const shutdown = (): void => {
  process.stdout.write('正在关闭…\n');
  void server.close().then(() => {
    t.cleanup();
    process.exit(0);
  });
};
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
