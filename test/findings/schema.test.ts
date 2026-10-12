/**
 * REVIEW_JSON_SCHEMA 的验收标准：是合法 JSON Schema（纯 JSON 值、结构完备），
 * 并用一个手写的极简校验器（只支持本 schema 用到的关键字，不加新依赖）校验
 * 3 个合法样例通过、3 个非法样例被拒。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BODY_MAX_LENGTH, REVIEW_JSON_SCHEMA, TITLE_MAX_LENGTH } from '../../src/findings/schema.ts';
import { SEVERITY_ENUM } from '../../src/findings/types.ts';

/** 类型检查：JSON Schema 的 type 关键字（integer 单列，其余与 JS 对齐）。 */
function matchesType(type: string, value: unknown): boolean {
  switch (type) {
    case 'object':
      return value !== null && typeof value === 'object' && !Array.isArray(value);
    case 'array':
      return Array.isArray(value);
    case 'string':
      return typeof value === 'string';
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value);
    case 'number':
      return typeof value === 'number';
    case 'boolean':
      return typeof value === 'boolean';
    default:
      return true;
  }
}

/** 极简校验器：递归套用 type / enum / required / properties / items 等关键字。 */
function validate(schema: unknown, value: unknown, path: string, errors: string[]): void {
  if (schema === null || typeof schema !== 'object') return;
  const s = schema as Record<string, unknown>;

  if (typeof s.type === 'string' && !matchesType(s.type, value)) {
    errors.push(`${path} 应为 ${s.type}，实际 ${Array.isArray(value) ? 'array' : typeof value}`);
    return;
  }
  if (Array.isArray(s.enum) && !s.enum.includes(value)) {
    errors.push(`${path} 不在枚举 ${JSON.stringify(s.enum)} 内`);
  }
  if (typeof s.minimum === 'number' && typeof value === 'number' && value < s.minimum) {
    errors.push(`${path} 小于 minimum ${s.minimum}`);
  }
  if (typeof s.minLength === 'number' && typeof value === 'string' && Array.from(value).length < s.minLength) {
    errors.push(`${path} 短于 minLength ${s.minLength}`);
  }
  if (typeof s.maxLength === 'number' && typeof value === 'string' && Array.from(value).length > s.maxLength) {
    errors.push(`${path} 长于 maxLength ${s.maxLength}`);
  }

  if (s.type === 'object' && matchesType('object', value)) {
    const obj = value as Record<string, unknown>;
    const props = (s.properties ?? {}) as Record<string, unknown>;
    for (const key of (s.required ?? []) as string[]) {
      if (!(key in obj)) errors.push(`${path} 缺少必填字段 ${key}`);
    }
    if (s.additionalProperties === false) {
      for (const key of Object.keys(obj)) {
        if (!(key in props)) errors.push(`${path} 有多余字段 ${key}`);
      }
    }
    for (const [key, sub] of Object.entries(props)) {
      if (key in obj) validate(sub, obj[key], `${path}.${key}`, errors);
    }
  }

  if (s.type === 'array' && Array.isArray(value) && s.items !== undefined) {
    value.forEach((item, index) => validate(s.items, item, `${path}[${index}]`, errors));
  }
}

/** 返回 schema 对某值的全部错误（空数组 = 通过）。 */
function errorsOf(value: unknown): string[] {
  const errors: string[] = [];
  validate(REVIEW_JSON_SCHEMA, value, '$', errors);
  return errors;
}

