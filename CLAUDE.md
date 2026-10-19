# CLAUDE.md

本文件是本仓库 Claude Code 会话的**常驻规则**，每个会话自动加载，提示词里不再重复这些内容。总体设计、技术约定与路线图以 [issue #1](https://github.com/Jackeyhan-JH/glm-review-bot/issues/1) 为准（绑定约定）；本文只补会话层面的规矩，与 #1 冲突时以 #1 为准。日常开发的目录归属、测试写法等见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 工作方式：同会话多轮

- 开发流程是**每个 issue 一个交互式 Claude Code 会话（tmux），同会话多轮沟通**；被验收打回时续原会话修复。一次性 `claude -p` 仅用于明确的批处理任务（启动时注明 `BATCH=1`）。
- 每轮做完一段就 commit / push，然后停下来汇报（本轮做完什么、下一步是什么），等下一轮指示；不要假设单轮能做完所有事，也不要空转。
- 有实质进展就尽早开 PR（可先 draft），后续轮次持续往里推。

## 严禁读取的内容

以下内容**严禁**读取、打印、`cat`，或以任何形式写进日志、命令输出、提交与 PR：

- `~/.claude/settings.json`
- `~/.cc-switch/` 整个目录
- 任何含 API token / auth / 凭证的配置文件

日志与输出里不得出现 token。

## 规格读取

对本仓库执行 `gh issue view` 必须用 `--json`（Projects-classic 已弃用）：

```bash
gh issue view <N> --repo Jackeyhan-JH/glm-review-bot --json title,body,comments --jq '.title, .body, (.comments[].body)'
```

## 范围与禁区

- 只改当前 issue「允许改动的文件范围」里列出的文件。发现共享代码（`src/lib/**`、`src/cli.ts`、`package.json` 等）有 bug：在 issue 里评论说明，另开小 issue 修，不在功能 PR 里顺手改。
- 不碰其他 `/workspace` 下的 worktree；不合并 PR；不改 issue 标签（`ready` / `in-progress` / `needs-fix` 由统筹管理）。

## 测试

- 提交前 `npm ci && npm run check`（typecheck + test）必须全绿。
- 测试**禁止**真实网络、真实 `gh`、真实 `claude`：一律用 `test/helpers/fakebin.ts` 或依赖注入，详见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 时间约束

- GLM 高峰期（周一至周五北京时间 14:00–18:00，左闭右开）不启动新的真实 GLM 冒烟；真实冒烟只在非高峰时段做。
- 美东 01:45 会话会被中断：尽早 commit / push，不要把未提交的工作留到轮末。

## 提交与 PR

- commit 按逻辑拆分，提交信息中文；分支 `feat/<scope>`（文档类可用 `docs/<scope>`）。
- PR 正文含 `Closes #<issue>`，并逐条对照 issue 的验收标准。
