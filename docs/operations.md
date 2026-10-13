# 运维手册（box 本机）

本文面向在 box 上把机器人跑起来的人：安装、启停守护进程、看状态与日志、常见故障排查。架构与状态机见 [architecture.md](architecture.md)；配置字段见 [README](../README.md#配置)。

## 目录与文件

| 路径 | 内容 |
|---|---|
| `~/.config/glm-review-bot/config.yml` | 全局配置（`GLM_REVIEW_CONFIG` 可覆盖路径） |
| `~/.local/share/glm-review-bot/state.db` | 状态库：任务队列、调用账本、心跳（`node:sqlite`） |
| `~/.local/share/glm-review-bot/logs/glm-review.log` | 运行日志（JSON 行：`ts` / `level` / `msg` + 字段） |
| `~/.local/share/glm-review-bot/logs/daemon.out` | 守护进程前台输出（`scripts/daemon.sh start` 重定向到这里） |
| `~/.local/share/glm-review-bot/repos/` | 被审仓库的只读检出缓存（裸仓 + 按 sha 的 worktree） |
| `~/.local/share/glm-review-bot/daemon.lock` | 守护进程单实例锁（内容 = pid） |
| `~/.local/bin/glm-review` | CLI 软链（`scripts/install.sh` 创建） |

## 安装 / 升级

```bash
cd ~/glm-review-bot        # 仓库所在目录
git pull
scripts/install.sh         # 幂等：环境检查 → npm ci --omit=dev → 链接 → 配置（已存在则不动）
```

升级后重启守护进程（见下）。安装脚本首次运行会生成带注释的默认配置，编辑白名单（`repos`）后 `glm-review config check` 校验。推荐配置见仓库 `examples/config.yml` 与 `examples/repos/`。

## 启动 / 停止守护进程

```console
$ scripts/daemon.sh start
守护进程已启动（pid 3738414，日志 /home/box/.local/share/glm-review-bot/logs/daemon.out）。

$ scripts/daemon.sh status
运行中（pid 3738414）

$ scripts/daemon.sh start          # 幂等：已在运行则拒绝（退出码 1）
守护进程已在运行（pid 3738414），不重复启动。

$ scripts/daemon.sh stop
向守护进程 pid 3738414 发送 SIGTERM，等待退出（最多 90 秒）…
守护进程已退出。

$ scripts/daemon.sh status
未运行                                # 退出码 3
```

- `start` 用 `setsid nohup` 后台启动并写 pid 文件；`stop` 发 SIGTERM 优雅退出（在跑的审查最多等 `claude.timeoutSec`，超时的任务放回队列）；`logs [N]` 跟踪 `daemon.out`（默认最后 200 行）。
- 已知边界（跟进中）：SIGTERM 落在两轮之间的睡眠窗口时，进程要等当前 `pollIntervalSec` 睡眠计时器走完才真正退出——`pollIntervalSec` 大于 90 秒（默认 120）时 `stop` 可能先报「90 秒内未退出」，进程稍后自行退出、锁已释放，不影响下一次启动。
- 守护进程自带单实例锁：手动 `glm-review daemon` 与 `daemon.sh start` 同时只活一个，后者拒绝启动（退出码 4）。
- 前台跑一轮试探（不入常驻）：`glm-review daemon --once`——一轮轮询 + 处理完当前可执行任务后退出，适合 cron 或刚装好时验证连通性。
- **高峰期行为**：工作日北京时间 14:00–18:00 期间照常轮询入队，但任务保持 `deferred` 到峰后自动开审（`glm-review peak` 查看下一次切换）。

## 看状态

```bash
glm-review status                    # 终端一览：心跳、队列、最近审查、今日用量
glm-review status --json             # 机器可读快照（脚本 / 监控用）
glm-review status --serve            # 常驻状态网页（127.0.0.1，端口 = 全局配置 statusPort）
glm-review usage                     # 用量报表（--by day|repo|model，--since 7d，--csv）
scripts/daemon.sh logs               # 跟踪守护进程输出
tail -f ~/.local/share/glm-review-bot/logs/glm-review.log   # 运行日志（JSON 行）
```

`glm-review status` 的「守护进程」一行来自心跳：超过 3 个轮询间隔未更新显示「心跳已过期」。状态页只监听 `127.0.0.1`，本机浏览器打开 `http://127.0.0.1:47180/`（端口取 `statusPort` 配置），`/api/status` 是 JSON 接口。

## 排障

### `gh` 未登录 / 凭证失效

症状：轮询日志里出现「gh 未登录」或 `gh auth status` 类错误，守护进程不断重试。处理：

```bash
gh auth status          # 确认状态
gh auth login           # 重新登录后守护进程下一轮自动恢复，无需重启
```

### GitHub API 限流

症状：`daemon.out` 出现「⚠ GitHub API 限流，轮询暂停到 <时刻>」。这是预期行为：守护进程解析限流建议的等待秒数，暂停轮询到该时刻后自动恢复，不需要人工干预。想缓解就把 `pollIntervalSec` 调大（≥ 30）。

### `claude` 调用失败 / 想验证 GLM 连通性

```bash
glm-review llm-smoke             # 真实调用一次 GLM（高峰期拒绝运行，退出码 3）
claude --version                 # CLI 本身可用吗
pgrep -x claude | wc -l          # 本机 claude 进程数（达到 boxClaudeLimit 会排队等待）
ls /workspace/GLM_PAUSE          # 暂停文件存在期间不启动新的 claude（额度看门狗创建）
```

单次审查失败会按 `retry.backoffSec`（默认 60 秒 / 5 分 / 30 分）自动重试，连续满 `retry.maxAttempts`（默认 3）次进终态 `failed`，可在 `glm-review status` 的任务统计里看到。终态 failed 的任务重跑：`glm-review review <owner/repo> <PR号> --force`，或在 PR 里评论 `/glm-review`。

### 任务一直不执行

按 `glm-review status` 的提示顺排：高峰期（`deferred`，等峰后）；暂停文件存在；本机 claude 进程满（`box-busy`）；自身并发满（`self-busy`，等在跑的审查收尾）；退避等待中（`not_before` 未到）。这些都属正常排队，不需要处理。

### 状态库损坏 / 想重置

`state.db` 损坏（打开报错、数据异常）时可以直接重建——**已发过的 review 不会重发**：去重的第二层是 PR 上已有 review 里的隐藏标记 `<!-- glm-review-bot:sha=<SHA> -->`，不依赖状态库。

```bash
scripts/daemon.sh stop
mv ~/.local/share/glm-review-bot/state.db ~/state.db.bak   # 先备份（可选）
scripts/daemon.sh start
```

代价：队列清空（在排队的任务需要重新触发，比如 `/glm-review` 评论）、用量历史清零。检出缓存（`repos/`）不用动，按 sha 复用。

### 检出缓存膨胀

`repos/` 下的只读 worktree 由机器人按「最近使用」自动清理，一般不用管。确认不审某个仓库后（从白名单移除），可整目录删除对应 `repos/<owner>/<name>/`，下次需要时自动重新克隆。

### 卸载

```bash
scripts/daemon.sh stop
rm ~/.local/bin/glm-review
rm -rf ~/.local/share/glm-review-bot        # 数据目录（队列 / 日志 / 检出缓存）
rm -rf ~/.config/glm-review-bot             # 配置
```