test('REVIEW_JSON_SCHEMA 是纯 JSON 值，可序列化往返且结构完备', () => {
  assert.deepEqual(JSON.parse(JSON.stringify(REVIEW_JSON_SCHEMA)), REVIEW_JSON_SCHEMA);

  const schema = REVIEW_JSON_SCHEMA as Record<string, unknown>;
  assert.equal(schema.type, 'object');
  assert.deepEqual(schema.required, ['summary', 'findings']);

  const props = schema.properties as Record<string, Record<string, unknown>>;
  assert.equal(props.summary.type, 'string');

  const findings = props.findings as Record<string, unknown>;
  assert.equal(findings.type, 'array');
  const item = findings.items as Record<string, unknown>;
  assert.deepEqual(item.required, ['severity', 'file', 'line', 'title', 'body']);
  const itemProps = item.properties as Record<string, Record<string, unknown>>;
  assert.deepEqual(itemProps.severity.enum, SEVERITY_ENUM);
  assert.equal(itemProps.line.type, 'integer');
  assert.equal(itemProps.title.maxLength, TITLE_MAX_LENGTH);
  assert.equal(itemProps.body.maxLength, BODY_MAX_LENGTH);
});

test('REVIEW_JSON_SCHEMA 不含 $schema 元键（claude --json-schema 会拒绝元 schema URI）', () => {
  const schema = REVIEW_JSON_SCHEMA as Record<string, unknown>;
  // 顶层不带（#31：本机 claude CLI 的校验器不认识 2020-12 的元 URI，带上整次调用被拒）
  assert.equal('$schema' in schema, false);
  assert.equal(schema.$schema, undefined);
  // 递归也没有：任何层级都不该出现 $schema（防止将来在子 schema 里加回来）
  const collectKeys = (value: unknown, acc: string[] = []): string[] => {
    if (Array.isArray(value)) {
      value.forEach((item) => collectKeys(item, acc));
    } else if (value !== null && typeof value === 'object') {
      for (const [key, sub] of Object.entries(value as Record<string, unknown>)) {
        acc.push(key);
        collectKeys(sub, acc);
      }
    }
    return acc;
  };
  assert.ok(!collectKeys(REVIEW_JSON_SCHEMA).includes('$schema'));
});

test('合法样例通过 REVIEW_JSON_SCHEMA 校验（3 个）', () => {
  const samples: unknown[] = [
    // 没有问题：findings 为空数组
    { summary: '未发现明显问题。', findings: [] },
    // 单条问题：只给必填字段
    {
      summary: '有一处空指针风险。',
      findings: [{ severity: 'major', file: 'src/calc.ts', line: 12, title: '空指针未判断', body: 'a 可能为 null。' }],
    },
    // 多条问题：含可选字段 endLine / suggestion 与全部严重度取值
    {
      summary: '两处问题。',
      findings: [
        { severity: 'blocker', file: 'a.ts', line: 1, endLine: 3, title: '数据覆盖', body: '会覆盖用户数据。', suggestion: 'if (a) { … }' },
        { severity: 'nit', file: 'b.ts', line: 99, title: '命名建议', body: '改成更清晰的名字。' },
      ],
    },
  ];
  for (const sample of samples) {
    assert.deepEqual(errorsOf(sample), [], `应通过校验：${JSON.stringify(sample)}`);
  }
});

test('非法样例被 REVIEW_JSON_SCHEMA 拒绝（3 个以上）', () => {
  const samples: unknown[] = [
    // 缺必填字段 findings
    { summary: '没有 findings 字段' },
    // line 不是整数（模型偶发输出字符串数字，schema 层面必须拒绝）
    { summary: 'x', findings: [{ severity: 'major', file: 'a.ts', line: '12', title: 't', body: 'b' }] },
    // 严重度不在枚举内（别名不收，先让 --json-schema 拦一道）
    { summary: 'x', findings: [{ severity: 'critical', file: 'a.ts', line: 1, title: 't', body: 'b' }] },
    // 根对象出现未定义字段
    { summary: 'x', findings: [], extra: '不应存在' },
    // findings 不是数组
    { summary: 'x', findings: {} },
  ];
  for (const sample of samples) {
    assert.ok(errorsOf(sample).length > 0, `应被拒绝：${JSON.stringify(sample)}`);
  }
});
