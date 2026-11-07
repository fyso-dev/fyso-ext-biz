#!/usr/bin/env bash
set -euo pipefail
node extensions/biz/biz.cjs check >/dev/null
printf 'Fyso Biz MCP: authenticated and context available\n'
