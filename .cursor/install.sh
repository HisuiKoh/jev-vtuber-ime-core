#!/usr/bin/env bash
# Idempotent Cloud Agent bootstrap for jev-vtuber-ime-core.
# Node 20+ を用意し、依存を入れてビルドする。鍵は環境の Secrets から環境変数で来る (TYPESAFE_API_KEY など)。
set -euo pipefail
cd "$(dirname "$0")/.."

ensure_node() {
  if command -v node >/dev/null 2>&1 && [ "$(node -p 'process.versions.node.split(".")[0]')" -ge 20 ]; then
    return
  fi
  # NodeSource の Node 22 (Ubuntu)
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
  sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq nodejs
}
ensure_node

npm ci --no-audit --no-fund
npm run build
echo "jev-vtuber-ime-core install complete: node $(node --version)"
