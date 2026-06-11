#!/usr/bin/env bash
# Deprecated: use `npm run demo` instead.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
npm run demo
