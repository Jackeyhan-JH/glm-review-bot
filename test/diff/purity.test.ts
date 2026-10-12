/**
 * 纯函数约束（验收标准）：src/diff 不调用 exec、不读写文件、不取当前时间、
 * 不发网络请求——静态扫描源码里的相关 import 与调用。
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const SRC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'diff');

const FORBIDDEN: Array<[string, RegExp]> = [
  ['node:fs / node:fs/promises（读写文件）', /from ['"]node:fs(\/promises)?['"]/],
  ['node:child_process / node:process 的 spawn', /from ['"]node:child_process['"]/],
  ['共享 exec（外部命令只允许走注入的 ctx.deps.exec）', /lib\/exec|from ['"]\.\.\/\.\.\/src\/lib\/exec/],
  ['exec/spawn 调用', /(?<![.\w])(exec|execSync|spawn|spawnSync|execFile)\s*\(/],
  ['文件读写调用', /\b(readFileSync|writeFileSync|readFile|writeFile|createReadStream|openSync)\s*\(/],
  ['取当前时间（时间只通过注入的 Clock）', /\b(new Date\s*\(\s*\)|Date\.now\s*\(|performance\.now\s*\()/],
  ['网络请求', /\b(fetch|http\.get|https\.get|net\.connect)\s*\(/],
];

test('src/diff 下所有源码都是纯函数：无 exec / 文件读写 / 时间 / 网络', () => {
  const files = readdirSync(SRC_DIR).filter((name) => name.endsWith('.ts'));
  assert.ok(files.length >= 5, `应至少包含 5 个源文件，实际 ${files.length}`);
  for (const name of files) {
    const source = readFileSync(path.join(SRC_DIR, name), 'utf8');
    for (const [label, pattern] of FORBIDDEN) {
      assert.ok(!pattern.test(source), `${name} 不应包含 ${label}`);
    }
    // 只允许相对 import 本目录与类型。
    const IMPORT_RE = /^[ \t]*(?:import|export)\b[^;'"]*?from[ \t]+['"]([^'"]+)['"]/gm;
    for (const match of source.matchAll(IMPORT_RE)) {
      const spec = match[1] as string;
      assert.ok(
        spec.startsWith('./') || spec === '../lib/types.ts',
        `${name} 的 import ${spec} 应限于本目录`,
      );
    }
  }
});
