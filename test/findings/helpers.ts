/**
 * test/findings 的共享辅助：内联 unified diff（形态与 test/diff/fixtures 一致，
 * 用 #7 的 parseDiff 解析，保证行号语义与真实链路相同）+ 原始发现构造器。
 */
import { parseDiff } from '../../src/diff/parse.ts';
import type { DiffFile } from '../../src/diff/types.ts';
import type { NormalizedFinding, Severity } from '../../src/findings/types.ts';

/** 解析内联 diff 文本为 DiffFile[]。 */
export function filesOf(diff: string): DiffFile[] {
  return parseDiff(diff);
}

/**
 * `src/calc.ts`：一删两增交错。新侧行号：keep1=1、added1=2、added2=3、
 * added3=4、keep2=5；旧侧 keep1=1、deleted1=2、deleted2=3、keep2=4。
 */
export const CALC_DIFF = `diff --git a/src/calc.ts b/src/calc.ts
index 111..222 100644
--- a/src/calc.ts
+++ b/src/calc.ts
@@ -1,4 +1,5 @@
 keep1
-deleted1
-deleted2
+added1
+added2
+added3
 keep2
`;

/**
 * `src/shrink.ts`：只删不加。新侧可评论行只有 1；旧侧区间 1..4——
 * 报旧侧（删除行）行号 2/3/4 时需要修正到 1。
 */
export const SHRINK_DIFF = `diff --git a/src/shrink.ts b/src/shrink.ts
index 111..222 100644
--- a/src/shrink.ts
+++ b/src/shrink.ts
@@ -1,4 +1,1 @@
 keep1
-deleted1
-deleted2
-deleted3
`;

/**
 * `grid.txt`：两个相距很远的 hunk。hunk1 新侧 1..4（a=1、b1=2、c=3、d=4），
 * hunk2 新侧 11..14（j=11、b2=12、l=13、m=14），中间 5..10 是不可评论的空档。
 */
export const GRID_DIFF = `diff --git a/grid.txt b/grid.txt
index 111..222 100644
--- a/grid.txt
+++ b/grid.txt
@@ -1,3 +1,4 @@
 a
+b1
 c
 d
@@ -10,3 +11,4 @@
 j
+b2
 l
 m
`;

/** 模型原始输出里的一条发现（字段值可覆盖；省略字段模拟模型偷懒）。 */
export function rawFinding(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    severity: 'major',
    file: 'src/calc.ts',
    line: 2,
    title: '空指针未判断',
    body: 'a 可能为 null，直接取属性会崩溃。',
    ...overrides,
  };
}

/** 归一化后发现（merge 测试用），字段值可覆盖。 */
export function normFinding(overrides: Partial<NormalizedFinding> = {}): NormalizedFinding {
  return {
    severity: 'minor',
    file: 'a.ts',
    line: 1,
    title: '示例标题',
    body: '示例说明。',
    inline: true,
    ...overrides,
  };
}

/** 严重度从高到低，供排序断言复用。 */
export const SEVERITIES_HIGH_TO_LOW: Severity[] = ['blocker', 'major', 'minor', 'nit'];
