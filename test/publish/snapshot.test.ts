/**
 * 快照式测试（#10 验收标准第 1 条）：4 种典型情况的总评与评论正文。
 *
 * 快照文件在 test/publish/__snapshots__/ 下，人工核对后提交；输出有预期变化时
 * 运行 `GLM_REVIEW_UPDATE_SNAPSHOTS=1 npm test` 更新，再人工核对 diff。
 * 用 GLM_REVIEW_UPDATE_SNAPSHOTS=1 生成时本文件会写快照，故所有输入都必须
 * 是确定值（不取当前时间、不带随机性）。
 */
import { test } from 'node:test';
import { buildReview } from '../../src/publish/build.ts';
import { assertSnapshot, finding, makeMeta, makePr, renderForSnapshot } from './helpers.ts';

test('快照：0 个问题（简短总评 + 元信息 + 标记，无行内评论）', () => {
  const review = buildReview({
    pr: makePr(),
    inline: [],
    overflow: [],
    belowThreshold: [],
    meta: makeMeta(),
    lang: 'zh',
  });
  assertSnapshot('zero-findings', renderForSnapshot(review));
});

test('快照：3 个行内 + 2 个溢出（1 条挂不上行、1 条超配额）+ 1 条低于阈值', () => {
  const review = buildReview({
    pr: makePr(),
    inline: [
      finding({ severity: 'blocker', file: 'src/calc.ts', line: 12, title: '除零未防护', body: '除数为 0 时会得到 Infinity，账单金额异常。' }),
      finding({ severity: 'major', file: 'src/parse.ts', line: 18, endLine: 20, title: '解析失败被吞掉', body: 'JSON.parse 抛错后只打了日志，上游拿到 undefined。' }),
      finding({ severity: 'minor', file: 'src/util.ts', line: 5, title: '重复的正则编译', body: '循环里每次都 new RegExp，可以提到外面。' }),
    ],
    overflow: [
      finding({ severity: 'minor', file: 'src/legacy.ts', line: 99, inline: false, title: '旧实现未删除', body: 'shrink 后这段已不在新文件里，行号挂不上。' }),
      finding({ severity: 'nit', file: 'src/late.ts', line: 7, inline: true, title: '日志文案不统一', body: '同一路径里中英文混用。' }),
    ],
    belowThreshold: [finding({ severity: 'nit', file: 'src/style.ts', line: 30, title: '多余的空行' })],
    meta: makeMeta(),
    lang: 'zh',
  });
  assertSnapshot('inline-and-overflow', renderForSnapshot(review));
});

test('快照：含 suggestion（行数一致的用一键替换，不一致的用普通代码块）+ 忽略/截断/配置错误小节', () => {
  const review = buildReview({
    pr: makePr(),
    inline: [
      finding({
        severity: 'major',
        file: 'src/calc.ts',
        line: 12,
        title: '空指针未判断',
        body: 'a 可能为 null，直接取属性会崩溃。',
        suggestion: 'const total = (a ?? {}).total;',
      }),
      finding({
        severity: 'minor',
        file: 'src/parse.ts',
        line: 18,
        endLine: 22,
        title: '建议抽成函数',
        body: '这五行与 parseAmount 重复，抽出来便于测试。',
        suggestion: 'function parseRange(text) {\n  return text.split("-").map(Number);\n}',
      }),
    ],
    overflow: [],
    meta: makeMeta({
      ignoredFiles: [
        { path: 'package-lock.json', reason: '命中忽略规则' },
        { path: 'assets/logo.png', reason: '二进制文件' },
      ],
      truncatedFiles: [{ path: 'src/generated.ts', reason: '块数超过上限（maxChunks=4），仅包含 1/3 段' }],
      configErrors: ['.glm-review.yml: ignore 第 1 项应为字符串，实际是 42'],
    }),
    lang: 'zh',
  });
  assertSnapshot('with-suggestion', renderForSnapshot(review));
});

test('快照：英文模式（language: en）', () => {
  const review = buildReview({
    pr: makePr(),
    inline: [
      finding({
        severity: 'major',
        file: 'src/calc.ts',
        line: 12,
        title: 'Missing null check',
        body: 'a can be null; accessing a.total crashes.',
        suggestion: 'const total = (a ?? {}).total;',
      }),
      finding({ severity: 'nit', file: 'src/util.ts', line: 5, title: 'Inconsistent naming', body: 'Use camelCase here.' }),
    ],
    overflow: [finding({ severity: 'minor', file: 'src/legacy.ts', line: 99, inline: false, title: 'Stale code', body: 'Line no longer exists on the new side.' })],
    belowThreshold: [finding({ severity: 'nit', file: 'src/style.ts', line: 30, title: 'Extra blank line' })],
    meta: makeMeta({ model: 'glm-5.3-flash', chunks: 1, durationMs: 83_000, summary: 'Solid change overall; issues concentrate on error handling.' }),
    lang: 'en',
  });
  assertSnapshot('english', renderForSnapshot(review));
});
