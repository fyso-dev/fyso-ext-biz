#!/usr/bin/env bash
set -euo pipefail
if [ -n "${FYSO_PUBLICATION_SERVICE:-}" ]; then
  node extensions/biz/publication.cjs doctor
fi
status=$(node extensions/biz/biz.cjs status)
if [ "$(node -e 'console.log(JSON.parse(process.argv[1]).connected===true)' "$status")" != true ]; then
  printf 'Fyso Biz: not connected yet (panel → Fyso Biz → Connect)\n'
  exit 0
fi
node extensions/biz/biz.cjs check >/dev/null
printf 'Fyso Biz MCP: authenticated and context available\n'
