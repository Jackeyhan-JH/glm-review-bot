/**
 * 假可执行文件夹具：在临时目录生成假的 gh / claude / git 命令（Node 脚本），
 * 按「argv 匹配规则 → stdout / stderr / 退出码 / 延时」应答，并把每次调用
 * （argv、cwd、stdin）追加到 binDir/calls.jsonl。
 *
 * 匹配规则：精确匹配（默认）优先于前缀匹配（mode: 'prefix'），
 * 更长的前缀优先；都不命中时用兜底规则（省略 match）；没有兜底规则就非零失败。
 * 测试时把返回的 env（PATH 已指向 binDir 最前）传给 src/lib/exec.ts。
 */
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

export interface FakeBinRule {
  /** argv 匹配串（不含命令名本身）。mode='prefix' 时按前缀，否则要求完全相等；省略 = 兜底规则。 */
  match?: string[];
  /** 匹配方式，默认精确匹配。 */
  mode?: 'exact' | 'prefix';
  stdout?: string;
  stderr?: string;
  code?: number;
  /** 应答前延时毫秒数，用于测试超时/计时。 */
  delayMs?: number;
}

export interface FakeCall {
  bin: string;
  argv: string[];
  cwd: string;
  stdin: string;
}

export interface FakeBin {
  /** 存放假命令的临时目录。 */
  binDir: string;
  /** 把 binDir 放到 PATH 最前的环境变量。 */
  env: Record<string, string | undefined>;
  /** 追加一条应答规则。 */
  rule(bin: string, def: FakeBinRule): void;
  /** 读回全部调用记录。 */
  calls(): FakeCall[];
  /** 清空调用记录。 */
  resetCalls(): void;
  /** 删除临时目录。 */
  remove(): void;
}

interface StoredRule extends FakeBinRule {
  bin: string;
}

/** 生成到 binDir 的假命令脚本：Extensionless 主入口按 CommonJS 运行。 */
function binScriptSource(binName: string): string {
  return [
    '#!/usr/bin/env node',
    `// 由 test/helpers/fakebin.ts 生成的假 ${binName}，请勿手工编辑。`,
    "'use strict';",
    "const { readFileSync, existsSync, appendFileSync } = require('node:fs');",
    "const { join } = require('node:path');",
    `const binName = ${JSON.stringify(binName)};`,
    'const dir = __dirname;',
    'const args = process.argv.slice(2);',
    'const eq = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);',
    'const starts = (p, full) => p.length <= full.length && p.every((v, i) => v === full[i]);',
    'function pick(rules) {',
    '  let best = null;',
    '  let bestScore = -1;',
    '  for (const rule of rules) {',
    '    if (rule.bin !== binName) continue;',
    '    if (Array.isArray(rule.match)) {',
    "      const exact = rule.mode !== 'prefix';",
    '      const n = rule.match.length;',
    '      if (!exact && !starts(rule.match, args)) continue;',
    '      if (exact && !eq(rule.match, args)) continue;',
    '      const score = exact ? 1000 + n : n;',
    '      if (score > bestScore) { best = rule; bestScore = score; }',
    '    } else if (bestScore < 0) {',
    '      best = rule; bestScore = 0;',
    '    }',
    '  }',
    '  return best;',
    '}',
    'function readStdin(cb) {',
    "  let data = '';",
    '  let done = false;',
    '  const finish = () => { if (!done) { done = true; cb(data); } };',
    "  process.stdin.setEncoding('utf8');",
    "  process.stdin.on('data', (c) => { data += c; });",
    "  process.stdin.on('end', finish);",
    "  process.stdin.on('error', finish);",
    '  setTimeout(finish, 2000).unref();',
    '}',
    'readStdin((stdin) => {',
    '  let rule = null;',
    '  try {',
    "    rule = pick(JSON.parse(readFileSync(join(dir, 'rules.json'), 'utf8')));",
    '  } catch {}',
    '  const record = { bin: binName, argv: args, cwd: process.cwd(), stdin };',
    "  appendFileSync(join(dir, 'calls.jsonl'), JSON.stringify(record) + '\\n');",
    '  const respond = () => {',
    '    if (!rule) {',
    '      process.stderr.write(`fakebin: 未匹配的 ${binName} 调用：${JSON.stringify(args)}\\n`);',
    '      process.exit(1);',
    '    }',
    '    if (rule.stderr) process.stderr.write(rule.stderr);',
    '    if (rule.stdout) process.stdout.write(rule.stdout);',
    '    process.exit(rule.code === undefined ? 0 : rule.code);',
    '  };',
    '  if (rule && rule.delayMs) setTimeout(respond, rule.delayMs);',
    '  else respond();',
    '});',
    '',
  ].join('\n');
}

export function createFakeBin(options: { bins?: string[] } = {}): FakeBin {
  const bins = options.bins ?? ['gh', 'claude', 'git'];
  const binDir = mkdtempSync(path.join(tmpdir(), 'glm-review-fakebin-'));
  const rules: StoredRule[] = [];
  const callsPath = path.join(binDir, 'calls.jsonl');
  const rulesPath = path.join(binDir, 'rules.json');

  for (const bin of bins) {
    const script = path.join(binDir, bin);
    writeFileSync(script, binScriptSource(bin), { mode: 0o755 });
  }
  writeFileSync(rulesPath, '[]');

  return {
    binDir,
    env: { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ''}` },
    rule(bin: string, def: FakeBinRule): void {
      rules.push({ ...def, bin });
      writeFileSync(rulesPath, JSON.stringify(rules));
    },
    calls(): FakeCall[] {
      if (!existsSync(callsPath)) return [];
      return readFileSync(callsPath, 'utf8')
        .split('\n')
        .filter((line) => line.trim() !== '')
        .map((line) => JSON.parse(line) as FakeCall);
    },
    resetCalls(): void {
      writeFileSync(callsPath, '');
    },
    remove(): void {
      rmSync(binDir, { recursive: true, force: true });
    },
  };
}
