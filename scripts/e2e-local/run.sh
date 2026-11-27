#!/usr/bin/env bash
# Local end-to-end sweep of the Biz-managed framework setup, with the REAL Biz worker (workerd, local Postgres/D1/KV/R2),
# real framework projects and a real browser. See README.md. Usage:
#   run.sh [--biz-ref REF] [--framework-ref REF] [--ext-ref REF] [--skip-build] [--keep] [--preflight-only]
set -uo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
EXT_REPO=$(cd "$HERE/../.." && pwd)
BIZ_REPO=${E2E_BIZ_REPO:-$EXT_REPO/../fyso-business}
FRAMEWORK_REPO=${E2E_FRAMEWORK_REPO:-$EXT_REPO/../agentic-framework}
BIZ_PORT=${E2E_BIZ_PORT:-38787}
ADMIN_BASE=${E2E_ADMIN_PORT_BASE:-47610}
MEMBER_BASE=${E2E_MEMBER_PORT_BASE:-47630}
BIZ_REF= FRAMEWORK_REF_ARG= EXT_REF_ARG= SKIP_BUILD=0 KEEP=0 PREFLIGHT_ONLY=0
while [ $# -gt 0 ]; do
  case $1 in
    --biz-ref) BIZ_REF=$2; shift 2;;
    --framework-ref) FRAMEWORK_REF_ARG=$2; shift 2;;
    --ext-ref) EXT_REF_ARG=$2; shift 2;;
    --skip-build) SKIP_BUILD=1; shift;;
    --keep) KEEP=1; shift;;
    --preflight-only) PREFLIGHT_ONLY=1; shift;;
    -h|--help) sed -n 2,5p "$0"; exit 0;;
    *) echo "unknown option $1" >&2; exit 2;;
  esac
done

# Credentials: only from the environment, optionally loaded from an untracked file. Never printed.
CRED_FILE=${E2E_CREDENTIALS_FILE:-$HOME/.config/fyso-e2e/credentials.env}
if [ -f "$CRED_FILE" ]; then
  [ "$(stat -f %Lp "$CRED_FILE" 2>/dev/null || stat -c %a "$CRED_FILE")" = 600 ] || echo "warning: chmod 600 $CRED_FILE" >&2
  set -a; . "$CRED_FILE"; set +a
fi
export E2E_BIZ_ORG=${E2E_BIZ_ORG:-}
E2E_BIZ_ORG_DEFAULTED=0; if [ -z "$E2E_BIZ_ORG" ]; then E2E_BIZ_ORG=e2e-preflight; E2E_BIZ_ORG_DEFAULTED=1; export E2E_BIZ_ORG; fi

TS=$(date +%Y%m%d-%H%M%S)
E2E_LOGS=${E2E_LOG_ROOT:-$HOME/.local/state/fyso-e2e}/$TS
E2E_WORK=${E2E_WORK_ROOT:-/tmp}/fyso-e2e-$TS    # short path: unix sockets live inside the projects
mkdir -p "$E2E_LOGS" "$E2E_WORK"; chmod 700 "$E2E_WORK"
: > "$E2E_LOGS/results.tsv"
export E2E_LOGS E2E_WORK
. "$HERE/lib.sh"

BIZ_URL=http://localhost:$BIZ_PORT
BIZ_PID= DB_STARTED=0 DEVVARS_BACKUP= BIZ_DIR=$BIZ_REPO WORKTREES=()
PROJECTS=()

