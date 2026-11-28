# Local end-to-end sweep ("barrida local")

Runs the Biz-managed framework setup end to end on your machine, before any deploy, against the **local Biz stack** of fyso-business (`infra/local`, the `feat/stack-local-biz` branch: version ordering past v9, recipients joined by email, a Fyso 401 asking to reauthorize, and the teams-export and agent-catalog routes of fake-fyso): a seeded Biz at `http://localhost:8787` and a fake Fyso instead of the Fyso backend. Nothing calls `fyso.biz` or `api.fyso.dev`.

- the REAL Biz worker (Next.js via OpenNext on workerd) with its own Postgres, started and stopped through the stack's orchestrator;
- two disposable framework projects (admin, member) generated with Copier, with this extension installed against that Biz;
- a real headless Chrome (Playwright) driving the real panel UI.

It exists to catch the class of bugs that only show up when the three repos run together: a CSP `form-action` blocking the OAuth redirect, an extension process running with stale env, `/oauth/framework-access` answering 503 to an organization admin, the Setup tab invisible before connecting, a failed preview deleting the profile grant.

## Run

```
export FYSO_BUSINESS_ROOT=<path to fyso-business>        # a checkout with infra/local
scripts/e2e-local/run.sh [--framework-ref REF] [--ext-ref REF] [--fresh] [--reuse] [--keep] [--preflight-only]
```

- Stack: if nothing answers at `E2E_BIZ_URL` (default `http://localhost:8787`) the runner starts it (`orquestador.mjs up --background`, `--skip-build` when `.open-next` exists; the very first start builds OpenNext, a few minutes) on Postgres port `E2E_PG_PORT` (default 5467, never the 5457 of `infra/postgres-local`) and stops it at the end (credentials are kept). A stack that was already up is reused and left running. `--fresh` restarts a running stack so the organization has no setup (the sweep publishes `v1`); `--reuse` insists on an existing stack.
- Credentials: read from the stack's `credentials.env` (`E2E_CREDENTIALS_FILE` to point elsewhere), never printed or copied: `propietario` is the admin, `miembro` the member. The old `E2E_BIZ_ADMIN_*`, `E2E_BIZ_ORG_API_KEY` and `~/.config/fyso-e2e` are gone.
- Defaults are the current checkouts: `../agentic-framework` (`E2E_FRAMEWORK_REPO`) and this repository. A `--*-ref` runs that ref from a temporary git worktree. Only committed state is used for the framework and the extension (Copier installs a git ref), so commit before running.
- `--preflight-only` runs just the `@preflight` checks; `--keep` keeps the temp dir with the generated projects.
- Browsers: Playwright's cache of this machine is used as is. Nothing is downloaded unless you set `E2E_INSTALL_BROWSERS=1`.

Needs: docker running, `mise`, node, network for Copier and the tools of the generated projects (cached after the first run).

### Output

A pass/fail table at the end. Logs and a copy of each project's `.data/logs` are kept in `~/.local/state/fyso-e2e/<timestamp>/` (`E2E_LOG_ROOT` to move them): `run.log`, one log per phase, `biz-stack.log`, `playwright.json`, failure screenshots. Traces are off on purpose: they record typed passwords. With `E2E_SHOTS_DIR` set, the sweep also saves a few PNGs of the panel (admin Setup, publish preview, member preview and apply, frozen member) as evidence; they never show a sign-in form.

## What it checks

Phases (`run.sh`): stack up (or reused) and health (OAuth metadata on the local origin, `/login`, fake-fyso); two projects generated (ports `47610..47629` and `47630..47649`, never the 85xx block); stacks up with `mise run up` (only those two projects, started from a clean environment so no other Dagu/OpenMausBot can be reached); then Playwright:

`tests/preflight.spec.ts` (no sign-in): Biz OAuth metadata on the local origin; an unconnected admin landing on the sign-in page after the project's web login; that page's CSP `form-action` allows exactly the local Biz origin (no wildcard); the "Continue" button really reaches Biz (client registered, no CSP violation); the extension API answers behind the panel login.

`tests/sweep.spec.ts`: admin sign-in page -> Biz login -> consent -> back in the panel, Setup tab and its Connect action visible right after that profile sign-in (no agent consent needed); Preview and apply; `/oauth/framework-access` answers 200 (not 503) to the admin with the real token; publish (`v1`, so use `--fresh`); member signs in, the preview warns about the files it would replace, confirm, sync applies (no secret yet: v1 was sealed before the member had a key); the member then connects the agent (a second, separate consent) and the managed teams are delivered; Biz lists the member's key and counts the people with access and no key, the admin's sync republishes (`v2`) and the member receives the secret; admin changes the setup, publishes (`v3`), member sync applies it; a failing preview keeps a connected member's grant; the member is deactivated through fake-fyso (`/__admin/users/deactivate`, reactivated in an `afterAll`), then is read-only and the delivered secret is gone.

## Status

Against the local stack (fresh organization: `node infra/local/orquestador.mjs down --keep-credentials`, then `run.sh`, which starts the stack and stops it at the end): the whole sweep passes (16 of 16, no `test.fixme`): stack, health, project generation, `mise run up`, the five `@preflight` checks and every step of `sweep.spec.ts`, including the managed teams delivery after the agent connection (the seeded team packages use `claude/claude-sonnet-5`, the model a generated project offers). Run it twice from a fresh organization to check it is deterministic (the sweep expects the first publish to be `v1`).

Harness notes:

- The disposable projects get no extra mise configuration for the age key: `run.sh` starts them with `SOPS_AGE_KEY_FILE` / `MISE_SOPS_AGE_KEY_FILE` pointing at the project's own key, and the framework's `run-ext.sh` now forwards `SOPS_AGE_KEY_FILE` to extension processes (needs an `agentic-framework` with that change), so the `mise run dist:key|dist:publish` the extension starts can decrypt. A real project keeps its key in the default location and needs nothing.
- The Biz consent button is clicked again until the redirect happens (the page is a Next app that may not be hydrated on the first click).
- `--fresh` only restarts a stack that is up when `--reuse` is not given; to start from a fresh organization with `--reuse`, restart the stack first.
- Biz is the `FYSO_BUSINESS_ROOT` checkout: its `.open-next` build must come from the same sources (`orquestador.mjs up --rebuild` after changing Biz code); a worktree without `node_modules` can take an APFS clone of another checkout's (`cp -cR`, same `package-lock.json`).

## Known gaps of the stack under test

- The 8 h expiry of the embedded credential is Biz's own clock; fake-fyso cannot advance it, so expiry-driven pauses are not covered here (see `tests/contract/`).
- Durable Objects of the separate agendador worker are "not connected": SSE invalidations, schedules and cloud runs do not work. Not needed by the managed setup.
- Plain `http://*.localhost` instead of HTTPS: `Secure` cookies, `__Host-` cookie names and the remote MCP token (HTTPS only) are not covered.
- `scripts/` is not part of the packaged extension (`copier.yml` `_exclude`).
