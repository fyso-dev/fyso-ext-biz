# Local end-to-end sweep ("barrida local")

Runs the Biz-managed framework setup end to end on your machine, before any deploy:

- the REAL Biz worker (Next.js via OpenNext, run by `opennextjs-cloudflare preview` on workerd) with the local docker Postgres, local D1/KV/R2;
- two disposable framework projects (admin, member) generated with Copier, with this extension installed against that Biz;
- a real headless Chrome (Playwright) driving the real panel UI.

It exists to catch the class of bugs that only show up when the three repos run together: a CSP `form-action` blocking the OAuth redirect, an extension process running with stale env, `/oauth/framework-access` answering 503 to an organization admin, the Setup tab invisible before connecting, a failed preview deleting the profile grant.

Identity still goes to the real Fyso (`api.fyso.dev`): the organization, its users and passwords are real. Everything else is local.

## Run

```
scripts/e2e-local/run.sh [--biz-ref REF] [--framework-ref REF] [--ext-ref REF] [--skip-build] [--keep] [--preflight-only]
```

Defaults are the current checkouts: `../fyso-business`, `../agentic-framework` (override with `E2E_BIZ_REPO`, `E2E_FRAMEWORK_REPO`) and this repository. A `--*-ref` runs that ref from a temporary git worktree (Biz also gets an `npm ci`). Only committed state is used for the framework and the extension (Copier installs a git ref), so commit before running. `--preflight-only` runs just the checks that need no credentials; `--keep` keeps the temp dir with the generated projects.

Needs: docker running, `mise`, node, network (Copier, tool downloads, api.fyso.dev). The first run installs the pinned tools of the generated projects and the Playwright browser; later runs are cached.

### Credentials (never committed, never printed)

Everything comes from the environment. Load it from an untracked file, which `run.sh` sources automatically:

```
mkdir -p ~/.config/fyso-e2e && chmod 700 ~/.config/fyso-e2e
cat > ~/.config/fyso-e2e/credentials.env <<'ENV'
E2E_BIZ_ORG=<organization slug>
E2E_BIZ_ADMIN_EMAIL=...
E2E_BIZ_ADMIN_PASSWORD=...
E2E_BIZ_MEMBER_EMAIL=...
E2E_BIZ_MEMBER_PASSWORD=...
E2E_BIZ_ORG_API_KEY=<the organization's Fyso tenant API key>
ENV
chmod 600 ~/.config/fyso-e2e/credentials.env
```

(`E2E_CREDENTIALS_FILE` points elsewhere.) `E2E_BIZ_ORG_API_KEY` is the one input beyond the contract: Biz resolves an organization's Fyso API key only from its tenant directory (D1), which is empty on a local Biz, so the run seeds that directory with the organization, the key encrypted with a throwaway local `TENANT_CREDENTIALS_KEY`. Optional: `E2E_BIZ_ORG_TENANT_ID`, `E2E_BIZ_ORG_SCHEMA_VERSION` (default 23, what the local-rest fixture uses).

Without credentials the sweep still runs the preflight checks (with a placeholder organization) and reports the rest as SKIP, never as PASS.

The member account is changed for real in the organization while the sweep freezes it (departments and admin removed through Biz's own `PATCH /api/usuarios/:id/acceso`); the spec restores the original access in a `finally`. Use a dedicated test member.

### Output

A pass/fail table at the end. Logs and a copy of each project's `.data/logs` are kept in `~/.local/state/fyso-e2e/<timestamp>/` (`E2E_LOG_ROOT` to move them): `run.log`, one log per phase, `biz-worker.log`, `playwright.json`, failure screenshots. Traces are off on purpose: they record typed passwords.

## What it checks

Phases (`run.sh`): Biz DB up + `db:migrar` on the local docker Postgres (and the E2E organization's setup rows reset); Biz build and start on `:38787`; health (OAuth metadata on the local origin, migrations present); two projects generated (ports `47610..47629` and `47630..47649`, never the 85xx block); stacks up with `mise run up` (only those two projects, started from a clean environment so no other Dagu/OpenMausBot can be reached); then Playwright:

`tests/preflight.spec.ts` (no credentials): Biz OAuth metadata on the local origin; an unconnected admin landing on the sign-in page after the project's web login; that page's CSP `form-action` allows exactly the local Biz origin (no wildcard); the "Continue" button really reaches Biz (client registered, no CSP violation); the extension API answers behind the panel login. (Without a Biz session the panel is only reachable through that sign-in page, so the Setup tab can only be checked after signing in.)

`tests/sweep.spec.ts` (credentials): admin sign-in page -> Biz login -> consent -> back in the panel, Setup tab and its Connect action visible before connecting; Preview and apply; `/oauth/framework-access` answers 200 (not 503) to the admin with the real token; publish; member signs in, the preview warns about the files it would replace, confirm, sync applies; admin republishes for the member's new age key and the member receives the secret; admin changes the setup, publishes, member sync applies it; a failing preview keeps a connected member's grant; freeze the member through Biz, then the member is read-only and the delivered secret is gone.

The runner also records `up: connect hook exit status`: `mise run up` must exit 0 on a project that has not connected yet.

## Gaps (stubbed or not emulated)

- Durable Objects from the separate `fyso-business-agendador` worker (`BUS_EVENTOS`, `EJECUTOR_TAREAS`, `PROGRAMACION_AGENDADOR`) are "not connected": SSE invalidations, schedules and cloud runs do not work. Not needed by the managed setup.
- Hyperdrive is not emulated (direct connection, as the Biz README documents); crons do not run; email routing is local only.
- R2 (`FRAMEWORK_SETUPS`), KV, D1 are the workerd local emulations on a fresh per-run directory; production limits (50 MiB bundles, R2 latency) are not exercised.
- `BACKEND_DATOS` stays at its default (`fyso`): business data is the real organization's; roles and policy are read from the local Postgres, which starts empty (default policy).
- Plain `http://*.localhost` instead of HTTPS: `Secure` cookies, `__Host-` cookie names and the remote MCP token (`/profile/mcp-token`, HTTPS only) are not covered.
- Only committed framework/extension state is installed (Copier uses a git ref).
