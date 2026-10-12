/**
 * 仓库配置（#3）：被审仓库**默认分支**根目录的 `.glm-review.yml`（可缺省）。
 * `parseRepoConfig` 解析 YAML 文本并合并默认值；出错时不中断审查，而是返回
 * `{ config: 默认值, errors: [...] }`（错误带 `.glm-review.yml:` 前缀与字段路径），
 * 由流水线在总评里提示。`loadRepoConfig` 用 `gh api` 取默认分支上的文件内容，
 * 404 视为缺省，其他错误抛出。
 */
import { parse as parseYaml } from 'yaml';
import type { ExecFn } from '../lib/exec.ts';
import type { Severity } from '../lib/types.ts';
import { isIgnored } from './glob.ts';
import { deepMerge, validateObject, yamlSyntaxErrorMessage, type Schema } from './validate.ts';

export const REPO_CONFIG_FILENAME = '.glm-review.yml';

export interface RepoConfig {
  enabled: boolean;
  /** 评论语言。 */
  language: 'zh' | 'en';
  /** 低于此严重度的问题不发（blocker > major > minor > nit）。 */
  minSeverity: Severity;
  /** 行内评论上限，超出的并入总评。 */
  maxComments: number;
  /** glob，叠加在内置忽略之上。 */
  ignore: string[];
  skipDrafts: boolean;
  skipLabels: string[];
  skipAuthors: string[];
  /** 给审查者的额外说明（≤ 500 字），缺省无。 */
  focus?: string;
}

export interface RepoConfigResult {
  config: RepoConfig;
  errors: string[];
}

export interface RepoConfigDeps {
  exec: ExecFn;
  /** 传给 gh 的环境变量（测试注入假 gh 的 PATH）；缺省继承当前进程。 */
  env?: Record<string, string | undefined>;
}

/** 与 issue #3 示例一致的默认值。 */
export function defaultRepoConfig(): RepoConfig {
  return {
    enabled: true,
    language: 'zh',
    minSeverity: 'minor',
    maxComments: 20,
    ignore: [],
    skipDrafts: true,
    skipLabels: ['no-review'],
    skipAuthors: [],
  };
}

const REPO_SCHEMA: Schema = {
  enabled: { type: 'boolean' },
  language: { type: 'string', enumValues: ['zh', 'en'] },
  minSeverity: { type: 'string', enumValues: ['blocker', 'major', 'minor', 'nit'] },
  maxComments: { type: 'integer', min: 1 },
  ignore: { type: 'array', itemType: 'string' },
  skipDrafts: { type: 'boolean' },
  skipLabels: { type: 'array', itemType: 'string' },
  skipAuthors: { type: 'array', itemType: 'string' },
  focus: { type: 'string', maxLength: 500 },
};

/** 解析仓库配置文本（null = 文件缺省）：有错时返回默认值 + 中文错误列表。 */
export function parseRepoConfig(yamlText: string | null): RepoConfigResult {
  const defaults = defaultRepoConfig();
  if (yamlText === null || yamlText.trim() === '') {
    return { config: defaults, errors: [] };
  }
  let raw: unknown;
  try {
    raw = parseYaml(yamlText);
  } catch (err) {
    return { config: defaults, errors: [yamlSyntaxErrorMessage(err, REPO_CONFIG_FILENAME)] };
  }
  const merged = deepMerge(defaults, raw);
  const errors: string[] = [];
  validateObject(merged, REPO_SCHEMA, '', errors);
  if (errors.length > 0) {
    return { config: defaults, errors: errors.map((e) => `${REPO_CONFIG_FILENAME}: ${e}`) };
  }
  return { config: merged, errors: [] };
}

