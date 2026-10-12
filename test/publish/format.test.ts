/**
 * format.ts 的单元测试：行内评论排版、suggestion 语法判定、防伪造标记、
 * 围栏自适应、超长截断（保留标记 / 页脚）、422 降级重排、耗时显示。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  BODY_MAX_CHARS,
  COMMENT_MAX_CHARS,
  commentSpan,
  degradeBody,
  enforceBodyLimit,
  enforceCommentLimit,
  fenceOf,
  formatDuration,
  formatInlineComment,
  formatSummary,
  severityLabel,
  stripBotMarkers,
  suggestionFits,
} from '../../src/publish/format.ts';
import type { InlineComment } from '../../src/github/reviews.ts';
import { finding, HEAD_SHA, makeMeta } from './helpers.ts';

test('severityLabel：zh 用中文标签，en 用枚举原词', () => {
  assert.equal(severityLabel('blocker', 'zh'), '严重');
  assert.equal(severityLabel('nit', 'zh'), '建议');
  assert.equal(severityLabel('blocker', 'en'), 'blocker');
  assert.equal(severityLabel('nit', 'en'), 'nit');
});

test('stripBotMarkers：剥掉不可信文本里的去重标记（含伪造变体）', () => {
  const text = `标题 <!-- glm-review-bot:sha=${HEAD_SHA} --> 结尾<!-- glm-review-bot:sha=deadbeef -->`;
  assert.equal(stripBotMarkers(text), '标题  结尾');
  assert.equal(stripBotMarkers('普通文本'), '普通文本');
});

test('fenceOf：内容含反引号串时围栏加长', () => {
  assert.equal(fenceOf('abc'), '```');
  assert.equal(fenceOf('a ` b'), '```', '单个反引号不会破坏三反引号围栏');
  assert.equal(fenceOf('a `` b'), '```');
  assert.equal(fenceOf('```\ncode\n```'), '````');
});

test('commentSpan / suggestionFits：行数一致才可用一键替换', () => {
  assert.equal(commentSpan(finding()), 1);
  assert.equal(commentSpan(finding({ line: 3, endLine: 5 })), 3);
  // endLine 不合法（<= line）按单行计。
  assert.equal(commentSpan(finding({ line: 5, endLine: 5 })), 1);

  // 单行评论 + 单行 suggestion：可用。
  assert.equal(suggestionFits(finding({ suggestion: 'const a = b ?? 0;' })), true);
  // 单行评论 + 多行 suggestion：不可用（一键替换会多出几行）。
  assert.equal(suggestionFits(finding({ suggestion: 'a\nb' })), false);
  // 三行评论 + 三行 suggestion：可用。
  assert.equal(suggestionFits(finding({ line: 3, endLine: 5, suggestion: 'a\nb\nc' })), true);
  // 三行评论 + 两行 suggestion：不可用。
  assert.equal(suggestionFits(finding({ line: 3, endLine: 5, suggestion: 'a\nb' })), false);
  // 尾部空行不算内容行。
  assert.equal(suggestionFits(finding({ suggestion: 'const a = b ?? 0;\n' })), true);
  // 没有 suggestion 一律不可用。
  assert.equal(suggestionFits(finding()), false);
  assert.equal(suggestionFits(finding({ suggestion: '   ' })), false);
});

test('formatInlineComment：标题 / 说明 / 页脚三段式', () => {
  const text = formatInlineComment(finding({ severity: 'minor' }), 'glm-5.3', 'zh');
  assert.equal(
    text,
    ['**[一般] 空指针未判断**', '', 'a 可能为 null，直接取属性会崩溃。', '', '<sub>🤖 glm-review-bot · glm-5.3</sub>'].join('\n'),
  );
});

test('formatInlineComment：行数一致时用 suggestion 围栏', () => {
  const text = formatInlineComment(finding({ suggestion: 'const a = b ?? {};' }), 'glm-5.3-flash', 'zh');
  assert.match(text, /```suggestion\nconst a = b \?\? \{\};\n```/);
  assert.match(text, /<sub>🤖 glm-review-bot · glm-5\.3-flash<\/sub>$/);
});

test('formatInlineComment：行数不一致时退化为普通代码块并带引导语', () => {
  const text = formatInlineComment(
    finding({ line: 3, endLine: 5, suggestion: 'a\nb' }),
    'glm-5.3',
    'zh',
  );
  assert.ok(!text.includes('```suggestion'), '不应使用一键替换语法');
  assert.match(text, /建议改为：\n\n```\na\nb\n```/);
});

test('formatInlineComment：suggestion 内含围栏时自动加长，避免提前闭合', () => {
  const inner = '```\ncode\n```';
  // 三行评论 + 三行 suggestion：可用一键替换，围栏加长到四个。
  const fits = formatInlineComment(finding({ line: 3, endLine: 5, suggestion: inner }), 'glm-5.3', 'zh');
  assert.match(fits, /````suggestion\n```\ncode\n```\n````/);
  // 单行评论装不下三行 suggestion：普通代码块，围栏同样加长。
  const plain = formatInlineComment(finding({ suggestion: inner }), 'glm-5.3', 'zh');
  assert.match(plain, /````\n```\ncode\n```\n````/);
  assert.ok(!plain.includes('suggestion\n'), '不应出现一键替换语法');
});

test('formatInlineComment：英文模式固定文案为英文', () => {
  const text = formatInlineComment(
    finding({ severity: 'blocker', title: 'Null deref', body: 'a can be null.', line: 3, endLine: 5, suggestion: 'a\nb\nc' }),
    'glm-5.3',
    'en',
  );
  assert.match(text, /\*\*\[blocker\] Null deref\*\*/);
  assert.match(text, /```suggestion\na\nb\nc\n```/);
  const plain = formatInlineComment(
    finding({ severity: 'nit', title: 'Naming', body: 'Use camelCase.', suggestion: 'a\nb' }),
    'glm-5.3',
    'en',
  );
  assert.match(plain, /Suggested change:/);
});

