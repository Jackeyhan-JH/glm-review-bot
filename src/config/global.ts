/**
 * 全局配置（#3）：机器人自己的配置文件（默认 `~/.config/glm-review-bot/config.yml`，
 * 路径来自 `paths.configFile`）。加载 = 读文件 → YAML 解析 → 与默认值深合并 → 校验；
 * 文件不存在时返回默认值并打警告日志；任何校验错误都抛带字段路径的中文异常。
 */
import { existsSync, readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import type { Logger } from '../lib/log.ts';
import { deepMerge, validateObject, yamlSyntaxErrorMessage, type Schema } from './validate.ts';

export interface GlobalModelsConfig {
  /** 小 diff 用的模型。 */
  small: string;
  /** 大 diff 用的模型。 */
  large: string;
  /** ≤ 此改动行数用 small。 */
  smallDiffLines: number;
}

export interface GlobalClaudeConfig {
  bin: string;
  effort: 'low' | 'medium' | 'high';
  timeoutSec: number;
  /** 单次调用最多审多少行 diff。 */
  maxChunkLines: number;
  /** 超过就只审前 N 块并在总评里说明。 */
  maxChunksPerReview: number;
}

export interface GlobalRetryConfig {
  maxAttempts: number;
  backoffSec: number[];
}

export interface GlobalConfig {
  /** 仓库白名单（`owner/name`），空列表 = 什么都不审。 */
  repos: string[];
  pollIntervalSec: number;
  maxConcurrent: number;
  boxClaudeLimit: number;
  pauseFile: string;
  models: GlobalModelsConfig;
  claude: GlobalClaudeConfig;
  retry: GlobalRetryConfig;
  statusPort: number;
  peak: { enabled: boolean };
}

export interface GlobalConfigDeps {
  log: Logger;
}

/** 与 issue #3 示例一致的默认值（repos 除外：缺省为空列表）。 */
export function defaultGlobalConfig(): GlobalConfig {
  return {
    repos: [],
    pollIntervalSec: 120,
    maxConcurrent: 1,
    boxClaudeLimit: 4,
    pauseFile: '/workspace/GLM_PAUSE',
    models: { small: 'glm-5.3-flash', large: 'glm-5.3', smallDiffLines: 300 },
    claude: { bin: 'claude', effort: 'high', timeoutSec: 900, maxChunkLines: 800, maxChunksPerReview: 8 },
    retry: { maxAttempts: 3, backoffSec: [60, 300, 1800] },
    statusPort: 47180,
    peak: { enabled: true },
  };
}

const REPO_SLUG = { re: /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, message: '必须是 "owner/name" 形式的仓库' };

const GLOBAL_SCHEMA: Schema = {
  repos: { type: 'array', itemType: 'string', itemPattern: REPO_SLUG },
  pollIntervalSec: { type: 'integer', min: 30 },
  maxConcurrent: { type: 'integer', min: 1, max: 4 },
  boxClaudeLimit: { type: 'integer', min: 1 },
  pauseFile: { type: 'string', minLength: 1 },
  models: {
    type: 'object',
    fields: {
      small: { type: 'string', minLength: 1 },
      large: { type: 'string', minLength: 1 },
      smallDiffLines: { type: 'integer', min: 1 },
    },
  },
  claude: {
    type: 'object',
    fields: {
      bin: { type: 'string', minLength: 1 },
      effort: { type: 'string', enumValues: ['low', 'medium', 'high'] },
      timeoutSec: { type: 'integer', min: 1 },
      maxChunkLines: { type: 'integer', min: 1 },
      maxChunksPerReview: { type: 'integer', min: 1 },
    },
  },
  retry: {
    type: 'object',
    fields: {
      maxAttempts: { type: 'integer', min: 1 },
      backoffSec: { type: 'array', itemType: 'integer', itemMin: 1 },
    },
  },
  statusPort: { type: 'integer', min: 1, max: 65535 },
  peak: { type: 'object', fields: { enabled: { type: 'boolean' } } },
};

/**
 * 加载全局配置：文件不存在 → 默认值 + 警告日志；YAML 语法错或校验错 → 抛中文异常
 * （语法错带行号，校验错逐条带字段路径，一次全部报出）。
 */
export function loadGlobalConfig(file: string, deps: GlobalConfigDeps): GlobalConfig {
  if (!existsSync(file)) {
    deps.log.warn('全局配置文件不存在，使用默认值（repos 为空：不审查任何仓库）', { file });
    return defaultGlobalConfig();
  }
  const text = readFileSync(file, 'utf8');
  let raw: unknown;
  try {
    raw = text.trim() === '' ? {} : parseYaml(text);
  } catch (err) {
    throw new Error(yamlSyntaxErrorMessage(err, `全局配置 ${file}`));
  }
  const merged = deepMerge(defaultGlobalConfig(), raw);
  const errors: string[] = [];
  validateObject(merged, GLOBAL_SCHEMA, '', errors);
  if (errors.length > 0) {
    throw new Error(`全局配置校验失败（${file}）：\n${errors.map((e) => `- ${e}`).join('\n')}`);
  }
  return merged;
}

/** `glm-review config init` 写出的带注释默认配置（值与 issue #3 示例一致）。 */
export function defaultGlobalConfigTemplate(): string {
  return [
    '# glm-review-bot 全局配置（由 glm-review config init 生成）。',
    '# 删除某个字段即恢复默认值；各字段含义见仓库 issue #1。',
    'repos:                         # 白名单，只审这些仓库；空列表 = 什么都不审',
    '  - Jackeyhan-JH/glm-toolbox',
    '  - Jackeyhan-JH/split-bill',
    '  - Jackeyhan-JH/glm-night-shift',
    '  - Jackeyhan-JH/glm-peak-clock',
    'pollIntervalSec: 120           # 轮询间隔（秒），≥ 30',
    'maxConcurrent: 1               # 审查机器人自己同时跑的 claude 数，1–4',
    'boxClaudeLimit: 4              # 本机 claude 进程总数上限（含其他团队）',
    'pauseFile: /workspace/GLM_PAUSE  # 该文件存在期间不启动新的 claude',
    'models:',
    '  small: glm-5.3-flash         # 小 diff 用的模型',
    '  large: glm-5.3               # 大 diff 用的模型',
    '  smallDiffLines: 300          # ≤ 此行数用 small',
    'claude:',
    '  bin: claude',
    '  effort: high                 # low / medium / high',
    '  timeoutSec: 900              # 单次 claude 调用超时',
    '  maxChunkLines: 800           # 单次调用最多审多少行 diff',
    '  maxChunksPerReview: 8        # 超过就只审前 N 块并在总评里说明',
    'retry:',
    '  maxAttempts: 3',
    '  backoffSec: [60, 300, 1800]',
    'statusPort: 47180              # 状态网页端口（只监听 127.0.0.1）',
    'peak:',
    '  enabled: true                # 高峰期（工作日北京时间 14–18 点）不调用 GLM',
    '',
  ].join('\n');
}