# ---------------------------------------------------------------- teardown
teardown() {
  trap - EXIT INT TERM
  log "tearing down"
  for p in "${PROJECTS[@]:-}"; do
    [ -n "$p" ] && [ -d "$E2E_WORK/projects/$p" ] || continue
    pcmd "$p" mise run down >>"$E2E_LOGS/$p-down.log" 2>&1 || true
    mkdir -p "$E2E_LOGS/$p"; cp -R "$E2E_WORK/projects/$p/.data/logs/." "$E2E_LOGS/$p/" 2>/dev/null || true
    cp "$E2E_WORK/projects/$p/.data/ext/biz/setup.json" "$E2E_LOGS/$p/setup-state.json" 2>/dev/null || true
  done
  if [ -n "$BIZ_PID" ]; then kill_tree "$BIZ_PID"; fi
  lsof -ti "tcp:$BIZ_PORT" -sTCP:LISTEN 2>/dev/null | xargs kill 2>/dev/null || true
  if [ -n "${DEVVARS_BACKUP:-}" ]; then mv -f "$DEVVARS_BACKUP" "$BIZ_DIR/.dev.vars"; else rm -f "$BIZ_DIR/.dev.vars"; fi
  if [ "$DB_STARTED" = 1 ]; then (cd "$BIZ_DIR" && npm run db:down >>"$E2E_LOGS/biz-db.log" 2>&1) || true; fi
  for w in "${WORKTREES[@]:-}"; do [ -n "$w" ] && git -C "${w%%|*}" worktree remove --force "${w##*|}" 2>/dev/null; done
  [ "$KEEP" = 1 ] || rm -rf "$E2E_WORK"
  print_table
}
kill_tree() { local p; for p in $(pgrep -P "$1" 2>/dev/null); do kill_tree "$p"; done; kill "$1" 2>/dev/null || true; }
print_table() {
  echo; echo "Local sweep $TS (logs: $E2E_LOGS)"
  awk -F'\t' 'BEGIN{printf "%-6s %-58s %s\n","RESULT","CHECK","DETAIL"} {printf "%-6s %-58s %s\n",$2,$1,$3; if($2=="FAIL")bad=1; if($2=="SKIP")skip++} END{exit bad}' "$E2E_LOGS/results.tsv"
  local rc=$?; [ $rc -eq 0 ] && echo "OVERALL: PASS (skipped checks are NOT verified)" || echo "OVERALL: FAIL"
  return $rc
}
trap 'teardown; exit $?' EXIT
trap 'exit 130' INT TERM

# Run a command inside a disposable project with a clean environment: nothing of the caller's project
# (ports, FYSO_*, OPENMAUSBOT_URL, age key) can leak in, so no other Dagu/OpenMausBot can be reached.
pcmd() {
  local p=$1; shift
  ( cd "$E2E_WORK/projects/$p" && env -i HOME="$HOME" PATH="$PATH" TERM=dumb LANG="${LANG:-en_US.UTF-8}" USER="${USER:-e2e}" \
      TMPDIR="${TMPDIR:-/tmp}" MISE_SOPS_AGE_KEY_FILE="$E2E_WORK/keys/$p.age" SOPS_AGE_KEY_FILE="$E2E_WORK/keys/$p.age" \
      GIT_AUTHOR_NAME=e2e GIT_AUTHOR_EMAIL=e2e@example.invalid GIT_COMMITTER_NAME=e2e GIT_COMMITTER_EMAIL=e2e@example.invalid \
      "$@" )
}

phase() { # phase <name> <fn>: run, record, abort the whole sweep on failure of a prerequisite
  local name=$1; shift
  log "== $name"
  if "$@" >>"$E2E_LOGS/$name.log" 2>&1; then record "$name" PASS; return 0; fi
  record "$name" FAIL "see $name.log"; log "phase $name failed (tail of its log below)"; tail -15 "$E2E_LOGS/$name.log" >&2
  return 1
}

# ---------------------------------------------------------------- refs
checkout_ref() { # <repo> <ref> <name> -> prints the directory to use
  local repo=$1 ref=$2 name=$3
  if [ -z "$ref" ]; then echo "$repo"; return; fi
  local d="$E2E_WORK/src/$name"; mkdir -p "$E2E_WORK/src"
  git -C "$repo" fetch -q origin 2>/dev/null || true
  git -C "$repo" worktree add -q --detach "$d" "$ref" 2>/dev/null || git -C "$repo" worktree add -q --detach "$d" "origin/$ref" || return 1
  WORKTREES+=("$repo|$d"); echo "$d"
}

