#!/usr/bin/env bash
# seed-member.sh <project-dir>: a locally edited file the setup would replace, so the connect preview must warn.
set -euo pipefail
cd "$1"
mkdir -p project/wiki
printf '# Welcome (local edit)\n\nmy own notes\n' > project/wiki/welcome.md
git add -A && git commit -q -m "member: local edit"
