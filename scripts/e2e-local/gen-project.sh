#!/usr/bin/env bash
# gen-project.sh <name> <port_base> <web_password>
# Generate one disposable framework project in $E2E_WORK/projects/<name> from the framework checkout
# $FRAMEWORK_SRC and install the extension from $EXT_SRC at $EXT_REF with the local Biz.
# Never touches any other project or running stack.
set -euo pipefail
name=$1 port=$2 password=$3
: "${E2E_WORK:?}" "${FRAMEWORK_SRC:?}" "${EXT_SRC:?}" "${EXT_REF:?}" "${BIZ_URL:?}" "${E2E_BIZ_ORG:?}" "${FRAMEWORK_REF:?}"

proj="$E2E_WORK/projects/$name"
keys="$E2E_WORK/keys"; mkdir -p "$keys" "$E2E_WORK/projects"
chmod 700 "$keys"
uv() { mise exec aqua:astral-sh/uv@0.5.1 -- uvx --python 3.12.7 --from copier==9.19.1 "$@"; }

# Disposable projects never run with the user's secrets or age key.
export MISE_SOPS_AGE_KEY_FILE="$keys/$name.age" SOPS_AGE_KEY_FILE="$keys/$name.age"
export GIT_AUTHOR_NAME=e2e GIT_AUTHOR_EMAIL=e2e@example.invalid GIT_COMMITTER_NAME=e2e GIT_COMMITTER_EMAIL=e2e@example.invalid
printf '%s\n' "$password" > "$keys/$name.password"; chmod 600 "$keys/$name.password"

( cd "$E2E_WORK/projects"
  uv copier copy --trust --defaults --vcs-ref "$FRAMEWORK_REF" \
    -d project_name="$name" -d project_slug="$name" -d port_base="$port" \
    "$FRAMEWORK_SRC" "$name" )
cd "$proj"
git init -q -b main
# The answers file records a machine path; the framework's own checks refuse it, so neutralise it.
sed -i.bak 's#^_src_path: .*#_src_path: gh:fyso-dev/agentic-framework#' .copier-answers.yml && rm -f .copier-answers.yml.bak
git add -A && git commit -q -m init

# Isolation guard: the block must be free and must not be the user's 85xx block.
case "$port" in 85??) echo "refusing port block $port" >&2; exit 1;; esac

mise trust -q
mise install -q 2>&1 | tail -2 || true
FYSO_INITIAL_PASSWORD_FILE="$keys/$name.password" mise run setup >/dev/null
git add -A && git commit -q -m setup

mise run ext:add "$EXT_SRC" -- --defaults --vcs-ref "$EXT_REF" \
  -d biz_url="$BIZ_URL" -d biz_access_organization="$E2E_BIZ_ORG" >/dev/null
sed -i.bak 's#^_src_path: .*#_src_path: gh:fyso-dev/fyso-ext-biz#' .copier-answers.ext-biz.yml && rm -f .copier-answers.ext-biz.yml.bak
git add -A && git commit -q -m "ext: biz"
echo "generated $name at $proj (port block $port)"