# ---------------------------------------------------------------- Biz
biz_prepare() {
  # The local database is the docker Postgres of infra/postgres-local (localhost:5457) and nothing else.
  case "${PG_URL_DUENO:-}${PG_ROL_APP:-}" in ""|*localhost:5457*) ;; *) echo "PG_URL_DUENO points outside the local docker Postgres; refusing"; return 1;; esac
  docker info >/dev/null 2>&1 || { echo "docker is not running"; return 1; }
  if ! nc -z localhost 5457 2>/dev/null; then DB_STARTED=1; fi
  ( cd "$BIZ_DIR" && npm run db:up && npm run db:migrar ) || return 1
  # Fresh setup state for the E2E organization (the R2 bucket of a new run is empty, so rows must be too).
  if [ -n "$E2E_BIZ_ORG" ]; then
    local sql="DELETE FROM fyso_business.framework_setups WHERE _organizacion_id='$E2E_BIZ_ORG'; DELETE FROM fyso_business.framework_setup_receptores WHERE _organizacion_id='$E2E_BIZ_ORG'; DELETE FROM fyso_business.framework_setup_rotaciones WHERE _organizacion_id='$E2E_BIZ_ORG';"
    ( cd "$BIZ_DIR" && docker compose -f infra/postgres-local/compose.yml exec -T postgres psql -U postgres -d fyso_business -v ON_ERROR_STOP=1 -c "$sql" ) || return 1
  fi
}
biz_build() {
  cd "$BIZ_DIR" || return 1
  [ -d node_modules ] || npm ci --ignore-scripts || return 1
  # Worker variables for the local run. `.dev.vars` is gitignored; an existing one is restored at teardown.
  if [ -f .dev.vars ]; then DEVVARS_BACKUP=$E2E_WORK/dev.vars.backup; mv .dev.vars "$DEVVARS_BACKUP"; fi
  export TENANT_CREDENTIALS_KEY=$(openssl rand -base64 32)
  umask 077
  cat > .dev.vars <<VARS
SESSION_SECRET=$(openssl rand -hex 32)
TENANT_CREDENTIALS_KEY=$TENANT_CREDENTIALS_KEY
FYSO_API_BASE=https://api.fyso.dev/api
FYSO_ENVIRONMENT=local
APP_URL=$BIZ_URL
FYSO_EVENTOS_ENABLED=0
FYSO_CACHE_LECTURAS_ENABLED=0
FEATURE_FLAGS={}
VARS
  umask 022
  [ "$SKIP_BUILD" = 1 ] && [ -f .open-next/worker.js ] && return 0
  npx opennextjs-cloudflare build
}
biz_start() {
  cd "$BIZ_DIR" || return 1
  port_free "$BIZ_PORT" || { echo "port $BIZ_PORT is busy"; return 1; }
  local state=$E2E_WORK/biz-state
  # Local D1 (tenant directory) migrations, then the E2E organization's row.
  npx wrangler d1 migrations apply TENANTS_DB --local --persist-to "$state" || return 1
  if [ -n "${E2E_BIZ_ORG_API_KEY:-}" ] && [ -n "$E2E_BIZ_ORG" ]; then
    local sqlfile=$E2E_WORK/tenant.sql
    ( umask 077; node "$HERE/seed-tenant.mjs" > "$sqlfile" ) || return 1
    npx wrangler d1 execute TENANTS_DB --local --persist-to "$state" --file "$sqlfile" >/dev/null || { rm -f "$sqlfile"; return 1; }
    rm -f "$sqlfile"; echo "tenant directory seeded for $E2E_BIZ_ORG"
  else
    echo "E2E_BIZ_ORG_API_KEY not set: the tenant directory is empty, Biz login and framework access will not work"
  fi
  ( cd "$BIZ_DIR" && exec npx opennextjs-cloudflare preview --port "$BIZ_PORT" --persist-to "$state" ) >"$E2E_LOGS/biz-worker.log" 2>&1 &
  BIZ_PID=$!
  wait_for 120 "Biz worker" curl -fsS "$BIZ_URL/.well-known/oauth-authorization-server"
}
biz_health() {
  curl -fsS "$BIZ_URL/.well-known/oauth-authorization-server" | node -e '
    const m=JSON.parse(require("fs").readFileSync(0,"utf8"));
    if(!(m.scopes_supported||[]).includes("framework_access")) throw Error("no framework_access scope");
    for(const k of ["authorization_endpoint","token_endpoint","registration_endpoint"]) if(!m[k].startsWith(process.argv[1])) throw Error(k+" not on the local origin");
    console.log("oauth metadata ok", m.issuer)' "$BIZ_URL"
  [ "$(curl -s -o /dev/null -w '%{http_code}' "$BIZ_URL/login")" = 200 ]
  # Migrations really applied on the local Postgres.
  ( cd "$BIZ_DIR" && docker compose -f infra/postgres-local/compose.yml exec -T postgres psql -U postgres -d fyso_business -tAc \
    "select count(*) from information_schema.tables where table_schema='fyso_business' and table_name in ('framework_setups','framework_politicas')" ) | grep -qx 2
}

