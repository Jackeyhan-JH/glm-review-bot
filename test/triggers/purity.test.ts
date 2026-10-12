/**
 * 纯函数约束（验收标准）：src/triggers 不调用 exec、不读写文件、不取当前时间、
 * 不发网络请求——静态扫描源码里的相关 import 与调用。允许的目录外 import 只有
 * 类型（lib/types、config/repo、github 的 PrComment）。
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const SRC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'triggers');

/** 允许的目录外 import（必须是 import type）。 */
const ALLOWED_EXTERNAL = new Set(['../lib/types.ts', '../config/repo.ts', '../github/index.ts', '../github/prs.ts']);

const FORBIDDEN: Array<[string, RegExp]> = [
  ['node:fs / node:fs/promises（读写文件）', /from ['"]node:fs(\/promises)?['"]/],
  ['node:child_process / node:process 的 spawn', /from ['"]node:child_process['"]/],
  ['共享 exec（外部命令只允许走注入的 ctx.deps.exec）', /lib\/exec|from ['"]\.\.\/\.\.\/src\/lib\/exec/],
  ['exec/spawn 调用', /(?<![.\w])(exec|execSync|spawn|spawnSync|execFile)\s*\(/],
  ['文件读写调用', /\b(readFileSync|writeFileSync|readFile|writeFile|createReadStream|openSync)\s*\(/],
  ['取当前时间（时间由调用方以参数传入）', /\b(new Date\s*\(\s*\)|Date\.now\s*\(|performance\.now\s*\()/],
  ['网络请求', /\b(fetch|http\.get|https\.get|net\.connect)\s*\(/],
];

test('src/triggers 下所有源码都是纯函数：无 exec / 文件读写 / 当前时间 / 网络', () => {
  const files = readdirSync(SRC_DIR).filter((name) => name.endsWith('.ts'));
  assert.ok(files.length >= 2, `应至少包含 2 个源文件，实际 ${files.length}`);
  for (const name of files) {
    const source = readFileSync(path.join(SRC_DIR, name), 'utf8');
    for (const [label, pattern] of FORBIDDEN) {
      assert.ok(!pattern.test(source), `${name} 不应包含 ${label}`);
    }
    const IMPORT_RE = /^[ \t]*(?:import|export)\b[^;'"]*?from[ \t]+['"]([^'"]+)['"]/gm;
    for (const match of source.matchAll(IMPORT_RE)) {
      const spec = match[1] as string;
      if (spec.startsWith('./')) continue;
      assert.ok(ALLOWED_EXTERNAL.has(spec), `${name} 的 import ${spec} 超出允许范围`);
      assert.ok(
        /^[ \t]*(?:import|export) type\b/.test(match[0]),
        `${name} 从 ${spec} 只能做类型导入（import type），保证是纯函数`,
      );
    }
  }
});
