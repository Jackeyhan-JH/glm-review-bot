#!/usr/bin/env bash
# glm-review 守护进程管理脚本（#13）：start | stop | status | logs。
#
#   scripts/daemon.sh start [--once] [--dry-run]   后台启动（setsid nohup）
#   scripts/daemon.sh stop                          SIGTERM 并等待退出（最多 90 秒）
#   scripts/daemon.sh status                        查看是否在运行（未运行退出码 3）
#   scripts/daemon.sh logs [N]                      跟踪日志（默认最后 200 行）
#
# 数据目录默认 ~/.local/share/glm-review-bot/，可用 GLM_REVIEW_HOME 覆盖；
# pid 文件 $HOME/daemon.pid，输出日志 $HOME/logs/daemon.out。
set -euo pipefail

HOME_DIR="${GLM_REVIEW_HOME:-$HOME/.local/share/glm-review-bot}"
PID_FILE="$HOME_DIR/daemon.pid"
LOCK_FILE="$HOME_DIR/daemon.lock"
LOG_DIR="$HOME_DIR/logs"
LOG_FILE="$LOG_DIR/daemon.out"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
CLI="$REPO_ROOT/bin/glm-review"

usage() {
  sed -n '2,9p' "$0" | sed 's/^# \{0,1\}//'
}

# 读 pid 文件并确认进程仍活着；输出 pid，未运行返回非零。
running_pid() {
  [ -f "$PID_FILE" ] || return 1
  local pid
  pid="$(cat "$PID_FILE" 2>/dev/null || true)"
  [ -n "$pid" ] || return 1
  kill -0 "$pid" 2>/dev/null || return 1
  echo "$pid"
}

cmd_start() {
  mkdir -p "$LOG_DIR"
  local pid
  if pid="$(running_pid)"; then
    echo "守护进程已在运行（pid $pid），不重复启动。"
    exit 1
  fi
  rm -f "$PID_FILE"
  # 额外看一眼守护进程自己的单实例锁（pid 文件丢失但实例仍活着的兜底）。
  if [ -f "$LOCK_FILE" ]; then
    local lock_pid
    lock_pid="$(tr -dc '0-9' < "$LOCK_FILE" 2>/dev/null || true)"
    if [ -n "$lock_pid" ] && kill -0 "$lock_pid" 2>/dev/null; then
      echo "检测到 daemon.lock 持有者 pid $lock_pid 仍在运行（pid 文件缺失），不重复启动。"
      exit 1
    fi
  fi
  setsid nohup "$CLI" daemon "$@" >> "$LOG_FILE" 2>&1 < /dev/null &
  pid=$!
  echo "$pid" > "$PID_FILE"
  echo "守护进程已启动（pid $pid，日志 $LOG_FILE）。"
}

cmd_stop() {
  local pid
  if ! pid="$(running_pid)"; then
    echo "守护进程未运行。"
    rm -f "$PID_FILE"
    return 0
  fi
  # 只停我们自己启动的进程：确认 cmdline 里是本仓库的 CLI 在跑 daemon。
  if [ -r "/proc/$pid/cmdline" ] && ! tr '\0' ' ' < "/proc/$pid/cmdline" | grep -q "daemon"; then
    echo "pid $pid 不是 glm-review 守护进程，拒绝停止（请手动检查）。" >&2
    exit 1
  fi
  echo "向守护进程 pid $pid 发送 SIGTERM，等待退出（最多 90 秒）…"
  kill -TERM "$pid"
  local i
  for i in $(seq 1 180); do
    if ! kill -0 "$pid" 2>/dev/null; then
      echo "守护进程已退出。"
      rm -f "$PID_FILE"
      return 0
    fi
    sleep 0.5
  done
  echo "守护进程 ${pid} 90 秒内未退出，不再等待（进程仍在后台运行）。" >&2
  exit 1
}

cmd_status() {
  local pid
  if pid="$(running_pid)"; then
    echo "运行中（pid $pid）"
    return 0
  fi
  if [ -f "$LOCK_FILE" ]; then
    local lock_pid
    lock_pid="$(tr -dc '0-9' < "$LOCK_FILE" 2>/dev/null || true)"
    if [ -n "$lock_pid" ] && kill -0 "$lock_pid" 2>/dev/null; then
      echo "未运行（pid 文件缺失，但 daemon.lock 持有者 pid $lock_pid 仍活着）"
      return 3
    fi
  fi
  echo "未运行"
  return 3
}

cmd_logs() {
  local lines="${1:-200}"
  mkdir -p "$LOG_DIR"
  touch "$LOG_FILE"
  echo "—— 跟踪 $LOG_FILE ——"
  tail -n "$lines" -F "$LOG_FILE"
}

case "${1:-}" in
  start) shift; cmd_start "$@" ;;
  stop) cmd_stop ;;
  status) cmd_status ;;
  logs) shift; cmd_logs "${1:-200}" ;;
  -h|--help|help) usage ;;
  *) usage >&2; exit 2 ;;
esac
