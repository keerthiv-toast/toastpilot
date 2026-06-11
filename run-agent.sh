#!/usr/bin/env bash
set -euo pipefail

# Resolve the real script location even when called through a symlink
SOURCE="${BASH_SOURCE[0]}"
while [ -L "$SOURCE" ]; do
  SOURCE="$(readlink "$SOURCE")"
done
SCRIPT_DIR="$(cd "$(dirname "$SOURCE")" && pwd)"
cd "$SCRIPT_DIR"

if [ ! -d "node_modules" ]; then
  echo "▶ Installing dependencies (first run)…"
  npm install
fi

npm run agent
