#!/usr/bin/env bash
set -euo pipefail

# ─── 路径常量 ─────────────────────────────────────────────────────────────────

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
BRIDGE_DIR="$PROJECT_DIR/bridge"
EXTENSION_DIR="$PROJECT_DIR/extension"
CLI_MAIN="$PROJECT_DIR/cli/main.ts"
LOG_FILE="/tmp/tabworks.log"

PORT="${TABWORKS_PORT:-9527}"
HOST="127.0.0.1"
BRIDGE_URL="http://${HOST}:${PORT}"

# ─── 工具函数 ─────────────────────────────────────────────────────────────────

# 查询 bridge 状态，返回 "ready" / "running" / ""
bridge_status() {
  local resp
  resp="$(curl -sf --connect-timeout 1 "${BRIDGE_URL}/status" 2>/dev/null || true)"
  if echo "$resp" | grep -q '"ok":true'; then
    if echo "$resp" | grep -q '"extensionConnected":true'; then
      echo "ready"
    else
      echo "running"
    fi
  fi
}

# 等待扩展连接，超时返回非零
wait_for_extension() {
  local max="${1:-30}"
  local i=0
  while [ "$i" -lt "$max" ]; do
    [ "$(bridge_status)" = "ready" ] && return 0
    sleep 1
    i=$((i + 1))
  done
  return 1
}

# 打印扩展安装指引
print_extension_guide() {
  echo ""
  echo "扩展未连接，请确认已安装："
  echo "  1. 打开 chrome://extensions"
  echo "  2. 开启右上角「开发者模式」"
  echo "  3. 点击「加载已解压的扩展程序」"
  echo "  4. 选择 $EXTENSION_DIR"
}

# ─── 检查项 ───────────────────────────────────────────────────────────────────

check_bun() {
  if ! command -v bun >/dev/null 2>&1; then
    echo "bun: missing"
    exit 1
  fi
  echo "bun: ok ($(bun --version 2>/dev/null || true))"
}

check_node() {
  if ! command -v node >/dev/null 2>&1; then
    echo "node: missing"
    exit 1
  fi
  local ver major
  ver="$(node --version 2>/dev/null || true)"
  major="$(printf '%s' "$ver" | sed 's/^v//' | cut -d. -f1)"
  if [ -n "$major" ] && [ "$major" -ge 18 ] 2>/dev/null; then
    echo "node: ok ($ver)"
  else
    echo "node: warn (${ver}，建议 18+)"
  fi
}

check_ws() {
  if (cd "$BRIDGE_DIR" && node -e "import('ws').then(()=>process.exit(0)).catch(()=>process.exit(1))") 2>/dev/null; then
    echo "ws: ok"
  else
    echo "ws: missing（在 bridge/ 目录下运行 bun install）"
    exit 1
  fi
}

setup_alias() {
  local rc_file
  case "${SHELL:-}" in
    */fish) rc_file="$HOME/.config/fish/config.fish" ;;
    */zsh)  rc_file="$HOME/.zshrc" ;;
    */bash) [ "$(uname)" = "Darwin" ] && rc_file="$HOME/.bash_profile" || rc_file="$HOME/.bashrc" ;;
    *)      rc_file="$HOME/.bashrc" ;;
  esac

  if grep -q "$CLI_MAIN" "$rc_file" 2>/dev/null; then
    echo "alias: ok ($rc_file)"
    return 0
  fi

  if [[ "${SHELL:-}" == */fish ]]; then
    printf '\n# tabworks\nfunction tw; bun %s $argv; end\nfunction tabworks; bun %s $argv; end\n' \
      "$CLI_MAIN" "$CLI_MAIN" >> "$rc_file"
  else
    printf '\n# tabworks\nalias tw='"'"'bun %s'"'"'\nalias tabworks='"'"'bun %s'"'"'\n' \
      "$CLI_MAIN" "$CLI_MAIN" >> "$rc_file"
  fi

  echo "alias: 已写入 ${rc_file}，请执行: source ${rc_file}"
}

check_bridge() {
  local status
  status="$(bridge_status)"

  if [ "$status" = "ready" ]; then
    echo "bridge: ready (${BRIDGE_URL}，扩展已连接)"
    return 0
  fi

  if [ "$status" = "running" ]; then
    echo "bridge: running，等待扩展连接（最多 30s）..."
  else
    echo "bridge: starting..."
    (cd "$PROJECT_DIR" && bun "$CLI_MAIN" serve) >"$LOG_FILE" 2>&1 &
    echo "bridge: started (pid $!)，等待扩展连接（最多 30s）..."
    # 先等进程启动
    local i=0
    while [ "$i" -lt 5 ]; do
      sleep 1; i=$((i + 1))
      [ -n "$(bridge_status)" ] && break
    done
    if [ -z "$(bridge_status)" ]; then
      echo "bridge: 启动失败，查看日志: $LOG_FILE"
      exit 1
    fi
  fi

  if wait_for_extension 30; then
    echo "bridge: ready (${BRIDGE_URL}，扩展已连接)"
  else
    print_extension_guide
    exit 1
  fi
}

# ─── 主流程 ───────────────────────────────────────────────────────────────────

setup_alias
check_bun
check_node
check_ws
check_bridge
