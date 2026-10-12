import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DEFAULT_LARGE_MODEL,
  DEFAULT_SMALL_DIFF_LINES,
  DEFAULT_SMALL_MODEL,
  pickModel,
} from '../../src/llm/model.ts';

test('pickModel 边界：300 行 → small，301 行 → large', () => {
  assert.equal(pickModel(300), DEFAULT_SMALL_MODEL);
  assert.equal(pickModel(300), 'glm-5.3-flash');
  assert.equal(pickModel(301), DEFAULT_LARGE_MODEL);
  assert.equal(pickModel(301), 'glm-5.3');
});

test('pickModel 默认模型名：小改动 flash、大改动标准模型', () => {
  assert.equal(pickModel(0), 'glm-5.3-flash');
  assert.equal(pickModel(1_000_000), 'glm-5.3');
});

test('pickModel 自定义模型名覆盖默认值', () => {
  assert.equal(pickModel(10, { small: 'glm-flash-x', large: 'glm-pro-x' }), 'glm-flash-x');
  assert.equal(pickModel(10_000, { small: 'glm-flash-x', large: 'glm-pro-x' }), 'glm-pro-x');
});

test('pickModel 自定义 smallDiffLines 时边界跟着走', () => {
  assert.equal(pickModel(100, { smallDiffLines: 100 }), 'glm-5.3-flash');
  assert.equal(pickModel(101, { smallDiffLines: 100 }), 'glm-5.3');
  assert.equal(pickModel(0, { smallDiffLines: 0 }), 'glm-5.3-flash');
  assert.equal(pickModel(1, { smallDiffLines: 0 }), 'glm-5.3');
});

test('pickModel 只改模型名不影响默认阈值', () => {
  assert.equal(DEFAULT_SMALL_DIFF_LINES, 300);
  assert.equal(pickModel(300, { small: 's' }), 's');
  assert.equal(pickModel(301, { small: 's' }), 'glm-5.3');
});
