/**
 * `glm-review llm-smoke`（#11）：真实调用一次 claude（GLM）做连通性冒烟。
 *
 * glm-review llm-smoke [--model <模型名>]
 *
 * - 高峰期（工作日北京时间 14:00–18:00，且全局配置 peak.enabled）拒绝运行，退出码 3；
 * - 额度暂停文件存在期间不启动新的 claude（#1 运行规则 3），退出码 1；
 * - 用固定的极小提示词真实调用一次 #8 的 runClaude（只读工具、JSON 输出），
 *   打印模型、耗时、token 与解析出的 JSON；调用失败退出码 1。
 */
import { existsSync } from 'node:fs';
import { loadGlobalConfig } from '../config/global.ts';
import { ArgError, parseArgs } from '../lib/args.ts';
import type { Command } from '../lib/types.ts';
import { isPeak } from '../peak/peak.ts';
import { runClaude } from '../llm/claude.ts';

const USAGE = '用法：glm-review llm-smoke [--model <模型名>]';

/** 冒烟提示词：固定、极小，只要模型回一个 JSON 对象。 */
const SMOKE_PROMPT =
  '这是一次冒烟测试。请只输出一个 JSON 对象（不要输出其他文字、不要用代码块包裹）：' +
  '{"ok": true, "message": "一句中文问候"}';

/**
 * 冒烟输出的 JSON Schema（与提示词约定一致）。注意不带 `$schema` 元键：
 * 本机 claude CLI 的 --json-schema 校验器不认识 2020-12 的元 schema URI，
 * 带上会直接报「no schema with key or ref」拒绝执行。
 */
const SMOKE_SCHEMA: Record<string, unknown> = {
  title: 'glm-review 冒烟测试',
  type: 'object',
  additionalProperties: false,
  required: ['ok', 'message'],
  properties: {
    ok: { type: 'boolean', description: '恒为 true' },
    message: { type: 'string', description: '一句中文问候' },
  },
};

export const command: Command = {
  name: 'llm-smoke',
  summary: '真实调用一次 claude（GLM）做冒烟测试：打印模型、耗时、token 与解析结果',
  usage: USAGE,
  async run(argv, ctx): Promise<number> {
    let parsed: ReturnType<typeof parseArgs>;
    try {
      parsed = parseArgs(argv, { strings: ['model'], booleans: [] });
    } catch (err) {
      if (err instanceof ArgError) {
        ctx.stderr(`错误：${err.message}\n${USAGE}\n`);
        return 2;
      }
      throw err;
    }
    if (parsed.positionals.length > 0) {
      ctx.stderr(`错误：多余的参数：${parsed.positionals[0]}\n${USAGE}\n`);
      return 2;
    }
    const modelRaw = parsed.values.model;
    if (typeof modelRaw === 'string' && modelRaw.trim() === '') {
      ctx.stderr(`错误：--model 不能为空\n${USAGE}\n`);
      return 2;
    }

    const config = loadGlobalConfig(ctx.deps.paths.configFile, { log: ctx.deps.log });
    const now = ctx.deps.clock.now();
    // 模型缺省用小模型（冒烟只要连通性，不必用大模型）。
    const model = typeof modelRaw === 'string' ? modelRaw.trim() : config.models.small;

    // 高峰期不运行真实调用（退出码 3，与 issue #11 约定一致）。
    if (config.peak.enabled && isPeak(now)) {
      ctx.stderr('当前处于 GLM 高峰期（工作日北京时间 14:00–18:00），冒烟测试不运行，请峰后再试。\n');
      return 3;
    }
    // 额度暂停文件存在期间不启动新的 claude（#1 运行规则 3）。
    if (existsSync(config.pauseFile)) {
      ctx.stderr(`额度暂停文件存在（${config.pauseFile}），不启动 claude，冒烟测试退出。\n`);
      return 1;
    }

    ctx.stdout(`冒烟测试：模型 ${model}，开始调用 claude…\n`);
    const result = await runClaude(
      {
        prompt: SMOKE_PROMPT,
        cwd: process.cwd(),
        model,
        jsonSchema: SMOKE_SCHEMA,
        timeoutMs: config.claude.timeoutSec * 1000,
      },
      { exec: ctx.deps.exec, env: ctx.deps.env },
    );

    if (!result.ok) {
      ctx.stderr(`冒烟测试失败：${result.error ?? 'claude 调用失败'}\n`);
      return 1;
    }
    const usage = result.usage;
    const tokens =
      usage === undefined
        ? '未知（claude 未上报）'
        : `输入 ${usage.inputTokens ?? '？'} / 输出 ${usage.outputTokens ?? '？'}`;
    ctx.stdout(
      [
        `模型：${model}`,
        `耗时：${result.durationMs}ms`,
        `token：${tokens}`,
        `解析结果：${JSON.stringify(result.output)}`,
        '冒烟测试通过 ✅',
      ]
        .map((line) => `${line}\n`)
        .join(''),
    );
    return 0;
  },
};
