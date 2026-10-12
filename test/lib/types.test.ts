import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SEVERITY_LABEL, SEVERITY_ORDER, type Severity } from '../../src/lib/types.ts';

test('严重度顺序 blocker > major > minor > nit', () => {
  assert.ok(SEVERITY_ORDER.blocker > SEVERITY_ORDER.major);
  assert.ok(SEVERITY_ORDER.major > SEVERITY_ORDER.minor);
  assert.ok(SEVERITY_ORDER.minor > SEVERITY_ORDER.nit);
});

test('严重度中文显示名齐全', () => {
  const severities: Severity[] = ['blocker', 'major', 'minor', 'nit'];
  assert.deepEqual(
    severities.map((s) => SEVERITY_LABEL[s]),
    ['严重', '重要', '一般', '建议'],
  );
});
