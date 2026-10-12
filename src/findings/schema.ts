/**
 * 审查输出的 JSON Schema（#9）：随 `claude --json-schema` 传给模型（#8 的
 * `ClaudeRunInput.jsonSchema`），把输出约束成 `{ summary, findings[] }`。
 *
 * - 严重度枚举与 `src/lib/types.ts` 的 `Severity` 一致（别名的归一化在
 *   validate.ts 里做，schema 只收规范值，让 `--json-schema` 先拦一道）；
 * - 长度上限（title 60 / body 800 字）与提示词要求、validate.ts 的截断一致；
 * - 是纯 JSON 值（可直接 `JSON.stringify` 进 argv），不含任何运行时逻辑。
 */
import { SEVERITY_ENUM } from './types.ts';

/** title 长度上限（字）。 */
export const TITLE_MAX_LENGTH = 60;

/** body 长度上限（字）。 */
export const BODY_MAX_LENGTH = 800;

/** suggestion 长度上限（字）：issue 未规定，防御性截断，避免超长替换代码撑爆评论。 */
export const SUGGESTION_MAX_LENGTH = 2000;

/**
 * 模型审查输出的 JSON Schema（draft 2020-12 子集，只用手写校验支持的关键字）。
 *
 * 故意不带 `$schema` 元键：本机 claude CLI 的 `--json-schema` 校验器不认识
 * 2020-12（draft-07 也不认）的元 schema URI，带上会整次调用被拒绝
 * （「no schema with key or ref」）。元键本身不约束数据，去掉不影响校验语义；
 * 这里导出的就是最终送进 `claude --json-schema` 的形态（见 #31）。
 */
export const REVIEW_JSON_SCHEMA: Record<string, unknown> = {
  title: 'glm-review 审查结果',
  description: '代码审查的结构化输出：整体评价 + 问题列表。没有问题时 findings 为空数组。',
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'findings'],
  properties: {
    summary: {
      type: 'string',
      description: '整体评价，一到两句话；没有问题时说明未发现明显问题',
    },
    findings: {
      type: 'array',
      description: '发现的问题列表；没有问题必须返回空数组',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['severity', 'file', 'line', 'title', 'body'],
        properties: {
          severity: {
            type: 'string',
            enum: SEVERITY_ENUM,
            description: '严重度：blocker（严重）/ major（重要）/ minor（一般）/ nit（建议）',
          },
          file: {
            type: 'string',
            minLength: 1,
            description: '文件路径，与 diff 中「### 文件: 」后给出的路径完全一致',
          },
          line: {
            type: 'integer',
            minimum: 1,
            description: '问题所在的新文件行号，取自 diff 行首标注，不要推算',
          },
          endLine: {
            type: 'integer',
            minimum: 1,
            description: '问题范围最后一行（与 line 同一 hunk 且 ≥ line），单行问题省略',
          },
          title: {
            type: 'string',
            minLength: 1,
            maxLength: TITLE_MAX_LENGTH,
            description: '问题标题：哪里有什么问题',
          },
          body: {
            type: 'string',
            minLength: 1,
            maxLength: BODY_MAX_LENGTH,
            description: '问题说明：原因与影响',
          },
          suggestion: {
            type: 'string',
            description: '建议的替换代码，仅在有明确改法时提供',
          },
        },
      },
    },
  },
};