# ---------------------------------------------------------------- projects
projects_generate() {
  export FRAMEWORK_SRC=$FRAMEWORK_DIR EXT_SRC=$EXT_DIR FRAMEWORK_REF EXT_REF BIZ_URL
  local name base
  for spec in "e2e-admin:$ADMIN_BASE" "e2e-member:$MEMBER_BASE"; do
    name=${spec%%:*} base=${spec##*:}
    for ((i = 0; i < 20; i++)); do port_free $((base + i)) || { echo "port $((base + i)) is busy"; return 1; }; done
    PROJECTS+=("$name")
    "$HERE/gen-project.sh" "$name" "$base" "$(openssl rand -hex 12)" || return 1
  done
  MISE_SOPS_AGE_KEY_FILE="$E2E_WORK/keys/e2e-admin.age" pcmd e2e-admin "$HERE/seed-admin.sh" "$E2E_WORK/projects/e2e-admin" || return 1
  pcmd e2e-member "$HERE/seed-member.sh" "$E2E_WORK/projects/e2e-member"
}
projects_up() {
  local p rc=0
  for p in e2e-admin e2e-member; do
    # `mise run up` runs the extension's connect hook last; on a project that never connected it exits non-zero
    # (managed-teams.cjs: `not_connected` is reported as `connection_failed`). The stack itself is up, so the sweep
    # goes on and records that exit status as its own failing check.
    if ! pcmd "$p" mise run up; then
      pcmd "$p" mise exec -- framework/scripts/health.sh caddy >/dev/null 2>&1 || { echo "stack of $p is not healthy"; return 1; }
      record "up: connect hook exit status ($p)" FAIL "mise run up exited non-zero on a never-connected project: managed-teams.cjs reports not_connected as connection_failed"
    else
      record "up: connect hook exit status ($p)" PASS
    fi
    pcmd "$p" mise run doctor >"$E2E_LOGS/$p-doctor.log" 2>&1 || log "doctor of $p reported problems (see $p-doctor.log)"
  done
  return $rc
}
write_state() {
  node -e '
    const fs=require("fs"),[work,logs,biz,org,ab,mb,admin]=process.argv.slice(1);
    const dom=(n,b)=>`${n}-${b}.localhost`;
    const project=(n,b)=>({name:n,dir:`${work}/projects/${n}`,port:+b,age:`${work}/keys/${n}.age`,user:"'"${ADMIN_USER:-admin}"'",
      password:fs.readFileSync(`${work}/keys/${n}.password`,"utf8").trim(),panel:`http://panel.${dom(n,b)}:${b}`});
    fs.writeFileSync(`${logs}/state.json`,JSON.stringify({biz,org,logs,projects:{admin:project("e2e-admin",ab),member:project("e2e-member",mb)}},null,2),{mode:0o600});
  ' "$E2E_WORK" "$E2E_LOGS" "$BIZ_URL" "$E2E_BIZ_ORG" "$ADMIN_BASE" "$MEMBER_BASE"
}
playwright_run() {
  cd "$HERE" || return 1
  [ -d node_modules ] || npm install --no-audit --no-fund || return 1
  npx playwright install chromium || return 1
  export E2E_STATE=$E2E_LOGS/state.json
  local grep_args=()
  [ "$PREFLIGHT_ONLY" = 1 ] && grep_args=(--grep @preflight)
  PLAYWRIGHT_JSON_OUTPUT_NAME=$E2E_LOGS/playwright.json npx playwright test --reporter=list,json ${grep_args[@]+"${grep_args[@]}"} \
    --output "$E2E_LOGS/playwright-artifacts"
  local rc=$?
  node "$HERE/report.mjs" "$E2E_LOGS/playwright.json" >> "$E2E_LOGS/results.tsv" || true
  return 0
}

main() {
  [ -d "$BIZ_REPO" ] && [ -d "$FRAMEWORK_REPO" ] || { log "set E2E_BIZ_REPO / E2E_FRAMEWORK_REPO"; return 1; }
  BIZ_DIR=$(checkout_ref "$BIZ_REPO" "$BIZ_REF" biz) || return 1
  FRAMEWORK_DIR=$(checkout_ref "$FRAMEWORK_REPO" "$FRAMEWORK_REF_ARG" framework) || return 1
  EXT_DIR=$(checkout_ref "$EXT_REPO" "$EXT_REF_ARG" ext) || return 1
  FRAMEWORK_REF=$(git -C "$FRAMEWORK_DIR" rev-parse HEAD); EXT_REF=$(git -C "$EXT_DIR" rev-parse HEAD)
  log "biz $(git -C "$BIZ_DIR" rev-parse --short HEAD) $(git -C "$BIZ_DIR" branch --show-current), framework ${FRAMEWORK_REF:0:7}, extension ${EXT_REF:0:7}; logs $E2E_LOGS"
  [ "$E2E_BIZ_ORG_DEFAULTED" = 1 ] && log "E2E_BIZ_ORG is not set (using a placeholder): only the credential-free checks can pass"
  export E2E_BIZ_ORG_API_KEY="${E2E_BIZ_ORG_API_KEY:-}"

  phase biz-db        biz_prepare  || return 1
  phase biz-build     biz_build    || return 1
  phase biz-start     biz_start    || return 1
  phase biz-health    biz_health   || return 1
  phase projects-generate projects_generate || return 1
  phase projects-up   projects_up  || return 1
  write_state
  playwright_run
}
main
exit $?
