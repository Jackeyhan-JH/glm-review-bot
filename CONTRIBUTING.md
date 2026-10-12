# 贡献指南

本项目由 bot 指挥 Claude Code（GLM）开发。总体设计、技术约定与路线图见 [issue #1](https://github.com/Jackeyhan-JH/glm-review-bot/issues/1)；本文只讲日常开发需要知道的事。

## 本地命令

```bash
nvm use                 # Node 24（.nvmrc）
npm ci                  # 安装依赖
npm run check           # typecheck + test，提 PR 前必须全绿
npm run typecheck       # 仅 tsc --noEmit
npm test                # 仅 node --test
./bin/glm-review help   # 直接跑 CLI（无需编译，Node 24 直接运行 .ts 源码）
```

工程约束：ESM（`"type": "module"`）、TypeScript 直接由 Node 运行（无 dist、不编译）。因此只允许可擦除语法——`tsconfig` 开了 `erasableSyntaxOnly`（禁 `enum` / `namespace` / 参数属性）和 `verbatimModuleSyntax`（类型导入必须写 `import type`），相对 import 必须带 `.ts` 后缀。

## 目录归属（并行开发不冲突的关键）

| 目录 | 归属 issue | 说明 |
|---|---|---|
| `src/lib/`、`src/cli.ts`、`bin/`、`package.json` | #2 地基 | 共享代码与工程配置 |
| `src/commands/<name>.ts` | 各自 issue | 每个子命令一个文件，见下 |
| `src/config/` #3、`src/peak/` #4、`src/state/` #5、`src/github/` #6、`src/diff/` #7、`src/llm/` #8、`src/findings/` #9、`src/publish/` #10、`src/pipeline/` #11、`src/triggers/` #12、`src/daemon/` #13、`src/status/` #14、`src/usage/` #15 | 各自 issue | 功能模块 |
| `test/<模块>/` | 与 `src/<模块>/` 同一 issue | 测试与源码同归属 |
| `test/helpers/`、`test/fixtures/common/` | #2 地基 | 共享测试夹具 |
| `docs/`、`examples/`、`scripts/` | #16 | 文档与安装 |

**规则：每个 issue 只能改它「允许改动的文件范围」里列出的文件。** 发现共享代码（`src/lib/**` 等）有 bug：在 issue 里评论说明，另开小 issue 修复，不要在功能 PR 里顺手改。模块需要的新类型在自己目录里定义，不改 `src/lib/types.ts`。

## 如何新增子命令

在 `src/commands/` 下新增一个 `<name>.ts` 文件即可，`src/cli.ts` 启动时会扫描该目录并动态 import，`glm-review help` 自动列出——不需要改任何其他文件：

```ts
// src/commands/example.ts
import type { Command } from '../lib/types.ts';

export const command: Command = {
  name: 'example',                                   // 子命令名（与文件名一致）
  summary: '一句话中文摘要（help 列表用）',
  usage: 'glm-review example [--flag] [参数]',
  async run(argv, ctx) {                             // ctx: { deps, stdout, stderr }
    ctx.stdout('你好\n');
    return 0;                                        // 返回值 = 进程退出码
  },
};
```

要点：

- `ctx.deps` 是唯一的外部世界入口：`exec`（跑 `gh` / `git` / `claude`）、`clock`（当前时间）、`env`、`paths`、`log`——全部可注入，测试用假实现。
- 输出一律走 `ctx.stdout` / `ctx.stderr`（不要直接 `process.stdout.write`），文案中文。
- 参数解析用 `src/lib/args.ts` 的 `parseArgs`。
- 外部命令只通过 `ctx.deps.exec` 调用，不要自己 `spawn`。
- 当前时间只通过 `ctx.deps.clock` 取，不要 `new Date()` / `Date.now()`。

## 如何写测试

- 测试文件放 `test/<模块>/<名字>.test.ts`，用 `node:test` + `node:assert/strict`。
- **禁止真实网络、真实 `gh`、真实 `claude`**：一律用 `test/helpers/fakebin.ts` 或依赖注入。
- 临时目录用 `test/helpers/tmp.ts`（隔离的 `GLM_REVIEW_HOME` / 配置目录，自动清理）；CLI 上下文用 `test/helpers/ctx.ts`（捕获输出、假时钟、空日志器）。
- 公共夹具在 `test/fixtures/common/`；模块自己的夹具放各自 `test/<模块>/fixtures/`。

### fakebin：假 gh / claude / git

```ts
import { createFakeBin } from '../helpers/fakebin.ts';
import { exec } from '../../src/lib/exec.ts';

test('用假 gh 查 PR', async () => {
  const fake = createFakeBin();                        // 临时目录里有 gh / claude / git
  try {
    fake.rule('gh', {
      mode: 'prefix',                                  // 前缀匹配（默认是精确匹配）
      match: ['pr', 'view', '12', '--json'],           // 不含命令名本身
      stdout: '{"number":12}',                         // 命中时输出
      // stderr / code / delayMs 可选
    });

    const r = await exec('gh', ['pr', 'view', '12', '--json', 'number'], { env: fake.env });
    assert.equal(r.code, 0);

    const calls = fake.calls();                        // 读回每次调用的 argv / cwd / stdin
    assert.deepEqual(calls[0]?.argv, ['pr', 'view', '12', '--json', 'number']);
  } finally {
    fake.remove();
  }
});
```

匹配规则：精确匹配 > 更长前缀 > 兜底规则（省略 `match`）；都不命中且无兜底时退出码 1。`delayMs` 可模拟慢命令来测超时。

### 典型测试骨架

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runCli } from '../../src/cli.ts';
import { createTestContext } from '../helpers/ctx.ts';

test('example 子命令', async () => {
  const t = createTestContext();
  try {
    const code = await runCli(['example'], { ctx: t.ctx });
    assert.equal(code, 0);
    assert.match(t.stdout(), /你好/);
  } finally {
    t.cleanup();
  }
});
```

## 流程约定

- 分支 `feat/<scope>`，PR 标题 `feat(<scope>): …`，正文含 `Closes #<issue>`，并按 PR 模板逐条对照验收标准。
- 提交信息中文、按逻辑拆分提交。
- CI（PR 与 main）跑 `npm ci` → `npm run typecheck` → `npm test`，全绿才可验收合并（squash）。
- GLM 高峰期（工作日北京时间 14:00–18:00）不启动新的 Claude Code 会话。
