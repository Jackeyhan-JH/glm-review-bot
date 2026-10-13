#!/usr/bin/env bash
# glm-review-bot 一键安装脚本（#16）：环境检查 → 安装依赖 → 链接 CLI → 初始化配置。
# 幂等，可重复运行（已存在的链接 / 配置不会被动改动）。
#
#   scripts/install.sh
#
# 做四件事：
#   1. 检查运行环境：Node ≥ 24、gh 已登录（gh auth status）、claude 可用（claude --version）；
#   2. npm ci --omit=dev 安装运行依赖（仅 yaml）；
#   3. 把 bin/glm-review 软链到 ~/.local/bin/glm-review（覆盖旧链接，重复运行无副作用）；
#   4. 全局配置不存在时运行 glm-review config init 生成带注释的默认配置。
#
# 环境变量：GLM_REVIEW_CONFIG 可指定配置文件路径（默认 ~/.config/glm-review-bot/config.yml）。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
CLI="$REPO_ROOT/bin/glm-review"
LINK_DIR="${HOME}/.local/bin"
LINK="$LINK_DIR/glm-review"
CONFIG_FILE="${GLM_REVIEW_CONFIG:-$HOME/.config/glm-review-bot/config.yml}"

fail() {
  echo "✗ $1" >&2
  exit 1
}

info() {
  echo "· $1"
}

# --- 1. 环境检查 ---------------------------------------------------------------

info "检查 Node ≥ 24 …"
if ! command -v node >/dev/null 2>&1; then
  fail "未找到 node（本项目需要 Node ≥ 24，见 .nvmrc；建议先 nvm use）"
fi
node_major="$(node --version | sed -n 's/^v\([0-9][0-9]*\)\..*$/\1/p')"
if [ -z "$node_major" ] || [ "$node_major" -lt 24 ]; then
  fail "node 版本过低（当前 $(node --version)，需要 ≥ 24；建议 nvm use）"
fi
info "  Node $(node --version) ✓"

info "检查 gh 并确认已登录 …"
command -v gh >/dev/null 2>&1 || fail "未找到 gh（请先安装 GitHub CLI）"
if ! gh auth status >/dev/null 2>&1; then
  echo "  gh 未登录，需要先完成登录：" >&2
  echo "    gh auth login" >&2
  fail "gh auth status 未通过"
fi
info "  gh $(gh --version | head -n 1 | sed 's/^gh version /版本 /')，已登录 ✓"

info "检查 claude …"
command -v claude >/dev/null 2>&1 || fail "未找到 claude（请先安装本机 Claude Code，后端为 GLM）"
info "  $(claude --version 2>/dev/null | head -n 1) ✓"

# --- 2. 安装依赖 ---------------------------------------------------------------

info "安装运行依赖（npm ci --omit=dev）…"
(cd "$REPO_ROOT" && npm ci --omit=dev)
info "  依赖安装完成 ✓"

# --- 3. 链接 CLI ---------------------------------------------------------------

info "链接 $LINK → $CLI …"
mkdir -p "$LINK_DIR"
ln -sfn "$CLI" "$LINK"
if ! "$LINK" version >/dev/null 2>&1; then
  fail "链接后运行 glm-review version 失败，请检查上面的报错"
fi
info "  glm-review 已可用：$("$LINK" version) ✓"

case ":$PATH:" in
  *":$LINK_DIR:"*) ;;
  *)
    echo "⚠ $LINK_DIR 不在 PATH 里，请把它加进 shell 配置（如 ~/.profile）后重开终端：" >&2
    echo "    export PATH=\"$LINK_DIR:\$PATH\"" >&2
    ;;
esac

# --- 4. 初始化配置 -------------------------------------------------------------

if [ -f "$CONFIG_FILE" ]; then
  info "全局配置已存在，未改动：$CONFIG_FILE"
else
  info "全局配置不存在，生成默认配置（$CONFIG_FILE）…"
  if ! GLM_REVIEW_CONFIG="$CONFIG_FILE" "$LINK" config init; then
    fail "glm-review config init 失败"
  fi
  echo
  echo "下一步：编辑 $CONFIG_FILE 确认白名单（repos）等配置，"
  echo "然后运行 glm-review config check 校验。参考配置见仓库 examples/config.yml。"
fi

echo
echo "安装完成 ✅  常用命令："
echo "  glm-review help                 查看全部子命令"
echo "  glm-review config check         校验配置"
echo "  scripts/daemon.sh start         启动轮询守护进程（详见 docs/operations.md）"
