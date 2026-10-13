# 架构

本文面向想读懂或修改本仓库的开发者：模块关系、任务状态机、去重与恢复逻辑。总体设计与技术约定见 [issue #1](https://github.com/Jackeyhan-JH/glm-review-bot/issues/1)；贡献流程见 [CONTRIBUTING.md](../CONTRIBUTING.md)；本机运维见 [operations.md](operations.md)。

## 总览

机器人是跑在 box（无公网入口）上的单进程 Node 24 应用：TypeScript 源码由 Node 直接运行（类型剥离，无编译产物），运行依赖只有 `yaml`，状态用内置 `node:sqlite`，状态页用内置 `node:http`。外部命令（`gh` / `git` / `claude`）只经 `src/lib/exec.ts` 调用，当前时间只经注入的 `Clock` 取——两者都可注入，测试全部用假实现，不碰真实网络。

```
src/cli.ts ──扫描──▶ src/commands/*.ts（每文件一个子命令，help 自动发现）
                        │
    ┌───────────────────┼─────────────────────────────────────────┐
    ▼                   ▼                                         ▼
src/config/  全局配置 + 仓库 .glm-review.yml（加载、深合并默认值、校验）
src/peak/    高峰期规则（工作日北京时间 14–18 点）、下一次切换
src/state/   状态库（jobs 任务队列 / calls 调用账本 / meta 心跳）
src/github/  gh 封装（PR / diff / review / 评论）、错误映射、只读检出缓存
src/diff/    diff 解析、可评论行映射、忽略过滤、分块、渲染
src/llm/     claude 调用器（模型选择、只读工具、结构化输出、闸门、重试）
src/findings/ 审查提示词、输出 JSON Schema、结果校验 / 行号修正 / 去重 / 阈值
src/publish/ review 组装（行内评论 + 中文总评 + 去重标记）、422 降级、dry-run
src/triggers/ 触发规则（草稿 / 标签 / 作者 / 标题跳过）、/glm-review 评论命令
src/pipeline/ 单 PR 审查流水线（#11 的端到端组装）+ 任务领取 / 结算
src/daemon/  轮询守护进程（单实例锁、入队、峰后执行、重试、优雅退出）
src/status/  状态采集 + 终端渲染 + 本机网页（127.0.0.1）
src/usage/   用量报表（调用 / token / 费用 / 折合 prompt、5 小时与 7 天窗口）
```

## 数据流

一次自动审查的完整路径（守护进程常驻时循环执行）：

```
daemon(poller 每 pollIntervalSec 轮询 gh，白名单仓库的开放 PR)
   │ 每个开放 PR：triggers.decide 判定 enqueue / skip / ignore
   ▼
state.enqueue ——▶ jobs 表一行（键：repo + pr + head_sha，唯一约束去重）
   │                     高峰期发现的任务直接 status=deferred，not_before=峰后
   ▼
daemon(worker 循环 claimNext：not_before 到点 & 非高峰 & 闸门通过才领取)
   │                     闸门：暂停文件不存在 → 自身并发未满 → 本机 claude 进程数未满
   ▼
pipeline.reviewPr：
   getPr → 去重（状态库 isReviewed / PR 上 bot 标记）
         → 高峰闸门 / 并发闸门（不过则 defer / 保持排队）
         → loadRepoConfig（被审仓库默认分支的 .glm-review.yml，带缓存）
         → getDiff → parseDiff → filterFiles（内置忽略 + ignore）→ changedLines
         → pickModel（≤ smallDiffLines 用 flash）→ chunkDiff（≤ maxChunkLines/块）
         → ensureCheckout（repos/<owner>/<name>/wt/<sha>/ 只读 worktree）
         → 每块 buildPrompt → llm.runClaude（就地重试，每次调用写 calls 账本）
         → findings.normalizeFindings（行号修正 / 去重 / 阈值）→ mergeChunkReviews
         → publish.buildReview（行内评论落 diff 行，其余并入总评）
         → publishReview（gh api，COMMENT 类型；422 时降级只发总评）
   ▼
state.markDone（review_url / findings_count / model 一并落库）
```

手动路径 `glm-review review <repo> <pr>` 走同一条流水线，只是由命令自己「入队 + 领取 + 结算」（`src/pipeline/claim.ts`）；`--dry-run` 在发布前止步并打印将要发送的载荷。

## 任务状态机

`jobs` 表的 `status` 字段（`src/lib/types.ts` 的 `JobStatus`）：

```
                    ┌──────────────（高峰结束 / not_before 到点）──────────────┐
                    ▼                                                          │
 入队 ──▶ queued ──claimNext──▶ running ──markDone──▶ done（终态）              │
           ▲  │                   │                                            │
           │  │                   ├──markSkipped──▶ skipped（终态）              │
           │  │                   │                  （draft / disabled /       │
           │  │                   │                   label / author / title /  │
           │  │                   │                   superseded / 无可审改动）   │
           │  │                   ├──markFailed────▶ queued（按 backoffSec 退避，  │
           │  │                   │        attempts < maxAttempts）              │
           │  │                   └──markFailed────▶ failed（终态，尝试满上限）    │
           │  │                                                                │
           │  └──defer（高峰 / 暂停）──▶ deferred ───────────────────────────────┘
           │                                    （not_before = 峰后 / 解除时刻）
           └────────────recoverStale（守护进程启动时：running 超时未收尾 → 放回）───┘
```

要点：

- **attempts 在领取时 +1**，`markFailed` 按它判断退避与终态；没真正审查的运行（高峰 / 闸门 / dry-run 预览 / 被新 commit 取代）会退回领取，不占失败次数。
- **supersede**：同一 PR 来了新 head 时，旧 SHA 上尚未开始（queued / deferred）的任务标 `skipped(superseded)`；正在跑的会在收尾时发现 head 变化而取消（不发布）。
- **skipped(draft) 不算已审**：草稿 PR 转正后，同一 commit 会重新入队（decide 的唯一去重例外）。
- **failed 是终态**，手动重跑必须 `--force`（或 PR 里评论 `/glm-review`）。
- **recoverStale**：守护进程崩溃重启时，把 `started_at` 超过阈值仍是 running 的任务放回 queued，已消耗的尝试次数保留。

## 去重与恢复

两层去重，键都是（仓库, PR 号, head SHA）：

1. **状态库**（第一层）：`jobs` 表对 `(repo, pr, head_sha)` 有唯一约束，`enqueue` 冲突不插入；`isReviewed` 查该键是否已有 `done` / `skipped` 记录——审过（含跳过）就不再审。`--force` 与 `/glm-review` 评论命令可显式突破这一层。
2. **PR 上的隐藏标记**（第二层，状态库丢失时兜底）：每条发布的 review 末尾带 HTML 注释 `<!-- glm-review-bot:sha=<SHA> -->`。流水线在审查前用 `gh` 拉取该 PR 已有 review，`findBotMarker` 识别标记——即使 `state.db` 被删，已审过的 commit 也不会重审。模型输出里混入的伪造标记会在发布前剥掉，防止假去重。

因此**状态库可以随时重建**：删掉 `GLM_REVIEW_HOME/state.db` 只损失队列与用量历史，不损失「已审过」判断（见 [operations.md](operations.md) 的重建步骤）。

## 检出缓存与并发闸门

- 检出缓存在 `GLM_REVIEW_HOME/repos/<owner>/<name>/`：`clone.git/` 裸仓缓存（首次 `gh repo clone -- --bare`，之后按 sha fetch）+ `wt/<sha>/` 只读 worktree（`git worktree add --detach`，根目录权限 0555，禁止执行 git 钩子）。同一 sha 复用零命令；超出保留数量的旧 worktree 自动清理。fetch / worktree 用 `-c credential.helper=!gh auth git-credential` 复用 gh 登录凭证，代码不碰 token。
- 每次 `claude` 启动前过三道闸门（`src/llm/gate.ts`）：暂停文件（`/workspace/GLM_PAUSE`）不存在 → 机器人自身并发 < `maxConcurrent` → 本机全部 claude 进程（`pgrep -x claude`）< `boxClaudeLimit`。不满足则任务保持排队，30 秒后重试。
- `claude` 只给只读工具白名单（Read / Grep / Glob），diff 与仓库内容按不可信输入处理：模型输出只能变成评论文本，进入评论前还要经过结构化校验（JSON Schema）、行号修正（落到 diff 可评论行上）、去重与严重度阈值。

## 守护进程

`glm-review daemon`（`src/daemon/`）：

- **单实例**：`GLM_REVIEW_HOME/daemon.lock` 写 pid；锁被活着的进程占用则拒绝启动（退出码 4），进程已死的过期锁自动接管。
- **循环**：轮询（poller，各仓库 `.glm-review.yml` 带缓存）→ 领取执行（worker，含闸门与高峰检查）→ 睡到「下一轮轮询 / 队列最早可执行 / 闸门重试 / 限流恢复」中最早的时刻（上限 pollIntervalSec）。
- **心跳**：每轮把心跳时刻、轮询耗时、各仓库开放 PR 数写进 `meta` 表，`glm-review status` 据此判断守护进程死活（超过 3 个轮询间隔未更新视为过期）。
- **优雅退出**：SIGINT / SIGTERM 停止轮询与领取，等待正在运行的审查最多 `claude.timeoutSec`，超时的任务放回队列后硬退出。
- `--once` 单轮模式：一轮轮询 + 处理完当前可执行任务即退出（cron / 测试用）。
