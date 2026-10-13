# glm-review-bot

跑在本机（box）上的 GLM 代码审查机器人：白名单仓库一开 PR（或 PR 有新 push），就用本机 **Claude Code（GLM 后端）** 自动审一遍，把发现的问题写成 **PR 行内评论 + 一条总评**。不需要公网入口、不需要 GitHub App。

## 工作原理

```
          ┌──────────────────────── box（本机，无需公网入口）────────────────────────┐
          │                                                                        │
 gh 轮询 ──▶ 触发规则（草稿/标签/作者/标题跳过）──▶ 状态库（入队 / 去重 / 高峰延后）      │
 （白名单仓库的新 PR / 新 head）                        │                              │
                                                      │ 峰后 & 未暂停 & 有并发名额      │
                                                      ▼                              │
              取 PR → 取 diff → 仓库配置过滤 → 分块 → claude -p（GLM，PR head 只读检出）  │
                      → 结构化结果（严重度/文件/行号/建议）校验合并 → 阈值过滤            │
                      → gh api 发一条 COMMENT review（行内评论 + 中文总评）              │
                      → 状态库记 done（同一 commit 绝不重审）+ 用量记账                   │
          └────────────────────────────────────────────────────────────────────────┘
```

要点：

- **只发 `COMMENT` 类型的 review**：不 approve、不 request changes、不自动改代码。
- **同一个 commit 绝不重复审**：以（仓库, PR 号, head SHA）为键去重；状态库丢了也能从 PR 上已有 review 里的隐藏标记恢复判断。
- **GLM 高峰期不调用**：周一至周五北京时间 14:00–18:00（左闭右开）为高峰期，任务排队到峰后自动开审；周末全天非高峰。
- **省额度、守并发**：本机所有 claude 进程总数上限 4，机器人自己默认同时只跑 1 个；额度看门狗创建的暂停文件存在期间不启动新的 claude。
- **安全**：`claude` 只给只读工具（Read / Grep / Glob），在 PR head 的只读检出目录里运行，绝不给 Bash / Edit / Write / WebFetch。

## 安装

