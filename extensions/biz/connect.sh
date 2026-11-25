#!/usr/bin/env bash
set -euo pipefail
node extensions/biz/bot.cjs
# Biz-managed access: deliver the teams Biz configured for this project.
if [[ -n "${FYSO_BIZ_ACCESS_ORGANIZATION:-}" && -n "${FYSO_BIZ_ACCESS_PROJECT:-}" ]]; then
  node extensions/biz/managed-teams.cjs
fi
