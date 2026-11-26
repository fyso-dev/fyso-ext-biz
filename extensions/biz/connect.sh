#!/usr/bin/env bash
set -euo pipefail
node extensions/biz/bot.cjs
# Biz-managed access: deliver the people and teams Biz configured for this project.
if [[ -n "${FYSO_BIZ_ACCESS_ORGANIZATION:-}" && -n "${FYSO_BIZ_ACCESS_PROJECT:-}" ]]; then
  # The project's Biz people into the people directory, first so a failed team apply does
  # not hold it back. Not fatal: a failed sync changes nothing, records its error and is
  # retried by the hourly ext-biz-people-sync workflow.
  node extensions/biz/people-sync.cjs || true
  node extensions/biz/managed-teams.cjs
fi