前置条件：Node ≥ 24、[GitHub CLI](https://cli.github.com/)（已 `gh auth login`）、本机 Claude Code（GLM 后端）。

```bash
git clone https://github.com/Jackeyhan-JH/glm-review-bot.git
cd glm-review-bot
scripts/install.sh
```

安装脚本会检查环境、`npm ci --omit=dev`、把 `bin/glm-review` 链接到 `~/.local/bin/`、首次运行时生成带注释的默认配置（`~/.config/glm-review-bot/config.yml`）。幂等，可重复运行。

装好后三步上手：

```bash
glm-review config check                        # 校验配置（刚生成的默认值）
glm-review review <owner/repo> <PR号> --dry-run  # 手动预览一次审查（不发送）
scripts/daemon.sh start                        # 启动常驻守护进程，之后全自动
```

日常启停 / 看日志 / 排障见 [docs/operations.md](docs/operations.md)；真实仓库上的完整试跑记录（截图、命中率、用量与复跑指南）见 [docs/demo.md](docs/demo.md)。

## 配置

两层配置：**全局配置**（机器人自己的行为）+ **仓库配置**（每个被审仓库的审查偏好，可选）。

### 全局配置 `~/.config/glm-review-bot/config.yml`

路径可用环境变量 `GLM_REVIEW_CONFIG` 覆盖；数据目录（状态库 / 日志 / 检出缓存）默认 `~/.local/share/glm-review-bot/`，可用 `GLM_REVIEW_HOME` 覆盖。未写的字段用默认值；改完跑 `glm-review config check` 校验。推荐值见 [examples/config.yml](examples/config.yml)。

| 字段 | 类型 / 取值 | 默认值 | 说明 |
|---|---|---|---|
| `repos` | `owner/name` 列表 | `[]`（什么都不审） | 仓库白名单，只有这里的仓库会被轮询与审查 |
| `pollIntervalSec` | 整数 ≥ 30 | `120` | 轮询间隔（秒） |
| `maxConcurrent` | 整数 1–4 | `1` | 机器人自己同时跑的 claude 数 |
| `boxClaudeLimit` | 整数 ≥ 1 | `4` | 本机全部 claude 进程（含开发用的）总数上限，达到就等待 |
| `pauseFile` | 路径 | `/workspace/GLM_PAUSE` | 该文件存在期间不启动新的 claude（额度看门狗在 5 小时额度 > 95% 时创建） |
| `models.small` | 模型名 | `glm-5.3-flash` | 小 diff 用的模型 |
| `models.large` | 模型名 | `glm-5.3` | 大 diff 用的模型 |
| `models.smallDiffLines` | 整数 ≥ 1 | `300` | 过滤后的改动行数 ≤ 此值用 small，否则用 large |
| `claude.bin` | 命令 | `claude` | claude 可执行文件 |
| `claude.effort` | `low` / `medium` / `high` | `high` | 审查用的思考力度 |
| `claude.timeoutSec` | 整数 ≥ 1 | `900` | 单次 claude 调用超时（秒） |
| `claude.maxChunkLines` | 整数 ≥ 1 | `800` | 单次调用最多审多少行 diff |
| `claude.maxChunksPerReview` | 整数 ≥ 1 | `8` | 超过就只审前 N 块并在总评里说明 |
| `retry.maxAttempts` | 整数 ≥ 1 | `3` | 连续失败满 N 次进终态 failed |
| `retry.backoffSec` | 整数数组（每项 ≥ 1） | `[60, 300, 1800]` | 每次失败后的退避间隔（秒） |
| `statusPort` | 整数 1–65535 | `47180` | 状态网页端口（只监听 127.0.0.1） |
| `peak.enabled` | 布尔 | `true` | 高峰期（工作日北京时间 14–18 点）不调用 GLM |

### 仓库配置 `.glm-review.yml`（可选）

放在**被审仓库默认分支**的根目录（不读 PR 分支上的版本，防止 PR 自己关掉审查）。没有这个文件就用默认值。四个仓库的推荐配置见 [examples/repos/](examples/repos/)（只是示例，不提交到那些仓库）。

| 字段 | 取值 | 默认值 | 说明 |
|---|---|---|---|
| `enabled` | 布尔 | `true` | `false` = 该仓库关闭审查（任务记 skipped） |
| `language` | `zh` / `en` | `zh` | 评论语言 |
| `minSeverity` | `blocker` / `major` / `minor` / `nit` | `minor` | 低于此严重度的问题不发（blocker > major > minor > nit） |
| `maxComments` | 整数 ≥ 1 | `20` | 行内评论上限，超出的并入总评 |
| `ignore` | glob 列表 | `[]` | 忽略路径，叠加在内置忽略之上（支持 `**`、`*`、`?`、`{a,b}`） |
| `skipDrafts` | 布尔 | `true` | 草稿 PR 跳过（转正后同一 commit 会重新入队） |
| `skipLabels` | 标签列表 | `['no-review']` | 带任一标签即跳过（比较不区分大小写） |
| `skipAuthors` | 登录名列表 | `[]` | 这些作者的 PR 跳过 |
| `focus` | 字符串 ≤ 500 字 | 无 | 给审查者的额外说明（该仓库最需要关注的点） |

**内置忽略**（总是生效，`ignore` 是在其之上叠加）：`package-lock.json`、`pnpm-lock.yaml`、`yarn.lock`、`**/vendor/**`、`**/node_modules/**`、`**/*.min.*`、`**/*.map`、`**/__snapshots__/**`，以及图片 / 字体 / 压缩包 / 音视频 / 办公文档 / 编译产物等二进制扩展名（`.png`、`.woff2`、`.zip`、`.mp4`、`.pdf`、`.sqlite` 等）。

校验仓库配置文件（本地文件，不需要提交到仓库）：

```console
$ glm-review config check --repo-file examples/repos/glm-toolbox.glm-review.yml
# 全局配置（/home/box/.config/glm-review-bot/config.yml，合并默认值后）
…（合并后的全局配置 YAML，略）…

# 仓库配置（examples/repos/glm-toolbox.glm-review.yml，合并默认值后）
enabled: true
language: zh
minSeverity: minor
maxComments: 20
ignore:
  - docs/screenshots/**
  - tools/zh-convert/data/**
  - tools/*/fixtures/**
  - assets/icons/**
skipDrafts: true
skipLabels:
  - no-review
skipAuthors: []
focus: 每个 tools/<名称>/ 是一个独立小工具（index.mjs 入口、logic.mjs 纯函数、style.css、
…
```

## 命令一览

`glm-review help` 自动列出全部子命令：

```console
$ glm-review help
glm-review — GLM 代码审查机器人

用法：glm-review <子命令> [参数]

子命令：
  config     校验 / 初始化配置文件
  daemon     轮询守护进程：入队、峰后执行、重试、单实例、优雅退出
  help       显示帮助
  llm-smoke  真实调用一次 claude（GLM）做冒烟测试：打印模型、耗时、token 与解析结果
  peak       查看现在是不是 GLM 高峰期、下一次切换何时发生
  review     手动审查一个 PR：完整流水线（去重/高峰/分块/模型审查/发布）
  status     查看机器人状态：队列、最近审查、用量、高峰（--serve 启动本机状态网页）
  usage      用量报表：调用 / token / 折合 prompt 数，5 小时与 7 天窗口
  version    显示版本号

运行 glm-review help <子命令> 查看该子命令的详细用法。
```

以下示例输出均为真实运行截取（时间等会随运行变化）。**示例里的高峰期规则**：llm-smoke / review 这类真实调用 GLM 的命令在高峰期会拒绝运行（退出码 3）或排队到峰后。

### `glm-review review <owner/repo> <PR号>` — 手动审查一个 PR

完整流水线：去重 → 高峰 / 并发闸门 → diff 过滤分块 → 模型审查 → 发布 review。`--dry-run` 只预览不发送、`--force` 跳过去重（终态 failed 的任务重跑必须加它）、`--json` 输出一行 JSON。

不在白名单的仓库直接拒绝（`--force` 也不放行，退出码 2）：

```console
$ glm-review review Jackeyhan-JH/glm-review-bot 16
错误：仓库 Jackeyhan-JH/glm-review-bot 不在白名单内（全局配置 /home/box/.config/glm-review-bot/config.yml 的 repos），--force 也不能放行；请先把仓库加入白名单。
```

对白名单仓库的小 PR 做 `--dry-run`（真实调用 GLM、真实检出，但绝不发送）：

````console
$ glm-review review Jackeyhan-JH/glm-night-shift 114 --dry-run
→ 获取 PR 信息
→ 检查是否已审过
→ 高峰期与并发闸门检查
→ 加载仓库配置（默认分支）
→ 获取并解析 diff
→ 准备只读检出
→ 调用模型审查（第 1/1 块）
→ 组装并发布 review
> 🧪 dry-run 预览：以下内容不会发送到 GitHub。

# 总评（Jackeyhan-JH/glm-night-shift#114）

## 🤖 GLM 代码审查

未发现需要处理的问题 ✅

---

🤖 commit `dc47087` · 模型 `glm-5.3-flash` · 分块 1 · 耗时 1m57s

<!-- glm-review-bot:sha=dc47087c86705276e1c22d1ae0ff7a1934ecc29a -->
---

将要发送的 JSON 载荷：

```json
{
  "commit_id": "dc47087c86705276e1c22d1ae0ff7a1934ecc29a",
  "body": "## 🤖 GLM 代码审查\n\n未发现需要处理的问题 ✅\n\n---\n\n🤖 commit `dc47087` · 模型 `glm-5.3-flash` · 分块 1 · 耗时 1m57s\n\n<!-- glm-review-bot:sha=dc47087c86705276e1c22d1ae0ff7a1934ecc29a -->",
  "event": "COMMENT",
  "comments": []
}
```
dry-run 预览完成（未发送任何内容）：0 条问题，模型 glm-5.3-flash，分块 1，耗时 1 分 57 秒。
````

正常发送时最后一行是 `审查完成：<review 链接>` 加问题数 / 模型 / 耗时；末尾的 HTML 注释就是去重标记，同一 commit 不会再审。

### `glm-review daemon` — 轮询守护进程（常驻）

`--once` 单轮模式（一轮轮询 + 处理完当前可执行的任务后退出，适合 cron 与试探）：

```console
$ glm-review daemon --once
glm-review daemon 启动（--once 单轮模式）。
○ 轮询完成（2860ms）：开放 PR 0，入队 0，跳过 0，被新 commit 取代 0。
```

常驻模式建议用 `scripts/daemon.sh start | stop | status | logs`（见 [docs/operations.md](docs/operations.md)）。退出码：0 正常；4 已有实例在运行；2 参数错误；1 运行异常。

### `glm-review status` — 看机器人在干什么

```console
$ glm-review status
GLM 审查机器人状态
生成时间：北京时间 10月13日 周二 10:58 / 美东 10月12日 周一 22:58（America/New_York）

守护进程：心跳已过期（9 分钟前更新，过期阈值 3 × 120 秒）
  上一轮轮询耗时：2.9 秒
  开放 PR：Jackeyhan-JH/glm-toolbox 0、Jackeyhan-JH/split-bill 0、Jackeyhan-JH/glm-night-shift 0、Jackeyhan-JH/glm-peak-clock 0
GLM 高峰：当前非高峰期；下一次切换（进入高峰）：北京时间 10月13日 周二 14:00 / 美东 10月13日 周二 02:00，还有 3 小时 1 分
额度暂停：未暂停（/workspace/GLM_PAUSE 不存在）

任务统计：排队 1 · 延后 0 · 进行中 0 · 完成 0 · 失败 0 · 跳过 0（共 1）

等待队列（按可执行时间排序）：
  仓库                          PR    状态  可执行时间（北京时间）  还需等待  尝试  原因
  Jackeyhan-JH/glm-night-shift  #114  排队  10月13日 周二 10:56     已可执行  0     —

最近审查：还没有记录

claude 用量：
  今天（北京时间 10月13日 周二）：1 次（成功 1 · 失败 0），输入 25,647 tokens，输出 3,502 tokens
  近 7 天：1 次（成功 1 · 失败 0），输入 25,647 tokens，输出 3,502 tokens
```

（上面是 `--once` 跑完后的快照，所以心跳显示「已过期」；守护进程常驻时心跳每轮刷新。`--json` 输出同内容的机器可读版。）

`--serve` 启动本机状态网页（只监听 127.0.0.1，端口用全局配置 `statusPort`，默认 47180）：

```console
$ glm-review status --serve --port 43160
状态页已启动：http://127.0.0.1:43160/
JSON 接口：http://127.0.0.1:43160/api/status
按 Ctrl+C 退出。
```

### `glm-review usage` — 用量报表

调用 / 成功率 / 耗时 / token / 费用 / 折合 prompt 数，`--by day|repo|model` 分组，附「近 5 小时」「近 7 天」滚动窗口；`--since 7d`（也接受 `24h`、`30m`、ISO 时刻）、`--plan` 选折算套餐（`new` 新版积分套餐 / `v2-glm-5.3` / `v2-glm-5.3-flash`）、`--json` / `--csv` 机器可读输出。数据来自状态库的调用账本（审查流水线写入）。

```console
$ glm-review usage
用量报表（套餐：新版积分套餐，分组：日期）
统计范围：全部记录 ～ 2026-10-13T02:58:46.544Z（当前时刻），共 1 次调用

日期        调用   成功   失败   成功率   平均耗时    总耗时      输入token   输出token   费用($)   折合prompt   高峰调用
2026-10-13   1     1     0     100.0%   1 分 57 秒   1 分 57 秒   25647      3502       0.2682   0.5         0
总计        1     1     0     100.0%   1 分 57 秒   1 分 57 秒   25647      3502       0.2682   0.5         0

近 5 小时（2026-10-12T21:58:46.544Z ～ 2026-10-13T02:58:46.544Z，左闭右开）：1 次调用，成功 1 / 失败 0，折合 0.5 prompt，输入 25647 / 输出 3502 token，费用 $0.2682，高峰 0 次
近 7 天（2026-10-06T02:49:03.994Z ～ 2026-10-13T02:58:46.544Z，左闭右开）：1 次调用，成功 1 / 失败 0，折合 0.5 prompt，输入 25647 / 输出 3502 token，费用 $0.2682，高峰 0 次
```

### `glm-review peak` — 现在是不是高峰期

```console
$ glm-review peak
现在：非高峰期
下一次切换：10月13日 周二 02:00（America/New_York），北京时间 周二 14:00
距离切换：3 小时 11 分

$ glm-review peak --json
{"peak":false,"nextSwitch":"2026-10-13T06:00:00.000Z","msUntilSwitch":11465131}
```

`--now <ISO>` 查任意时刻，`--tz <IANA>` 换展示时区；`--json` 输出与 [glm-peak-clock](https://github.com/Jackeyhan-JH/glm-peak-clock) 的 CLI 完全一致。

### `glm-review config` — 校验 / 初始化配置

```console
$ glm-review config init                 # 已存在则不改动（幂等）
已写入默认全局配置：/home/box/.config/glm-review-bot/config.yml
可用 glm-review config check 查看合并后的结果。

$ glm-review config init                 # 再跑一次
配置文件已存在，未改动：/home/box/.config/glm-review-bot/config.yml

$ glm-review config check                # 校验并打印合并默认值后的 YAML，出错退出码 1
# 全局配置（/home/box/.config/glm-review-bot/config.yml，合并默认值后）
repos:
  - Jackeyhan-JH/glm-toolbox
  - Jackeyhan-JH/split-bill
  - Jackeyhan-JH/glm-night-shift
  - Jackeyhan-JH/glm-peak-clock
pollIntervalSec: 120
…
```

### `glm-review llm-smoke` — 真实调用一次 GLM 冒烟

用固定极小提示词真实调一次 claude（只读工具、JSON 输出），打印模型、耗时、token 与解析结果。高峰期拒绝运行（退出码 3），暂停文件存在期间不启动（退出码 1）。

```console
$ glm-review llm-smoke
冒烟测试：模型 glm-5.3-flash，开始调用 claude…
模型：glm-5.3-flash
耗时：80396ms
token：输入 61 / 输出 158
解析结果：{"ok":true,"message":"你好！冒烟测试通过，一切正常。"}
冒烟测试通过 ✅
```

### `glm-review version`

```console
$ glm-review version
glm-review-bot 0.1.0
```

## 运行规则

1. **高峰期不调用 GLM**：周一至周五北京时间（Asia/Shanghai）14:00–18:00（左闭右开），周末全天非高峰。高峰期发现的新 PR 照常入队（状态 `deferred`，`not_before` = 本段高峰结束时刻），峰后自动开审。规则与 [glm-peak-clock](https://github.com/Jackeyhan-JH/glm-peak-clock) 一致。
2. **并发上限**：本机所有 claude 进程（含开发 bot 用的）总数上限 `boxClaudeLimit`（默认 4）；机器人自己最多同时跑 `maxConcurrent`（默认 1）个。启动前用闸门检查，不满足就等待重试。
3. **额度暂停**：`pauseFile`（默认 `/workspace/GLM_PAUSE`）存在期间不启动新的 claude，任务保持排队。
4. **去重**：以（仓库, PR 号, head SHA）为键，审过（成功或已跳过）就不再审；状态库丢失时，从 PR 上已有 review 里的隐藏标记 `<!-- glm-review-bot:sha=<SHA> -->` 恢复判断。
5. **重试**：失败按 `retry.backoffSec` 退避（默认 60 秒 / 5 分 / 30 分），连续满 `maxAttempts`（默认 3）次进终态 failed；守护进程崩溃重启会把滞留 running 的任务放回队列。
6. **只发 COMMENT**：绝不 approve / request changes / 改代码；行内评论落不到 diff 行上的问题并入总评，GitHub 拒绝行内评论（HTTP 422）时自动降级为只发总评。

## 隐私与安全

- **代码只发给本机配置的 GLM 后端**（claude CLI 的服务端）：不发给任何其他第三方服务，不做云端部署。
- **diff 与仓库内容视为不可信输入**：模型输出只能变成评论文本，不能触发任何其他动作。审查用的 `claude` 只给只读工具（Read / Grep / Glob），运行在 PR head 的只读检出目录里（目录权限 0555，禁止执行 git 钩子与任何构建命令），绝不给 Bash / Edit / Write / WebFetch。
- 检出 / fetch 复用 `gh auth git-credential` 的登录凭证，机器人自己不读写 token。
- 状态页与 JSON 接口只监听 `127.0.0.1`。

## 常见问题

**为什么我的 PR 没被审？**
按顺序检查：① 仓库在全局配置 `repos` 白名单里吗；② 是不是高峰期 / 暂停文件存在 / 并发满（`glm-review status` 一眼看全）；③ PR 是否草稿、带 `no-review` 标签（或 `skipLabels` 里配的）、标题带 `[skip review]` / `[no review]`、作者在 `skipAuthors`；④ 同一 commit 是否已审过（去重）；⑤ 过滤后是否还有可审查的改动（全被忽略规则排除时不发评论）。

**怎么重审？** 在 PR 里单独一行评论 `/glm-review`（重审当前 head，忽略去重；`/glm-review full` 另外忽略行内评论上限），等下一轮轮询生效；或手动 `glm-review review <owner/repo> <PR号> --force`。终态 failed 的任务重跑必须加 `--force`。

**怎么跳过审查？** 标题加 `[skip review]`（中英文方括号均可）、打 `no-review` 标签、保持草稿，或在仓库 `.glm-review.yml` 里配 `skipAuthors` / `enabled: false`。

**怎么看用了多少额度？** `glm-review usage`（按天 / 仓库 / 模型分组，5 小时与 7 天窗口对照 GLM 套餐额度）；`glm-review status` 里有今日摘要。

**状态库能删吗？** 能（`GLM_REVIEW_HOME/state.db`）。删掉后去重靠 PR 上已有 review 的隐藏标记兜底，已发过的 review 不会重发；代价是队列与用量历史清零。详见 [docs/operations.md](docs/operations.md)。

## 开发

```bash
nvm use                 # Node 24（见 .nvmrc）
npm ci                  # 安装依赖
npm run check           # typecheck + test，提 PR 前必须全绿
./bin/glm-review help   # 直接运行 CLI（Node 24 直接运行 .ts 源码，无需编译）
```

TypeScript 由 Node 直接运行（无编译、无 dist），运行依赖仅 `yaml`。目录归属、如何新增子命令、如何写不碰真实 `gh` / `claude` 的测试，见 [CONTRIBUTING.md](CONTRIBUTING.md)；模块关系与状态机见 [docs/architecture.md](docs/architecture.md)；本机运维见 [docs/operations.md](docs/operations.md)；总体设计见 [issue #1](https://github.com/Jackeyhan-JH/glm-review-bot/issues/1)。

## 许可

MIT