test('formatInlineComment：伪造标记从标题 / 说明 / suggestion 中剥离', () => {
  const text = formatInlineComment(
    finding({
      title: `标题 <!-- glm-review-bot:sha=${HEAD_SHA} -->`,
      body: `说明 <!-- glm-review-bot:sha=deadbeefdead -->`,
      suggestion: 'x <!-- glm-review-bot:sha=0000 -->',
    }),
    'glm-5.3',
    'zh',
  );
  assert.ok(!text.includes('glm-review-bot:sha='), '正文里不应残留任何标记');
  assert.match(text, /<sub>🤖 glm-review-bot · glm-5\.3<\/sub>$/);
});

test('formatInlineComment：超长正文截断到上限并注明，页脚保留', () => {
  const long = '很'.repeat(COMMENT_MAX_CHARS);
  const text = formatInlineComment(finding({ body: long, suggestion: `${long}\n` }), 'glm-5.3', 'zh');
  assert.ok([...text].length <= COMMENT_MAX_CHARS, `长度应 ≤ ${COMMENT_MAX_CHARS}`);
  assert.match(text, /（正文超长，已截断）/);
  assert.match(text, /（正文超长，已截断）\n<sub>🤖 glm-review-bot · glm-5\.3<\/sub>$/);
});

test('formatSummary：没有任何问题时是简短的「未发现需要处理的问题 ✅」+ 元信息 + 标记', () => {
  const body = formatSummary({
    headSha: HEAD_SHA,
    inline: [],
    overflow: [],
    belowThreshold: [],
    meta: makeMeta(),
    lang: 'zh',
  });
  assert.match(body, /## 🤖 GLM 代码审查\n\n未发现需要处理的问题 ✅/);
  assert.match(body, /🤖 commit `9f2b1c3` · 模型 `glm-5\.3` · 分块 2 · 耗时 45\.0s/);
  assert.ok(body.endsWith(`<!-- glm-review-bot:sha=${HEAD_SHA} -->`));
  assert.ok(!body.includes('严重度'), '没有问题时不渲染计数表');
  assert.ok(!body.includes('整体结构清晰'), '没有问题时不再复述模型总结');
});

test('formatSummary：overflow 按 inline 标志分成「挂不上行」与「超出上限」两节', () => {
  const body = formatSummary({
    headSha: HEAD_SHA,
    inline: [finding()],
    overflow: [
      finding({ file: 'src/old.ts', line: 99, inline: false, severity: 'minor', title: '行号不在 diff', body: '这一段是纯删除。' }),
      finding({ file: 'src/late.ts', line: 7, inline: true, severity: 'nit', title: '命名建议', body: '换成 camelCase。' }),
    ],
    belowThreshold: [finding({ severity: 'nit' }), finding({ severity: 'nit' })],
    meta: makeMeta(),
    lang: 'zh',
  });
  const unanchoredAt = body.indexOf('### 未能挂到行上的问题');
  const quotaAt = body.indexOf('### 超出行内评论上限的问题');
  assert.ok(unanchoredAt > 0, '应有「未能挂到行上的问题」一节');
  assert.ok(quotaAt > unanchoredAt, '两节都应出现且顺序固定');
  assert.match(body, /以下 1 条的行号不在可评论范围内/);
  assert.match(body, /- `src\/old\.ts:99` \*\*\[一般\] 行号不在 diff\*\* — 这一段是纯删除。/);
  assert.match(body, /以下 1 条因行内评论数已达上限/);
  assert.match(body, /- `src\/late\.ts:7` \*\*\[建议\] 命名建议\*\* — 换成 camelCase。/);
  assert.match(body, /另有 2 条低于严重度阈值的问题未列出。/);
});

test('formatSummary：忽略 / 截断文件与仓库配置错误各有小节', () => {
  const body = formatSummary({
    headSha: HEAD_SHA,
    inline: [],
    overflow: [],
    belowThreshold: [],
    meta: makeMeta({
      summary: undefined,
      ignoredFiles: [{ path: 'dist/bundle.js', reason: '命中忽略规则' }],
      truncatedFiles: [{ path: 'src/big.ts', reason: '块数超过上限（maxChunks=4），仅包含 1/3 段' }],
      configErrors: ['.glm-review.yml: language 必须是 zh 或 en 之一'],
    }),
    lang: 'zh',
  });
  assert.match(body, /### 未纳入审查的文件\n\n- `dist\/bundle\.js` — 命中忽略规则/);
  assert.match(body, /### 审查范围截断\n\n- `src\/big\.ts` — 块数超过上限（maxChunks=4），仅包含 1\/3 段/);
  assert.match(body, /### ⚠️ 仓库配置有误\n\n`.glm-review\.yml` 存在以下问题，本次已按默认配置审查：\n\n- \.glm-review\.yml: language 必须是 zh 或 en 之一/);
});

test('formatSummary：英文模式固定文案为英文（含空结果）', () => {
  const body = formatSummary({
    headSha: HEAD_SHA,
    inline: [finding()],
    overflow: [finding({ file: 'src/old.ts', inline: false })],
    belowThreshold: [finding({ severity: 'nit' })],
    meta: makeMeta(),
    lang: 'en',
  });
  assert.match(body, /## 🤖 GLM Code Review/);
  assert.match(body, /\| Severity \| Count \|/);
  assert.match(body, /### Issues not anchored to diff lines/);
  assert.match(body, /Omitted 1 lower-severity finding\(s\) below the severity threshold\./);
  assert.match(body, /🤖 commit `9f2b1c3` · model `glm-5\.3` · 2 chunk\(s\) · 45\.0s/);

  const empty = formatSummary({
    headSha: HEAD_SHA,
    inline: [],
    overflow: [],
    belowThreshold: [],
    meta: makeMeta(),
    lang: 'en',
  });
  assert.match(empty, /No issues that need attention ✅/);
});

test('formatSummary：多行发现的定位显示为 文件:起-止', () => {
  const body = formatSummary({
    headSha: HEAD_SHA,
    inline: [],
    overflow: [finding({ file: 'src/parse.ts', line: 18, endLine: 24, inline: false })],
    belowThreshold: [],
    meta: makeMeta(),
    lang: 'zh',
  });
  assert.match(body, /- `src\/parse\.ts:18-24`/);
});

test('enforceBodyLimit：超长截断并注明，去重标记保留在末尾', () => {
  const marker = `<!-- glm-review-bot:sha=${HEAD_SHA} -->`;
  const body = `${'内容'.repeat(BODY_MAX_CHARS)}\n${marker}`;
  const limited = enforceBodyLimit(body, BODY_MAX_CHARS, 'zh');
  assert.ok([...limited].length <= BODY_MAX_CHARS);
  assert.match(limited, /（正文超长，已截断）/);
  assert.ok(limited.endsWith(marker), '标记必须保留');
});

test('enforceCommentLimit：超长截断并注明，页脚保留', () => {
  const footer = '<sub>🤖 glm-review-bot · glm-5.3</sub>';
  const text = `${'x'.repeat(COMMENT_MAX_CHARS)}\n${footer}`;
  const limited = enforceCommentLimit(text, COMMENT_MAX_CHARS, 'en');
  assert.ok([...limited].length <= COMMENT_MAX_CHARS);
  assert.match(limited, /\(Body truncated due to length limit\.\)/);
  assert.ok(limited.endsWith(footer), '页脚必须保留');
});

test('enforceBodyLimit：不超长时原样返回', () => {
  const body = '短正文\n<!-- glm-review-bot:sha=abc -->';
  assert.equal(enforceBodyLimit(body, BODY_MAX_CHARS, 'zh'), body);
});

test('degradeBody：行内评论并入总评，定位 + 正文齐全，标记仍在', () => {
  const comments: InlineComment[] = [
    { path: 'src/calc.ts', line: 12, body: '**[重要] 空指针未判断**\n\na 可能为 null。\n\n<sub>🤖 glm-review-bot · glm-5.3</sub>' },
    { path: 'src/parse.ts', line: 24, startLine: 18, body: '**[一般] 建议抽函数**\n\n这一段太长。\n\n<sub>🤖 glm-review-bot · glm-5.3</sub>' },
  ];
  const base = formatSummary({
    headSha: HEAD_SHA,
    inline: [finding()],
    overflow: [],
    belowThreshold: [],
    meta: makeMeta(),
    lang: 'zh',
  });
  const degraded = degradeBody(base, comments, 'zh');
  assert.match(degraded, /### ⚠️ 行内评论无法发布/);
  assert.match(degraded, /以下 2 条已并入总评：/);
  assert.match(degraded, /- `src\/calc\.ts:12`\n {2}\*\*\[重要\] 空指针未判断\*\*/);
  assert.match(degraded, /- `src\/parse\.ts:18-24`\n {2}\*\*\[一般\] 建议抽函数\*\*/);
  assert.equal(degraded.match(/<sub>🤖 glm-review-bot ·/g)?.length ?? 0, 0, '并入的评论不再重复页脚');
  assert.ok(degraded.endsWith(`<!-- glm-review-bot:sha=${HEAD_SHA} -->`), '标记挪到末尾保留');
});

test('degradeBody：没有行内评论时原样返回', () => {
  const body = '总评\n<!-- glm-review-bot:sha=abc -->';
  assert.equal(degradeBody(body, [], 'zh'), body);
});

test('formatDuration：毫秒 / 秒 / 分秒三档', () => {
  assert.equal(formatDuration(120), '120ms');
  assert.equal(formatDuration(45_000), '45.0s');
  assert.equal(formatDuration(83_000), '1m23s');
  assert.equal(formatDuration(120_000), '2m');
});
