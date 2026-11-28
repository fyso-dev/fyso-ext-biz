#!/usr/bin/env bash
# Shared helpers for the local sweep. Sourced, never executed.

log()  { printf '[e2e %s] %s\n' "$(date +%H:%M:%S)" "$*" | tee -a "${E2E_LOGS:-/dev/null}/run.log" >&2; }
fail() { log "FAIL: $*"; return 1; }

# Results table: phase<TAB>status<TAB>detail
record() { printf '%s\t%s\t%s\n' "$1" "$2" "${3:-}" >> "$E2E_LOGS/results.tsv"; }

# wait_for <seconds> <description> <command...>: poll until the command succeeds.
wait_for() {
  local secs=$1 what=$2; shift 2
  local i
  for ((i = 0; i < secs; i += 2)); do
    "$@" >/dev/null 2>&1 && return 0
    sleep 2
  done
  fail "timeout waiting for $what"
}

port_free() { ! nc -z 127.0.0.1 "$1" 2>/dev/null && ! nc -z ::1 "$1" 2>/dev/null; }

# Never print a value of a credential variable: only whether it is set.
need_env() {
  local missing=() v
  for v in "$@"; do [ -n "${!v:-}" ] || missing+=("$v"); done
  [ ${#missing[@]} -eq 0 ] || { log "missing environment: ${missing[*]} (see README: credentials file)"; return 1; }
}
