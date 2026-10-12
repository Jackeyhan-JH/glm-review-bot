/**
 * 审查提示词（#9）：加载 prompts/ 下的语言模板并填充占位符。
 *
 * 本模块是 findings 里唯一允许读文件的地方（只读 prompts/** 的模板），
 * `buildPrompt` / `truncatePrBody` 本身是纯函数。
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** 模板支持的占位符全集（与 issue #9 约定一致）。 */
export const PROMPT_PLACEHOLDERS = [
  'repo',
  'prTitle',
  'prBody',
  'focus',
  'chunkIndex',
  'chunkTotal',
  'files',
  'diff',
] as const;

/** 占位符名。 */
export type PromptVar = (typeof PROMPT_PLACEHOLDERS)[number];

/** 占位符取值：全部是字符串；允许部分提供（模板里没用到的不必给）。 */
export type PromptVars = Partial<Record<PromptVar, string>>;

/** PR 描述在提示词里的长度上限（字）。 */
export const PR_BODY_MAX_CHARS = 2000;

/** 模板里的占位符形态：`{{name}}`，允许两侧有少量空白。 */
const PLACEHOLDER_RE = /\{\{\s*([A-Za-z][A-Za-z0-9_]*)\s*\}\}/g;

/** prompts/ 目录（仓库根下，与本源文件相对定位；本项目无 dist，路径稳定）。 */
export const PROMPTS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'prompts',
);

/**
 * 读取审查提示词模板：`prompts/review.<language>.md`。
 * 语言来自仓库 `.glm-review.yml` 的 `language`（zh / en）。
 */
export function loadPromptTemplate(language: 'zh' | 'en'): string {
  return readFileSync(path.join(PROMPTS_DIR, `review.${language}.md`), 'utf8');
}

/** 把 PR 描述截断到提示词上限（按字计数，超长时以省略号收尾）。 */
export function truncatePrBody(body: string): string {
  const chars = Array.from(body);
  if (chars.length <= PR_BODY_MAX_CHARS) return body;
  return `${chars.slice(0, PR_BODY_MAX_CHARS).join('')}…`;
}

/**
 * 填充模板占位符：
 * - vars 里出现未知变量名、或值不是字符串 → 抛错（调用方传错了）；
 * - 模板里出现未知占位符 → 抛错（模板写错了）；
 * - 模板里需要的占位符没提供值 → 抛错。
 * 其余字符（包括正则特殊字符）原样保留。
 */
export function buildPrompt(template: string, vars: PromptVars): string {
  const known = PROMPT_PLACEHOLDERS as readonly string[];
  const given = vars as Record<string, unknown>;
  for (const [key, value] of Object.entries(given)) {
    if (!known.includes(key)) {
      throw new Error(`未知的占位符变量 "{{${key}}}"（允许：${known.join('、')}）`);
    }
    if (typeof value !== 'string') {
      throw new Error(`占位符 "{{${key}}}" 的值必须是字符串，收到 ${typeof value}`);
    }
  }
  return template.replace(PLACEHOLDER_RE, (whole, name: string) => {
    if (!known.includes(name)) {
      throw new Error(`模板中出现未知占位符 ${whole}（允许：${known.join('、')}）`);
    }
    const value = given[name];
    if (typeof value !== 'string') {
      throw new Error(`模板需要占位符 "{{${name}}}"，但未提供字符串值`);
    }
    return value;
  });
}
