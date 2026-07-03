#!/usr/bin/env bash
set -euo pipefail

PORT="${TABWORKS_PORT:-9527}"
HOST="127.0.0.1"

resp="$(curl -sf --connect-timeout 2 -X POST \
  "http://${HOST}:${PORT}/shutdown" \
  -H "X-TabWorks-Bridge: 1" 2>/dev/null || true)"

if echo "$resp" | grep -q '"ok":true'; then
  echo "bridge: stopped"
else
  echo "bridge: not running"
fi
