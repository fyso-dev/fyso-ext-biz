#!/usr/bin/env bash
# Local end-to-end sweep of the Biz-managed framework setup, with the REAL Biz worker of the local stack (fyso-business infra/local),
# real framework projects and a real browser. See README.md. Usage:
#   run.sh [--framework-ref REF] [--ext-ref REF] [--fresh] [--reuse] [--keep] [--preflight-only]
set -uo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
EXT_REPO=$(cd "$HERE/../.." && pwd)
FRAMEWORK_REPO=${E2E_FRAMEWORK_REPO:-$EXT_REPO/../agentic-framework}
ADMIN_BASE=${E2E_ADMIN_PORT_BASE:-47610}
MEMBER_BASE=${E2E_MEMBER_PORT_BASE:-47630}
FRAMEWORK_REF_ARG= EXT_REF_ARG= KEEP=0 PREFLIGHT_ONLY=0 FRESH=0 REUSE=0
while [ $# -gt 0 ]; do
  case $1 in
    --framework-ref) FRAMEWORK_REF_ARG=$2; shift 2;;
    --ext-ref) EXT_REF_ARG=$2; shift 2;;
    --fresh) FRESH=1; shift;;      # restart the stack (keeps credentials) so the organization has no setup
    --reuse) REUSE=1; shift;;      # use a stack that is already up; never stop it
    --keep) KEEP=1; shift;;
    --preflight-only) PREFLIGHT_ONLY=1; shift;;
    -h|--help) sed -n 2,5p "$0"; exit 0;;
    *) echo "unknown option $1" >&2; exit 2;;
  esac
done

# The local stack (fyso-business infra/local) owns the Biz, its Postgres and the fake Fyso. Nothing here talks to the real Fyso.
FYSO_BUSINESS_ROOT=${FYSO_BUSINESS_ROOT:-$EXT_REPO/../fyso-business}
[ -f "$FYSO_BUSINESS_ROOT/infra/local/orquestador.mjs" ] || { echo "set FYSO_BUSINESS_ROOT to a fyso-business checkout with infra/local (branch feat/local-docker-stack)" >&2; exit 2; }
CRED_FILE=${E2E_CREDENTIALS_FILE:-$FYSO_BUSINESS_ROOT/.data/local/credentials.env}
PG_PORT=${E2E_PG_PORT:-5467}   # never the 5457 of infra/postgres-local
orquestador() { ( cd "$FYSO_BUSINESS_ROOT" && BIZ_LOCAL_PG_PORT=$PG_PORT node infra/local/orquestador.mjs "$@" ); }
# Personas of the stack's credentials.env, never printed: propietario = admin, miembro = member.
load_credentials() {
  [ -f "$CRED_FILE" ] || return 1
  local v
  for v in BIZ_URL BIZ_ORGANIZATION FAKE_FYSO_URL FAKE_FYSO_ADMIN_TOKEN PROPIETARIO_EMAIL PROPIETARIO_PASSWORD MIEMBRO_EMAIL MIEMBRO_PASSWORD; do
    export "$v=$(sed -n "s/^$v=//p" "$CRED_FILE" | head -1)"
  done
  export E2E_BIZ_ADMIN_EMAIL=$PROPIETARIO_EMAIL E2E_BIZ_ADMIN_PASSWORD=$PROPIETARIO_PASSWORD E2E_BIZ_MEMBER_EMAIL=$MIEMBRO_EMAIL E2E_BIZ_MEMBER_PASSWORD=$MIEMBRO_PASSWORD
  export E2E_FAKE_FYSO_URL=$FAKE_FYSO_URL E2E_FAKE_FYSO_ADMIN_TOKEN=$FAKE_FYSO_ADMIN_TOKEN E2E_BIZ_ORG=$BIZ_ORGANIZATION
}

