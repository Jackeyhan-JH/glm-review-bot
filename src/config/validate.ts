/**
 * 配置校验小工具（#3）：把「未知字段 / 类型错 / 取值越界」统一成
 * 带字段路径的中文错误（如 `minSeverity 必须是 blocker/major/minor/nit 之一，收到 "high"`），
 * 以及用户配置与默认值的深合并（对象逐键合并、数组整体替换）。
 */

/** 单个字段的校验规格。 */
export type FieldSpec =
  | { type: 'boolean' }
  | { type: 'string'; minLength?: number; maxLength?: number; enumValues?: readonly string[] }
  | { type: 'integer'; min?: number; max?: number }
  | { type: 'number'; min?: number; max?: number }
  | {
      type: 'array';
      itemType: 'string' | 'integer';
      itemMin?: number;
      itemPattern?: { re: RegExp; message: string };
    }
  | { type: 'object'; fields: Schema };

/** 一层配置的 schema：键 → 字段规格。 */
export type Schema = Record<string, FieldSpec>;

/** 把任意值格式化进错误信息：字符串带引号，容器给出概要。 */
export function formatValue(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return String(value);
  if (Array.isArray(value)) return `数组（${value.length} 项）`;
  if (typeof value === 'object') return '映射（键值对）';
  return String(value);
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 深合并：两侧都是普通对象时逐键递归，否则整体用 override 覆盖
 * （数组因此整体替换，见 #3 验收标准）；override 里为 undefined 的键保持 base。
 */
export function deepMerge<T>(base: T, override: unknown): T {
  if (isPlainObject(base) && isPlainObject(override)) {
    const out: Record<string, unknown> = { ...base };
    for (const [key, value] of Object.entries(override)) {
      out[key] = deepMerge(out[key], value);
    }
    return out as T;
  }
  return (override === undefined ? base : override) as T;
}

function joinPath(parent: string, key: string): string {
  return parent === '' ? key : `${parent}.${key}`;
}

function checkRange(path: string, value: number, spec: { min?: number; max?: number }, errors: string[]): void {
  const { min, max } = spec;
  if (min !== undefined && max !== undefined) {
    if (value < min || value > max) errors.push(`${path} 必须在 ${min}–${max} 之间，收到 ${value}`);
  } else if (min !== undefined) {
    if (value < min) errors.push(`${path} 必须 ≥ ${min}，收到 ${value}`);
  } else if (max !== undefined) {
    if (value > max) errors.push(`${path} 必须 ≤ ${max}，收到 ${value}`);
  }
}

function validateField(path: string, spec: FieldSpec, value: unknown, errors: string[]): void {
  switch (spec.type) {
    case 'boolean':
      if (typeof value !== 'boolean') {
        errors.push(`${path} 必须是布尔值（true/false），收到 ${formatValue(value)}`);
      }
      return;
    case 'string': {
      if (typeof value !== 'string') {
        errors.push(`${path} 必须是字符串，收到 ${formatValue(value)}`);
        return;
      }
      if (spec.minLength !== undefined && value.length < spec.minLength) {
        errors.push(`${path} 不能为空字符串`);
      }
      if (spec.maxLength !== undefined && value.length > spec.maxLength) {
        errors.push(`${path} 长度不能超过 ${spec.maxLength} 字，当前 ${value.length} 字`);
      }
      if (spec.enumValues !== undefined && !spec.enumValues.includes(value)) {
        errors.push(`${path} 必须是 ${spec.enumValues.join('/')} 之一，收到 ${formatValue(value)}`);
      }
      return;
    }
    case 'integer':
    case 'number': {
      if (
        typeof value !== 'number' ||
        !Number.isFinite(value) ||
        (spec.type === 'integer' && !Number.isInteger(value))
      ) {
        errors.push(`${path} 必须是${spec.type === 'integer' ? '整数' : '数字'}，收到 ${formatValue(value)}`);
        return;
      }
      checkRange(path, value, spec, errors);
      return;
    }
    case 'array': {
      if (!Array.isArray(value)) {
        errors.push(`${path} 必须是数组，收到 ${formatValue(value)}`);
        return;
      }
      value.forEach((item, index) => {
        const itemPath = `${path}[${index}]`;
        if (spec.itemType === 'string') {
          if (typeof item !== 'string') {
            errors.push(`${itemPath} 必须是字符串，收到 ${formatValue(item)}`);
            return;
          }
          if (spec.itemPattern !== undefined && !spec.itemPattern.re.test(item)) {
            errors.push(`${itemPath} ${spec.itemPattern.message}，收到 ${formatValue(item)}`);
          }
        } else {
          if (typeof item !== 'number' || !Number.isInteger(item)) {
            errors.push(`${itemPath} 必须是整数，收到 ${formatValue(item)}`);
            return;
          }
          if (spec.itemMin !== undefined && item < spec.itemMin) {
            errors.push(`${itemPath} 必须 ≥ ${spec.itemMin}，收到 ${item}`);
          }
        }
      });
      return;
    }
    case 'object':
      validateObject(value, spec.fields, path, errors);
      return;
  }
}

/**
 * 校验一层配置：不在 schema 里的键报「未知字段」，在 schema 里的键按规格校验。
 * 只报错误（push 进 errors），不抛异常；缺省键跳过（由默认值兜底）。
 * 根路径传空串，错误信息里就是 `字段名.子字段` 形式的路径。
 */
export function validateObject(value: unknown, schema: Schema, path: string, errors: string[]): void {
  if (!isPlainObject(value)) {
    errors.push(`${path === '' ? '根节点' : path} 必须是键值映射，收到 ${formatValue(value)}`);
    return;
  }
  for (const key of Object.keys(value)) {
    if (!(key in schema)) errors.push(`未知字段：${joinPath(path, key)}`);
  }
  for (const [key, spec] of Object.entries(schema)) {
    if (!Object.hasOwn(value, key)) continue;
    validateField(joinPath(path, key), spec, value[key], errors);
  }
}

/**
 * 从 yaml 解析异常里提取行号：优先 YAMLParseError 的 linePos（数字或
 * `{ line, col }` 对象两种形状），其次从消息文本里找 `at line N, column M`
 * 或 `(N:M)`。都取不到则返回 null。
 */
function extractErrorLine(err: unknown): number | null {
  const linePos = (err as { linePos?: unknown } | null)?.linePos;
  const first = Array.isArray(linePos) ? linePos[0] : undefined;
  if (typeof first === 'number') return first;
  if (isPlainObject(first) && typeof first.line === 'number') return first.line;
  const message = err instanceof Error ? err.message : String(err);
  const atLine = /at line (\d+), column \d+/.exec(message);
  if (atLine !== null) return Number(atLine[1]);
  const suffix = /\((\d+):\d+\)\s*$/.exec(message);
  return suffix === null ? null : Number(suffix[1]);
}

/** 把 YAML 解析异常格式化成带标签与行号的中文错误（只保留首行，避免多行刷屏）。 */
export function yamlSyntaxErrorMessage(err: unknown, label: string): string {
  const full = err instanceof Error ? err.message : String(err);
  const message = full.split('\n')[0];
  const line = extractErrorLine(err);
  return line === null
    ? `${label}：YAML 语法错误：${message}`
    : `${label}：YAML 语法错误（第 ${line} 行）：${message}`;
}
