/**
 * 临时运行环境：隔离的 GLM_REVIEW_HOME 与配置目录，测试结束自动清理。
 * 进程退出时会兜底删除本次测试创建的所有临时目录。
 */
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

export interface TmpEnv {
  /** 临时目录根（其下有 home/ 与 config/）。 */
  baseDir: string;
  homeDir: string;
  configDir: string;
  configPath: string;
  /** 原环境 + GLM_REVIEW_HOME / GLM_REVIEW_CONFIG 覆盖。 */
  env: Record<string, string | undefined>;
  cleanup(): void;
}

const createdDirs: string[] = [];
let exitHookInstalled = false;

function installExitHook(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.on('exit', () => {
    for (const dir of createdDirs) rmSync(dir, { recursive: true, force: true });
  });
}

export function createTmpEnv(prefix = 'glm-review-test'): TmpEnv {
  installExitHook();
  const baseDir = mkdtempSync(path.join(tmpdir(), `${prefix}-`));
  createdDirs.push(baseDir);
  const homeDir = path.join(baseDir, 'home');
  const configDir = path.join(baseDir, 'config');
  mkdirSync(homeDir, { recursive: true });
  mkdirSync(configDir, { recursive: true });
  const configPath = path.join(configDir, 'config.yml');
  const env: Record<string, string | undefined> = {
    ...process.env,
    GLM_REVIEW_HOME: homeDir,
    GLM_REVIEW_CONFIG: configPath,
  };
  const cleanup = (): void => {
    rmSync(baseDir, { recursive: true, force: true });
    const index = createdDirs.indexOf(baseDir);
    if (index !== -1) createdDirs.splice(index, 1);
  };
  return { baseDir, homeDir, configDir, configPath, env, cleanup };
}
