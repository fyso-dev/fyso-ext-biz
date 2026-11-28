#!/usr/bin/env bash
# seed-admin.sh <project-dir>: the organization's setup the admin will publish: a bot, wiki pages, an MCP server,
# one secret and `repo: biz`. Runs with the project's own age key (MISE_SOPS_AGE_KEY_FILE already exported).
set -euo pipefail
cd "$1"
printf '\n  - name: Sales Helper\n    title: Org setup bot\n    model: claude/claude-sonnet-5\n    approval: ask\n    tools: { allow: ["native:*"] }\n' >> project/bots/team.yaml
mkdir -p project/wiki
printf '# Welcome\n\nline1\nline2\nline3\n' > project/wiki/welcome.md
printf 'X base\n' > project/wiki/x.md
echo '{"mcpServers":{"orgdocs":{"url":"http://127.0.0.1:9/mcp"}}}' > project/mcp.json
printf 'repo: biz\nsecrets: [ORG_API_KEY]\n' > project/distribution.yaml
mise exec -- sops set secrets.enc.yaml '["ORG_API_KEY"]' '"org-secret-v1"'
git add -A && git commit -q -m "admin: org setup"
