/**
 * 极简参数解析：`--k v`、`--k=v`、布尔开关、位置参数。
 * 调用方声明哪些选项取值（strings）、哪些是布尔（booleans），
 * 未声明的选项视为未知选项；`--` 之后的内容一律作为位置参数。
 */

export class ArgError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ArgError';
  }
}

export interface ArgSpec {
  /** 取值的选项名（不含 `--` 前缀）。 */
  strings?: string[];
  /** 布尔开关名（不含 `--` 前缀）。 */
  booleans?: string[];
}

export interface ParsedArgs {
  /** 所有已声明选项的值：布尔为 boolean，取值选项为 string。 */
  values: Record<string, string | boolean>;
  positionals: string[];
}

export function parseArgs(argv: string[], spec: ArgSpec = {}): ParsedArgs {
  const strings = new Set(spec.strings ?? []);
  const booleans = new Set(spec.booleans ?? []);
  const values: Record<string, string | boolean> = {};
  const positionals: string[] = [];
  let i = 0;
  let positionalOnly = false;

  while (i < argv.length) {
    const token = argv[i];
    i += 1;

    if (positionalOnly || !token.startsWith('--') || token === '--') {
      if (token === '--' && !positionalOnly) {
        positionalOnly = true;
        continue;
      }
      positionals.push(token);
      continue;
    }

    const eq = token.indexOf('=');
    const name = eq === -1 ? token.slice(2) : token.slice(2, eq);
    if (name === '') throw new ArgError(`无法识别的参数：${token}`);

    const known = strings.has(name) || booleans.has(name);
    if (!known) throw new ArgError(`未知选项：--${name}`);

    if (eq !== -1) {
      const value = token.slice(eq + 1);
      if (booleans.has(name)) {
        if (value !== 'true' && value !== 'false') {
          throw new ArgError(`选项 --${name} 只能是 true 或 false`);
        }
        values[name] = value === 'true';
      } else {
        values[name] = value;
      }
      continue;
    }

    if (booleans.has(name)) {
      values[name] = true;
      continue;
    }

    const next = argv[i];
    if (next === undefined || next.startsWith('--')) {
      throw new ArgError(`选项 --${name} 缺少取值`);
    }
    values[name] = next;
    i += 1;
  }

  return { values, positionals };
}