TS=$(date +%Y%m%d-%H%M%S)
E2E_LOGS=${E2E_LOG_ROOT:-$HOME/.local/state/fyso-e2e}/$TS
E2E_WORK=${E2E_WORK_ROOT:-/tmp}/fyso-e2e-$TS    # short path: unix sockets live inside the projects
mkdir -p "$E2E_LOGS" "$E2E_WORK"; chmod 700 "$E2E_WORK"
: > "$E2E_LOGS/results.tsv"
export E2E_LOGS E2E_WORK
. "$HERE/lib.sh"

BIZ_URL=${E2E_BIZ_URL:-http://localhost:8787}
STACK_STARTED=0 WORKTREES=()
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
  if [ "$STACK_STARTED" = 1 ]; then orquestador down --keep-credentials >>"$E2E_LOGS/biz-stack.log" 2>&1 || true; fi
  for w in "${WORKTREES[@]:-}"; do [ -n "$w" ] && git -C "${w%%|*}" worktree remove --force "${w##*|}" 2>/dev/null; done
  [ "$KEEP" = 1 ] || rm -rf "$E2E_WORK"
  print_table
}
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

# ---------------------------------------------------------------- Biz (the local stack)
stack_up() {
  load_credentials || true   # a first run creates credentials.env
  if curl -fsS "$BIZ_URL/.well-known/oauth-authorization-server" >/dev/null 2>&1; then
    if [ "$FRESH" = 1 ] && [ "$REUSE" = 0 ]; then orquestador down --keep-credentials || return 1
    else echo "Biz already up at $BIZ_URL: reusing it (it is not stopped at the end)"; return 0; fi
  fi
  [ "$REUSE" = 1 ] && { echo "--reuse: no Biz at $BIZ_URL"; return 1; }
  STACK_STARTED=1
  local flags=(--background); [ -d "$FYSO_BUSINESS_ROOT/.open-next" ] && flags+=(--skip-build)
  orquestador up "${flags[@]}"
}
stack_health() {
  load_credentials || { echo "no credentials.env at $CRED_FILE"; return 1; }
  curl -fsS "$BIZ_URL/.well-known/oauth-authorization-server" | node -e '
    const m=JSON.parse(require("fs").readFileSync(0,"utf8"));
    if(!(m.scopes_supported||[]).includes("framework_access")) throw Error("no framework_access scope");
    for(const k of ["authorization_endpoint","token_endpoint","registration_endpoint"]) if(!m[k].startsWith(process.argv[1])) throw Error(k+" not on the local origin");
    console.log("oauth metadata ok", m.issuer)' "$BIZ_URL"
  [ "$(curl -s -o /dev/null -w '%{http_code}' "$BIZ_URL/login")" = 200 ]
  curl -fsS "$FAKE_FYSO_URL/health" >/dev/null
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
  # No browser download unless asked for: the Playwright cache of this machine is used as is.
  [ "${E2E_INSTALL_BROWSERS:-0}" = 1 ] && { npx playwright install chromium || return 1; }
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
  [ -d "$FRAMEWORK_REPO" ] || { log "set E2E_FRAMEWORK_REPO"; return 1; }
  FRAMEWORK_DIR=$(checkout_ref "$FRAMEWORK_REPO" "$FRAMEWORK_REF_ARG" framework) || return 1
  EXT_DIR=$(checkout_ref "$EXT_REPO" "$EXT_REF_ARG" ext) || return 1
  FRAMEWORK_REF=$(git -C "$FRAMEWORK_DIR" rev-parse HEAD); EXT_REF=$(git -C "$EXT_DIR" rev-parse HEAD)
  log "biz stack $(git -C "$FYSO_BUSINESS_ROOT" rev-parse --short HEAD) $(git -C "$FYSO_BUSINESS_ROOT" branch --show-current), framework ${FRAMEWORK_REF:0:7}, extension ${EXT_REF:0:7}; logs $E2E_LOGS"

  phase biz-stack     stack_up     || return 1
  phase biz-health    stack_health || return 1
  phase projects-generate projects_generate || return 1
  phase projects-up   projects_up  || return 1
  write_state
  playwright_run
}
main
exit $?
