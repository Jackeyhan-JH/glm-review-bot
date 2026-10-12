/**
 * test/triggers 共用的最小对象工厂：PrInfo / 既有任务摘要 / PR 评论。
 */
import type { PrInfo } from '../../src/lib/types.ts';
import type { PrComment } from '../../src/github/index.ts';
import type { ExistingJobSummary } from '../../src/triggers/decide.ts';

export const REPO = 'Jackeyhan-JH/glm-toolbox';
export const HEAD_SHA = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2';

const BASE_PR: PrInfo = {
  repo: REPO,
  number: 45,
  title: 'feat(pay): 支持多币种分摊',
  author: 'dev-bot',
  url: `https://github.com/${REPO}/pull/45`,
  headSha: HEAD_SHA,
  baseSha: '1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d',
  baseRef: 'main',
  headRef: 'feat/multi-currency',
  isDraft: false,
  labels: [],
  state: 'OPEN',
  updatedAt: '2026-10-12T00:00:00Z',
};

export function makePr(overrides: Partial<PrInfo> = {}): PrInfo {
  return { ...BASE_PR, ...overrides };
}

export function makeExisting(overrides: Partial<ExistingJobSummary> = {}): ExistingJobSummary {
  return { status: 'queued', reason: null, ...overrides };
}

export function makeComment(overrides: Partial<PrComment> = {}): PrComment {
  return {
    id: 1001,
    author: 'Jackeyhan-JH',
    body: '/glm-review',
    createdAt: '2026-10-12T01:00:00Z',
    ...overrides,
  };
}
