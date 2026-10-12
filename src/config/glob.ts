/**
 * 零依赖 glob 匹配（#3）：支持 `**`、`*`、`?`、`{a,b}`，供仓库配置的忽略路径使用。
 *
 * 语义（路径一律按 `/` 分隔）：
 * - 模式含 `/`：对整条路径锚定匹配——`dist/**` 命中 `dist/a/b.js`，不命中 `src/dist.js`；
 * - 模式不含 `/`：对路径的任意一段匹配（类似 .gitignore）——`package-lock.json`
 *   也命中子目录里的同名文件；
 * - `**` 单独成段时跨越任意层目录：`a/**` 命中 `a` 及其全部子孙，开头的 `**`
 *   段后接 `x`（写作 `**` + `/x`）命中 `x` 与 `a/b/x`；
 * - `*` 与 `?` 只在一段之内匹配，不跨越 `/`；
 * - `{a,b}` 展开为多个模式取并集（花括号前加 `\` 可转义为字面量，但不常用）。
 */

const REGEX_SPECIAL = /[.*+?^${}()|[\]\\]/g;
/** 展开花括号后最多保留的模式条数，防止病态模式（如嵌套大组合）撑爆内存。 */
const MAX_BRACE_EXPANSION = 64;
const REGEX_CACHE_LIMIT = 256;

function escapeRegex(text: string): string {
  return text.replace(REGEX_SPECIAL, '\\$&');
}

/** 统一路径分隔符并去掉开头的 `./`，模式与被匹配路径都先过这一步。 */
export function normalizeGlobPath(p: string): string {
  let s = p.replace(/\\/g, '/');
  while (s.startsWith('./')) s = s.slice(2);
  return s;
}

/** 单段（不含 `/`）转正则片段：`*`→`[^/]*`、`?`→`[^/]`、其余字符转义。 */
function segmentToRegex(segment: string): string {
  let out = '';
  for (const ch of segment) {
    if (ch === '*') out += '[^/]*';
    else if (ch === '?') out += '[^/]';
    else out += escapeRegex(ch);
  }
  return out;
}

/** 在「顶层」按逗号切分（忽略更深层花括号里的逗号）。 */
function splitTopLevel(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const ch of text) {
    if (ch === '{') {
      depth += 1;
      current += ch;
    } else if (ch === '}') {
      depth -= 1;
      current += ch;
    } else if (ch === ',' && depth === 0) {
      parts.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  parts.push(current);
  return parts;
}

/** 展开 `{a,b}` 花括号（含嵌套，返回所有组合）；没有花括号时原样返回。 */
export function expandBraces(pattern: string): string[] {
  const open = pattern.indexOf('{');
  if (open === -1) return [pattern];
  let depth = 0;
  let close = -1;
  for (let i = open; i < pattern.length; i += 1) {
    const ch = pattern[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        close = i;
        break;
      }
    }
  }
  if (close === -1) return [pattern]; // 未闭合的花括号按字面量处理
  const head = pattern.slice(0, open);
  const tail = pattern.slice(close + 1);
  const out: string[] = [];
  for (const alt of splitTopLevel(pattern.slice(open + 1, close))) {
    for (const rest of expandBraces(head + alt + tail)) {
      if (out.length >= MAX_BRACE_EXPANSION) return out;
      if (!out.includes(rest)) out.push(rest);
    }
  }
  return out;
}

/** 单条（已展开花括号、含 `/`）模式 → 不带锚点的正则片段。 */
function anchoredSource(pattern: string): string {
  const segments = pattern.split('/');
  const parts: string[] = [];
  // 开头的 `**/` 自带分隔符，其后第一段不需要再补 `/`。
  let skipSeparator = false;
  for (let i = 0; i < segments.length; i += 1) {
    const seg = segments[i];
    const isLast = i === segments.length - 1;
    if (seg === '**') {
      if (i === 0 && !isLast) {
        parts.push('(?:[^/]+/)*'); // `**/x`：命中 x、a/x、a/b/x
        skipSeparator = true;
      } else if (isLast && i > 0) {
        parts.push('(?:/.*)?'); // `a/**`：命中 a 及其全部子孙
      } else if (isLast) {
        parts.push('.*'); // 整条模式就是 `**`
      } else {
        parts.push('(?:/[^/]+)*'); // `a/**/b`：命中 a/b、a/x/b、a/x/y/b
      }
      continue;
    }
    if (i > 0 && !skipSeparator) parts.push('/');
    skipSeparator = false;
    parts.push(segmentToRegex(seg));
  }
  return parts.join('');
}

/** 单条（已展开花括号）模式 → 不带锚点的正则片段；不含 `/` 的模式按任意一段匹配。 */
function singlePatternSource(pattern: string): string {
  if (pattern === '**') return '.*';
  if (!pattern.includes('/')) {
    // 类 .gitignore：`package-lock.json` 也命中 `sub/dir/package-lock.json`。
    return `(?:[^/]+/)*${segmentToRegex(pattern)}(?:/.*)?`;
  }
  return anchoredSource(pattern);
}

/** 永不匹配的正则（空模式等病态输入用）。 */
const NEVER_MATCH = /^(?!)$/;

const regexCache = new Map<string, RegExp>();

/** 把 glob 模式编译成整条路径锚定的正则（带结果缓存）。 */
export function globToRegExp(pattern: string): RegExp {
  const cached = regexCache.get(pattern);
  if (cached !== undefined) return cached;
  const expanded = expandBraces(normalizeGlobPath(pattern)).filter((p) => p !== '');
  const regex =
    expanded.length === 0
      ? NEVER_MATCH
      : new RegExp(`^(?:${expanded.map((p) => singlePatternSource(p)).join('|')})$`);
  if (regexCache.size >= REGEX_CACHE_LIMIT) regexCache.clear();
  regexCache.set(pattern, regex);
  return regex;
}

/** 路径是否命中任一模式（空模式列表或全空模式时返回 false）。 */
export function isIgnored(filePath: string, patterns: readonly string[]): boolean {
  if (patterns.length === 0) return false;
  const normalized = normalizeGlobPath(filePath);
  if (normalized === '') return false;
  return patterns.some((pattern) => globToRegExp(pattern).test(normalized));
}
