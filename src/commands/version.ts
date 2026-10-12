/** `glm-review version`：输出 glm-review-bot 与 package.json 的版本号。 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { Command } from '../lib/types.ts';

function readVersion(): string {
  const pkgPath = path.join(import.meta.dirname, '..', '..', 'package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version?: string };
  return pkg.version ?? '0.0.0';
}

export const command: Command = {
  name: 'version',
  summary: '显示版本号',
  usage: 'glm-review version',
  async run(_argv, ctx): Promise<number> {
    ctx.stdout(`glm-review-bot ${readVersion()}\n`);
    return 0;
  },
};
