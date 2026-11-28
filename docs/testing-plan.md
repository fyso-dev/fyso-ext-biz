# Testing plan: Biz ↔ framework integration

Goal: every failure seen in production on 2026-11-27/28 is covered by a test that runs without the real Biz, mise or network, plus a local Fyso Biz in Docker that proves the mocks tell the truth.

Repos: `fyso-ext-biz` (extension), `agentic-framework` (`template/framework/scripts/dist.cjs`), `fyso-business` (Biz worker).

## Three tiers

| Tier | What | Runs | Needs |
|---|---|---|---|
| 1. Unit (mocked) | Each module against a fake Biz, fake mise, fake clock, temp disk | Every PR, seconds | Nothing |
| 2. Contract | The fake Biz scenarios replayed against the real Biz in Docker | CI of fyso-business and fyso-ext-biz | Docker |
| 3. End to end | Disposable framework projects + Playwright through the real panel (PR #25 adapted to Docker) | Before every deploy | Docker |

## Tier 1: mocked unit tests

### 1.0 Shared mocks (first; everything depends on it)

In `fyso-ext-biz/tests/helpers/`:

- **Fake Biz transport**, in memory, with scenarios:
  - access report for admin, member, no access, frozen, `reauthorize_required`;
  - 401, 403, 409 `stale_base`, 5xx, timeout;
  - setup version and etag that change between calls.
- **Fake mise / dist runner** that replaces the command runner. Canned outputs for `dist:key`, `dist:plan`, `dist:publish --dry-run --json`, `dist:update` and `snapshot`:
  - success, and exit codes 1, 3, 4 and 5;
  - mise "Operation not permitted";
  - non-JSON output;
  - stderr containing machine paths and secrets.
- **Fake clock**: the 30 s report cache, 5 min stale window, 8 h credential expiry and notice times.
- **Temp disk**: `setup.json`, `.copier-answers.dist.yml` and `project/distribution.yaml` in a temp folder per test.

### 1.1 Blocks (parallel; one agent per block, never two on the same files)

| Block | Scope |
|---|---|
| **A. `managed-setup`** | **Sync matrix:**<br>• same etag → no-op;<br>• apply after a snapshot;<br>• 401/403 → `reauthorize_required`;<br>• network, timeout or 5xx → `biz_unreachable` with `detail`;<br>• freeze only when a setup was already delivered;<br>• delete received secrets on revocation.<br>**Publish:**<br>• preview → digest → 409 `preview_stale`;<br>• exit codes 3, 4 and 5;<br>• `dist:key` retry;<br>• `selfPublished` recorded after a CLI publish;<br>• auto-republish when recipients change.<br>**Notices:** collapsing, redaction of paths and secrets.<br>**Pauses:** which ones a sign-in clears (all but frozen). |
| **B. `project-access`, `profile-session`, `profile-token`** | **Cache:**<br>• single-flight;<br>• serve stale data on network errors, never on 401/403/frozen/reauthorize;<br>• `invalidate`;<br>• 15 s timeout.<br>**Login:**<br>• lost state → 400;<br>• host-only cookie;<br>• `forUser` skips expired sessions;<br>• sync resumes after sign-in.<br>**Token:** refresh and refused refresh. |
| **C. `project-policy`, `department-capabilities`, `mcp-policy`** | **Table of host × path × capabilities:**<br>• panel, omb, dagu, docs;<br>• `biz.` only `/login` and `/callback`.<br>**Capabilities:**<br>• wildcards;<br>• admin = level 2;<br>• member = max level per area;<br>• `/profile/access` without wildcards. |
| **D. Untested modules** | `gateway`, `publication`, `email`, `email-delivery`, `bot`: happy path and errors. |
| **E. Panel screens** | **Tools:** Vitest + Testing Library with a fake `fetch`.<br>**Setup in every state:**<br>• connected;<br>• paused (each reason);<br>• frozen;<br>• no access;<br>• preview with a failed check;<br>• stale preview;<br>• merge conflict.<br>**Also:**<br>• notice collapsing and "Ver todos";<br>• "Volver a autorizar";<br>• no raw codes ever rendered;<br>• es/en keys complete. |
| **F. Framework `dist.cjs`** (agentic-framework) | Extend `tests/test_distribution.py`:<br>• `--dry-run --json` contract (fields, exit 3 on stale base, exit 1 on failed checks);<br>• stable digest;<br>• `memory/log/**` excluded;<br>• recipients changed → re-encrypt. |
| **G. Biz handler** (fyso-business) | **Setup routes with a fake repository:**<br>• PUT with `X-Setup-Base`: two concurrent publishes, exactly one wins;<br>• `version_conflict`, `manifest_too_large`;<br>• `?organization` that does not match → 403.<br>**Credentials and recipients:**<br>• expired credential → `reauthorize_required`, never `congelar`;<br>• recipients only for active people;<br>• `conLimite` 1.5 s. |

### 1.2 Regression tests (named `regression: …`)

1. An expired embedded credential was treated as a non-member: frozen, empty caps.
2. One Biz call per request → 503.
3. A 5 s timeout against a ~4 s Biz → 503.
4. Only MCP visible: no page/action capabilities.
5. 403 on `omb.` and other app hosts.
6. The shown version was stale after a publish.
7. The preview digest included the git tree, so it was always stale.
8. `machine_paths` failed on the extension's own files.
9. A 401 was reported as `biz_unreachable`.
10. Repeated identical notices.
11. A pause with no way out (no reauthorize action).
12. v2 shown while Biz had v3 (CLI publish).

## Tier 2 and 3: local Fyso Biz in Docker

Already there:
- `fyso-business/infra/postgres-local/compose.yml`: pgvector pg16 on port 5457.
- `wrangler.jsonc` env `local` with Hyperdrive `localConnectionString`.
- D1, KV, R2 and Durable Objects simulated by Miniflare.
- fyso-ext-biz PR #25 (open): a local sweep that runs Biz on the host with `opennextjs preview`.

New: `docker compose -f infra/local/compose.yml up` in fyso-business.

| Service | Role |
|---|---|
| `postgres` | The existing compose, with a volume, on port 5457. |
| `migrate` | One-shot. Applies `migrations/` into schema `fyso_business` with owner `fyb_owner` and grants for `fyb_app` (avoids the tables-in-`public` mistake). |
| `biz` | Node image. OpenNext build + `wrangler dev --env local` with persisted D1, KV, R2 and Durable Objects, on `http://localhost:8787`. |
| `seed` | One-shot. Deterministic data:<br>• org `local-org`;<br>• two admins (concurrent publishes);<br>• a member with one active department;<br>• a person with no access;<br>• a deactivated person (freeze);<br>• departments and policy;<br>• an OAuth `framework_access` client with a `localhost` callback.<br>Generated passwords go to `.data/local/credentials.env`, never printed, never the production e2e credentials. |
| `fake-fyso` | Small stand-in for the Fyso backend for login and credential issuing. Its clock can be driven, so the 8 h expiry is testable in seconds. |

Framework and extension side: `.env.local-biz` with:
- `FYSO_DIST_BIZ_URL=http://localhost:8787`
- `FYSO_DIST_BIZ_ORGANIZATION=local-org`
- the extension's Biz URL variables

A copier-generated test project then talks to the local Biz instead of fyso.biz.

Main risk: if Biz validates sessions against the real Fyso backend, `fake-fyso` must mimic that contract exactly. Step 1 below confirms it before anything is built.

## Status

| Tier | What exists | Run it |
|---|---|---|
| 1. Unit | The extension tests run in `tests/*.test.cjs` with shared fakes in `tests/helpers/`. The framework and Biz also test their own CLI and handler contracts. | `mise run test` and `mise exec -- node scripts/check-coverage.cjs`. For packaging, run `mise exec -- uv run --no-project --python 3.12 python -m unittest discover -s tests -p test_packaging.py`. |
| 1. Panel | Vitest and Testing Library tests run in `panel-src/__tests__` with fake fetch responses. | `npm ci` and `npm run test:panel`. |
| 2. Contract | `tests/contract/` compares the parsed results and HTTP exchanges from the fake and real Biz through the same production clients. `SKIPPED_ON_REAL` lists scenarios the stack cannot produce. The local run passed 20/20. | Set `BIZ_CONTRACT_URL` and `BIZ_CONTRACT_CREDENTIALS` for the seeded stack (see `.env.local-biz.example`), then run `mise run contract` or `npm run test:contract`. CI runs this job on manual dispatch with a reachable `biz_url` and a `BIZ_CONTRACT_CREDENTIALS` repository secret containing the credentials file. |
| 3. End to end | `scripts/e2e-local/` provisions disposable framework projects and drives the real panel with Playwright. Preflight and sweep passed 16/16 on two consecutive fresh runs. Every sweep step is active. | `FYSO_BUSINESS_ROOT=... scripts/e2e-local/run.sh --fresh`. See the runner README for prerequisites and `--preflight-only`. |
| Local Biz | `fyso-business/infra/local` on `feat/stack-local-biz` supplies Postgres, migrations, seed data, Biz and fake-fyso. | In the Biz checkout, `docker compose -f infra/local/compose.yml up` starts the full seeded stack. Use `npm run local:up` for host mode, with Postgres and fake-fyso in Docker. |

### Findings

| Status | Finding | Fixing repo and branch |
|---|---|---|
| FIXED | Setup was hidden without an agent grant. | `fyso-ext-biz`, `test/contract-tier` |
| FIXED | Any dry-run failure could masquerade as an old framework. | `fyso-ext-biz`, `test/contract-tier` |
| FIXED | The gateway could show an old published version from its report cache. | `fyso-ext-biz`, `test/contract-tier` |
| FIXED | The extension process lost the custom age-key path. | `agentic-framework`, `test/dist-contract-r1` |
| FIXED | The managed-teams hook collapsed failures into `connection_failed`. The seeded teams now deliver in the local sweep. | Diagnostics in `fyso-ext-biz`, `test/contract-tier`. Local records and compatible seeded team models in `fyso-business`, `feat/stack-local-biz`. |
| FIXED | A publication could use inputs that changed after preview. | `agentic-framework`, `test/dist-contract-r1`, and `fyso-ext-biz`, `test/contract-tier` |
| FIXED | Versions sorted as text, so `v10` could never become current after `v9`. | `fyso-business`, `fix/framework-setup-contrato` |
| FIXED | Fake-fyso lacked the team record reads for changelog, skills and native agents. | `fyso-business`, `feat/stack-local-biz` |
| FIXED | Registered members were missing from the recipients list and pending count. | `fyso-business`, `fix/framework-setup-contrato` |
| OPEN | The local HTTP sweep leaves secure cookies and remote MCP tokens untested. | Local end-to-end coverage |
| OPEN | Schedules, SSE invalidations and cloud runs from the separate scheduler worker are outside the sweep. | Local end-to-end coverage |

### Corrections to the original plan

- The embedded credential's 8 h expiry uses Biz's own clock in `iniciar-sesion-global.ts`. Fake-fyso cannot advance it. The unit tier and Biz-side fixture cover expiry-driven reauthorization. The OAuth token endpoint separately returns `expires_in: 3600`.
- Postgres migrations live in `packages/persistencia-postgres/migraciones`.
- The full Compose stack starts and seeds Biz with `docker compose -f infra/local/compose.yml up`. Host mode is `npm run local:up`.
- Node 24 requires the contract test glob `tests/contract/*.contract.cjs`. The real Biz contract also corrected the original fake's 401, frozen and no-access responses, method and organization checks, age-key and manifest validation, and token fields.

## Done criteria

- **Coverage** (`node --test --experimental-test-coverage` in CI):
  - ≥ 85 % lines and branches in `managed-setup`, `project-access`, `profile-session` and `project-policy`;
  - ≥ 70 % for the rest of the extension.
- **Regressions:** all 12 regression tests exist and pass.
- **Isolation:** no tier-1 test uses the network, real mise or machine paths. `tests/machine-paths.test.cjs` stays green.
- **Docker:** `docker compose up` on a clean machine gives a seeded Biz. The tier-2 contract suite passes against it.
- **Before deploy:** the tier-3 sweep passes before any deploy that touches the contract.

## Steps and routing (`~/.claude/AGENTS.md`)

| # | Activity | Model | Effort | Depends on |
|---|---|---|---|---|
| 1 | Map Biz's external dependencies: Fyso backend auth, email, OAuth, wrangler secrets. Decide what `fake-fyso` must stub. | haiku | medium | — |
| 2 | Shared mocks (1.0) | sonnet | high | — |
| 3 | Blocks A, B, C | sonnet | high | 2 |
| 4 | Blocks D, E, F | sonnet | medium (failures re-run at high) | 2 (F: none) |
| 5 | Block G | sonnet | high | — |
| 6 | Compose, `biz` image, `migrate`, `seed` | sonnet | high | 1 |
| 7 | `fake-fyso` with a driveable clock | sonnet | high | 1 |
| 8 | Contract tier + adapt PR #25 to Docker | sonnet | medium | 2, 6, 7 |
| 9 | Independent review of each PR | opus | medium | each PR |

**Parallel waves:**
1. Steps 1, 2, 5 and F.
2. Steps 3, 4, 6 and 7.
3. Step 8.
4. Step 9 for each PR.

**Expected PRs:**
- fyso-ext-biz: mocks and blocks A–E, then the contract tier.
- agentic-framework: block F.
- fyso-business: block G, then Docker local.
