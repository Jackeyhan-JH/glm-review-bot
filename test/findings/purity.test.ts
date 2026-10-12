/**
 * 纯函数约束（验收标准）：src/findings 是纯函数模块——不调用 exec、不读写
 * 文件（唯一例外：prompt.ts 读取 prompts/ 模板）、不取当前时间、不发网络
 * 请求。静态扫描源码里的相关 import 与调用。
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const SRC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'findings');

/** 全模块禁止的模式。 */
const FORBIDDEN: Array<[string, RegExp]> = [
  ['node:child_process', /from ['"]node:child_process['"]/],
  ['共享 exec（外部命令只允许走注入的 ctx.deps.exec）', /lib\/exec|from ['"]\.\.\/\.\.\/src\/lib\/exec/],
  ['exec/spawn 调用', /(?<![.\w])(exec|execSync|spawn|spawnSync|execFile)\s*\(/],
  ['取当前时间（时间只通过注入的 Clock）', /\b(new Date\s*\(\s*\)|Date\.now\s*\(|performance\.now\s*\()/],
  ['网络请求', /\b(fetch|http\.get|https\.get|net\.connect)\s*\(/],
  ['写文件', /\b(writeFileSync|appendFileSync|writeFile|createWriteStream|openSync\s*\(\s*[^)]*['"]w)\s*\(/],
];

/** 只允许 prompt.ts（读模板）出现的模式。 */
const PROMPT_ONLY: Array<[string, RegExp]> = [
  ['读文件（只有 prompt.ts 允许读模板）', /\b(readFileSync|readFile|createReadStream)\s*\(/],
  ['node:fs 导入', /from ['"]node:fs(\/promises)?['"]/],
  ['node:path / node:url 导入', /from ['"]node:(path|url)['"]/],
];

test('src/findings 下所有源码都是纯函数：无 exec / 时间 / 网络，读文件仅限 prompt.ts 读模板', () => {
  const files = readdirSync(SRC_DIR).filter((name) => name.endsWith('.ts'));
  assert.ok(files.length >= 5, `应至少包含 5 个源文件，实际 ${files.length}`);
  for (const name of files) {
    const source = readFileSync(path.join(SRC_DIR, name), 'utf8');
    for (const [label, pattern] of FORBIDDEN) {
      assert.ok(!pattern.test(source), `${name} 不应包含 ${label}`);
    }
    if (name !== 'prompt.ts') {
      for (const [label, pattern] of PROMPT_ONLY) {
        assert.ok(!pattern.test(source), `${name} 不应包含 ${label}（只有 prompt.ts 可读模板文件）`);
      }
    }
    // import 只允许：本目录、diff 模块（DiffFile / 行号映射）、lib 的共享类型。
    const IMPORT_RE = /^[ \t]*(?:import|export)\b[^;'"]*?from[ \t]+['"]([^'"]+)['"]/gm;
    for (const match of source.matchAll(IMPORT_RE)) {
      const spec = match[1] as string;
      const allowed =
        spec.startsWith('./') ||
        spec.startsWith('../diff/') ||
        spec === '../lib/types.ts' ||
        (name === 'prompt.ts' && /^node:(fs|path|url)$/.test(spec));
      assert.ok(allowed, `${name} 的 import ${spec} 应限于本目录、../diff/ 或 ../lib/types.ts`);
    }
  }
});
