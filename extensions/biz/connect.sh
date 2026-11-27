#!/usr/bin/env bash
set -euo pipefail
node extensions/biz/bot.cjs
# The Biz project's people into the people directory, whenever a people project is
# configured (`biz_people_project`, or managed access). It uses the project's own Biz
# connection, not managed access. Runs first so a failed team apply does not hold it
# back. Not fatal: a failed sync changes nothing, records its error and is retried by
# the hourly ext-biz-people-sync workflow.
if [[ -n "${FYSO_BIZ_PEOPLE_PROJECT:-}" || -n "${FYSO_BIZ_ACCESS_PROJECT:-}" ]]; then
  node extensions/biz/people-sync.cjs || true
fi
# Biz-managed access: deliver the teams Biz configured for this project.
if [[ -n "${FYSO_BIZ_ACCESS_ORGANIZATION:-}" ]]; then
  node extensions/biz/managed-teams.cjs
fi