/** 二进制与图片等不应审查的文件扩展名（内置忽略的一部分，匹配大小写敏感）。 */
const BINARY_AND_IMAGE_EXTENSIONS = [
  // 图片
  'png', 'jpg', 'jpeg', 'gif', 'bmp', 'svg', 'webp', 'ico', 'tiff',
  // 字体
  'woff', 'woff2', 'ttf', 'otf', 'eot',
  // 压缩包
  'zip', 'tar', 'gz', 'tgz', 'bz2', 'xz', '7z', 'rar', 'jar',
  // 音视频
  'mp3', 'mp4', 'mov', 'avi', 'mkv', 'wav', 'flac', 'ogg', 'webm',
  // 办公文档（均为压缩格式）
  'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx',
  // 编译产物 / 二进制对象
  'exe', 'dll', 'so', 'dylib', 'bin', 'class', 'o', 'obj', 'lib', 'a', 'pdb',
  'sqlite', 'db',
];

/** 内置忽略（总是生效，叠加在仓库配置 ignore 之上）。 */
export const BUILTIN_IGNORE_PATTERNS: readonly string[] = [
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  '**/vendor/**',
  '**/node_modules/**',
  '**/*.min.*',
  '**/*.map',
  '**/__snapshots__/**',
  ...BINARY_AND_IMAGE_EXTENSIONS.map((ext) => `**/*.${ext}`),
];

/** 文件是否被仓库配置忽略（内置忽略 + 配置里的 ignore，任一命中即忽略）。 */
export function isIgnoredByRepoConfig(filePath: string, config: RepoConfig): boolean {
  return isIgnored(filePath, [...BUILTIN_IGNORE_PATTERNS, ...config.ignore]);
}

/** `gh api` 的 404 报错特征：真实 gh 输出 `gh: Not Found`（或带 HTTP 404 字样）。 */
function isNotFoundResponse(stderr: string): boolean {
  return /not found/i.test(stderr) || /HTTP[\/ ]404\b/.test(stderr);
}

/**
 * 从被审仓库默认分支根目录取 `.glm-review.yml` 并解析：
 * - `gh api repos/<repo>/contents/.glm-review.yml` 返回 base64 内容，解码后走 parseRepoConfig；
 * - 404（文件不存在）→ 缺省配置，无错误；
 * - 其他 gh 错误（网络、鉴权……）→ 抛中文异常。
 */
export async function loadRepoConfig(repo: string, deps: RepoConfigDeps): Promise<RepoConfigResult> {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) {
    throw new Error(`仓库标识必须是 "owner/name" 形式，收到 "${repo}"`);
  }
  const result = await deps.exec('gh', ['api', `repos/${repo}/contents/${REPO_CONFIG_FILENAME}`], {
    env: deps.env,
  });
  if (result.code !== 0) {
    if (isNotFoundResponse(result.stderr)) {
      return { config: defaultRepoConfig(), errors: [] };
    }
    throw new Error(
      `读取 ${REPO_CONFIG_FILENAME} 失败（gh 退出码 ${result.code}）：${result.stderr.trim()}`,
    );
  }
  let payload: { content?: unknown; encoding?: unknown };
  try {
    payload = JSON.parse(result.stdout) as { content?: unknown; encoding?: unknown };
  } catch {
    throw new Error(`gh 返回的 ${REPO_CONFIG_FILENAME} 内容不是合法 JSON`);
  }
  if (typeof payload.content !== 'string' || payload.content === '') {
    // 路径存在但不是文件（如目录）时 GitHub 不返回 content，按缺省处理。
    return { config: defaultRepoConfig(), errors: [] };
  }
  if (payload.encoding !== undefined && payload.encoding !== 'base64') {
    throw new Error(`不支持的 ${REPO_CONFIG_FILENAME} 内容编码：${String(payload.encoding)}`);
  }
  // GitHub 返回的 base64 每 60 字符插一个换行，解码前去掉所有空白。
  const text = Buffer.from(payload.content.replace(/\s+/g, ''), 'base64').toString('utf8');
  return parseRepoConfig(text);
}
