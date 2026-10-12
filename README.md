# glm-review-bot

GLM 代码审查机器人：自己的仓库一开 PR（或 PR 有新 push），就在本机用 **Claude Code + GLM** 自动审一遍，把发现的问题写成 **PR 行内评论 + 一条总评**。

> 🚧 开发中。总体设计、技术约定与路线图见 [issue #1](https://github.com/Jackeyhan-JH/glm-review-bot/issues/1)。本仓库由 Grok Bot 团队统筹，「审查·开发」bot 指挥 Claude Code（GLM）编写，「审查·验收」bot 逐条对照验收标准后合并。

## 目标

- **开箱即用于自己的仓库**：`split-bill`、`glm-toolbox`、`glm-night-shift`、`glm-peak-clock` 等加进白名单即可，不需要改这些仓库、不需要公网 webhook。
- **本机运行**：守护进程用 `gh` 轮询白名单仓库的新 PR / 新 push（机器没有公网入口），拉取 diff → 分块 → 调本机的 `claude -p`（GLM；小改动用 Flash，大改动用 glm-5.3）→ 得到结构化结果（严重度、文件、行号、建议）→ 用 `gh` 发 PR review。
- **省额度、守规矩**：同一个 commit 绝不重复审；GLM 高峰期（工作日北京时间 14:00–18:00）不跑，排队到峰后；记录每次调用的模型、耗时与用量；遵守本机 Claude Code 并发上限与额度暂停开关。
- **可配置**：仓库根目录放 `.glm-review.yml` 设置忽略路径、严重度阈值、评论语言（默认中文）等。
- **看得见**：`glm-review status` 命令和本地状态网页，显示队列、最近审查、调用计数和下一次峰谷切换。

## 不做

- 不做 GitHub App / 公网 webhook / 云端部署。
- 不自动改代码、不自动 approve 或 request changes（只发 `COMMENT` 类型的 review）。
- 不把代码发给 GLM 以外的任何服务。

## 计划中的用法（以最终实现为准）

```bash
glm-review review Jackeyhan-JH/glm-toolbox 45   # 立即审一个 PR
glm-review daemon                               # 常驻：轮询白名单仓库并排队审查
glm-review status                               # 队列与最近审查
glm-review usage --since 7d                     # 调用与用量统计
```

## 开发

```bash
nvm use                 # Node 24（见 .nvmrc）
npm ci                  # 安装依赖
npm run check           # typecheck + test，提 PR 前必须全绿
./bin/glm-review help   # 直接运行 CLI（Node 24 直接运行 .ts 源码，无需编译）
```

TypeScript 由 Node 直接运行（无编译、无 dist），只允许可擦除语法；运行依赖仅 `yaml`，其余能力用 Node 内置模块。目录归属、如何新增子命令、如何写不碰真实 `gh` / `claude` 的测试，见 [CONTRIBUTING.md](CONTRIBUTING.md)；总体设计见 [issue #1](https://github.com/Jackeyhan-JH/glm-review-bot/issues/1)。

## 许可

MIT
