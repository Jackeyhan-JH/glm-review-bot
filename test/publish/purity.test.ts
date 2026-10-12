/**
 * 纯函数约束（沿用 findings / triggers 模块的约定）：src/publish 里排版与组装
 * （format.ts / build.ts / types.ts）必须是纯函数——不调 exec、不读写文件、
 * 不取当前时间、不发网络请求；只有 post.ts 允许写 dry-run 预览文件，且外部
 * 命令同样只经注入的 deps（GitHub 交互走 #6）。静态扫描源码里的相关 import
 * 与调用。
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const SRC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'publish');

/** 全模块禁止的模式。 */
const FORBIDDEN: Array<[string, RegExp]> = [
  ['node:child_process', /from ['"]node:child_process['"]/],
  ['共享 exec（外部命令只允许走注入的 deps，GitHub 交互走 #6）', /lib\/exec|from ['"]\.\.\/\.\.\/src\/lib\/exec/],
  ['exec/spawn 调用', /(?<![.\w])(exec|execSync|spawn|spawnSync|execFile)\s*\(/],
  ['取当前时间（时间只通过注入的 Clock）', /\b(new Date\s*\(\s*\)|Date\.now\s*\(|performance\.now\s*\()/],
  ['网络请求', /\b(fetch|http\.get|https\.get|net\.connect)\s*\(/],
];

/** 只允许 post.ts（dry-run 预览落盘）出现的模式。 */
const POST_ONLY: Array<[string, RegExp]> = [
  ['文件读写（只有 post.ts 允许写 dry-run 预览）', /\b(readFileSync|writeFileSync|appendFileSync|readFile|writeFile|createReadStream|createWriteStream)\s*\(/],
  ['node:fs 导入', /from ['"]node:fs(\/promises)?['"]/],
  ['node:path / node:url 导入', /from ['"]node:(path|url)['"]/],
];

test('src/publish 下所有源码：无 exec / 时间 / 网络，文件读写仅限 post.ts 的 dry-run 预览', () => {
  const files = readdirSync(SRC_DIR).filter((name) => name.endsWith('.ts'));
  assert.ok(files.length >= 4, `应至少包含 4 个源文件，实际 ${files.length}`);
  for (const name of files) {
    const source = readFileSync(path.join(SRC_DIR, name), 'utf8');
    for (const [label, pattern] of FORBIDDEN) {
      assert.ok(!pattern.test(source), `${name} 不应包含 ${label}`);
    }
    if (name !== 'post.ts') {
      for (const [label, pattern] of POST_ONLY) {
        assert.ok(!pattern.test(source), `${name} 不应包含 ${label}（只有 post.ts 可写 dry-run 预览文件）`);
      }
    }
    // import 只允许：本目录、findings（NormalizedFinding）、diff（忽略/截断清单）、
    // github（postReview / 标记）、lib 的共享类型。
    const IMPORT_RE = /^[ \t]*(?:import|export)\b[^;'"]*?from[ \t]+['"]([^'"]+)['"]/gm;
    for (const match of source.matchAll(IMPORT_RE)) {
      const spec = match[1] as string;
      const allowed =
        spec.startsWith('./') ||
        spec.startsWith('../findings/') ||
        spec.startsWith('../diff/') ||
        spec.startsWith('../github/') ||
        spec === '../lib/types.ts' ||
        (name === 'post.ts' && /^node:(fs\/promises|path)$/.test(spec));
      assert.ok(allowed, `${name} 的 import ${spec} 应限于本目录、../findings/、../diff/、../github/ 或 ../lib/types.ts`);
    }
  }
});
