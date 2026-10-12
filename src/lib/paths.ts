/**
 * 运行时目录解析（见 #1「运行时目录」）：
 * - 数据目录 GLM_REVIEW_HOME，默认 ~/.local/share/glm-review-bot/
 * - 全局配置 GLM_REVIEW_CONFIG，默认 ~/.config/glm-review-bot/config.yml
 * 支持环境变量覆盖，便于测试隔离。
 */
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

export interface Paths {
  /** 数据目录（GLM_REVIEW_HOME）。 */
  home: string;
  /** 全局配置文件（GLM_REVIEW_CONFIG）。 */
  configFile: string;
  /** 状态库文件。 */
  stateDb: string;
  /** 日志目录。 */
  logsDir: string;
  /** PR 只读检出缓存目录。 */
  reposDir: string;
  /** 守护进程单实例锁文件。 */
  lockFile: string;
}

export function resolvePaths(env: Record<string, string | undefined> = process.env): Paths {
  const userHome = env.HOME && env.HOME.trim() !== '' ? env.HOME : homedir();
  const home = env.GLM_REVIEW_HOME && env.GLM_REVIEW_HOME.trim() !== ''
    ? env.GLM_REVIEW_HOME
    : path.join(userHome, '.local', 'share', 'glm-review-bot');
  const configFile = env.GLM_REVIEW_CONFIG && env.GLM_REVIEW_CONFIG.trim() !== ''
    ? env.GLM_REVIEW_CONFIG
    : path.join(userHome, '.config', 'glm-review-bot', 'config.yml');
  return {
    home,
    configFile,
    stateDb: path.join(home, 'state.db'),
    logsDir: path.join(home, 'logs'),
    reposDir: path.join(home, 'repos'),
    lockFile: path.join(home, 'daemon.lock'),
  };
}

/** 确保用到的目录存在（home / logs / repos）。 */
export function ensureDirs(paths: Paths): void {
  for (const dir of [paths.home, paths.logsDir, paths.reposDir]) {
    mkdirSync(dir, { recursive: true });
  }
}
