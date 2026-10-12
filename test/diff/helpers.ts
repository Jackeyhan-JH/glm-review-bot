/**
 * test/diff 的共享辅助：读取本模块夹具（夹具说明见 fixtures/README.md）。
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const FIXTURES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');

/** 读取夹具原文（test/diff/fixtures/<name>.diff）。 */
export function loadFixture(name: string): string {
  return readFileSync(path.join(FIXTURES_DIR, `${name}.diff`), 'utf8');
}
