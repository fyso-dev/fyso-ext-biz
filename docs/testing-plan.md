# Testing plan: Biz ↔ framework integration

Goal: every failure seen in production on 2026-11-27/28 is covered by a test that runs without the real Biz, mise or network, plus a local Fyso Biz in Docker that proves the mocks tell the truth.

Repos: `fyso-ext-biz` (extension), `agentic-framework` (`template/framework/scripts/dist.cjs`), `fyso-business` (Biz worker).

This version merges two reviews of the first draft (`1c6c060`): an independent Codex review and a Claude review, both checked against the code.

## Three tiers

| Tier | What | Runs | Needs |
|---|---|---|---|
| 1. Unit (mocked) | Each module against a fake Biz, fake mise, fake clock, temp disk | Every PR, seconds | Nothing |
| 2. Contract | Shared JSON fixtures replayed against the fake Biz (tier 1) and the real Biz in Docker | CI of fyso-business and fyso-ext-biz | Docker |
| 3. End to end | Disposable framework projects + Playwright through the real panel (PR #25 adapted to Docker) | Before every deploy | Docker |

**Pinned revisions (tiers 2 and 3).** Every integration run takes the candidate SHA of the repo under test and pins the SHAs of the other two (no "whatever is checked out locally"). The run report records the three effective SHAs so the same combination can be replayed.

## Tier 1: mocked unit tests

### 1.0 Shared mocks (first; everything depends on it)

**Extract, don't rewrite.** `tests/managed-setup.test.cjs` already has a working harness: `harness()` (fake reports, recipients, teams, token failures), per-argument mise exits (`h.exits['--dry-run']`) and `DRY()` for the dry-run JSON. Step 2 moves it into `fyso-ext-biz/tests/helpers/`, generalizes it, and migrates `managed-setup.test.cjs` to it with **no behavior change** (the existing 45 tests are the checker). Only after that does block A start on the same file.

The helpers must provide:

- **Fake Biz transport**, in memory, with scenarios:
  - access report for admin, member, no access, frozen, `reauthorize_required`;
  - 401, 403, 409 `stale_base`, 5xx, timeout;
  - setup version and etag that change between calls;
  - **held responses**: a request can be parked and released later, to drive races (block B).
- **Fake mise / dist runner** that replaces the command runner. Canned outputs for `dist:key`, `dist:plan`, `dist:publish --dry-run --json`, `dist:update` and `snapshot`:
  - success, and exit codes 1, 3, 4 and 5;
  - mise "Operation not permitted";
  - non-JSON output;
  - stderr containing machine paths and secrets.
- **Fake clock**: the 30 s report cache (`REPORT_TTL`), 5 min stale window (`REPORT_STALE`), 15 s access timeout, 8 h credential expiry and notice times.
- **Temp disk**: `setup.json`, `.copier-answers.dist.yml` and `project/distribution.yaml` in a temp folder per test.
- **Contract fixtures**: Biz responses live as JSON in `tests/contract/fixtures/` so tier 2 replays the same files against the real Biz (see Tier 2).

### 1.1 Blocks (parallel; one agent per block, never two on the same files)

| Block | Scope |
|---|---|
| **A. `managed-setup`** | **Sync matrix:**<br>• same etag → no-op;<br>• apply after a snapshot;<br>• 401/403 → `reauthorize_required`;<br>• network, timeout or 5xx → `biz_unreachable` with `detail`;<br>• freeze only when a setup was already delivered;<br>• delete received secrets on revocation.<br>**Publish:**<br>• preview → digest → 409 `preview_stale`;<br>• exit codes 3, 4 and 5;<br>• `dist:key` retry;<br>• `selfPublished` recorded after a CLI publish;<br>• auto-republish when recipients change.<br>**Notices:** collapsing, redaction of paths and secrets.<br>**Pauses:** which ones a sign-in clears (all but frozen). |
| **B. `project-access`, `profile-session`, `profile-token`** | **Cache:**<br>• single-flight;<br>• serve stale data on network errors, never on 401/403/frozen/reauthorize;<br>• `invalidate`;<br>• 15 s timeout.<br>**Invalidation during an in-flight request (known bug, fix included):** hold an admin response in the fake transport, call `invalidate(token)`, downgrade the person in the fake Biz, release the held response. The next `report(token)` must return the downgraded permissions without waiting for the TTL. Today it fails twice: `invalidate` (`project-access.cjs:151`) does not drop `inflight`, so a call made before release reuses the old promise, and the resolved request re-caches the old report (`:131-136`). The fix (for example a per-key generation counter checked before `cache.set`, and `inflight.delete` in `invalidate`) belongs in this block, with the test written first.<br>**Login:**<br>• lost state → 400;<br>• host-only cookie;<br>• `forUser` skips expired sessions;<br>• sync resumes after sign-in.<br>**Token** (`profile-token` has no test file yet; new): refresh and refused refresh. |
| **C. `project-policy`, `department-capabilities`, `mcp-policy`** | **Table of host × path × capabilities:**<br>• panel, omb, dagu, docs;<br>• `biz.` only `/login` and `/callback`.<br>**Capabilities:**<br>• wildcards;<br>• admin = level 2;<br>• member = max level per area;<br>• `/profile/access` without wildcards. |
| **D. Untested modules** | `gateway`, `publication`, `email`, `email-delivery`, `service/worker.mjs`: happy path and errors.<br>`bot`: **gaps only**. `tests/biz-bot.test.cjs` already covers idempotent provisioning, name collision and refusing plans that touch other bots. List the missing branches first and add only those. |
| **E. Panel screens** | **Setup first** (none exists today: `package.json` has no dev dependencies and `test` runs only `node --test`): add Vitest + Testing Library + jsdom as dev dependencies, a `test:panel` script and a CI step.<br>**Tests** with a fake `fetch`.<br>**Setup in every state:**<br>• connected;<br>• paused (each reason);<br>• frozen;<br>• no access;<br>• preview with a failed check;<br>• stale preview;<br>• merge conflict.<br>**Also:**<br>• notice collapsing and "Ver todos";<br>• "Volver a autorizar";<br>• no raw codes ever rendered;<br>• es/en keys complete. |
| **F. Framework `dist.cjs`** (agentic-framework) | Extend `tests/test_distribution.py`:<br>• `--dry-run --json` contract (fields, exit 3 on stale base, exit 1 on failed checks);<br>• stable digest;<br>• `memory/log/**` excluded;<br>• recipients changed → re-encrypt. |
| **G. Biz handler** (fyso-business) | **Setup routes with a fake repository** (handler logic only; the real guarantee is checked in tier 2):<br>• PUT with `X-Setup-Base`: the handler passes the base to the repository and maps its conflict to 409;<br>• `version_conflict`, `manifest_too_large`;<br>• `?organization` that does not match → 403.<br>**Credentials and recipients:**<br>• expired credential → `reauthorize_required`, never `congelar`;<br>• recipients only for active people;<br>• `conLimite` 1.5 s. |

### 1.2 Regression tests (named `regression: …`)

Each one names the fix it guards and the block where it lives, so "all exist" can be checked by grep.

| # | Regression | Fix | Block |
|---|---|---|---|
| 1 | An expired embedded credential was treated as a non-member: frozen, empty caps. | fyso-business | G |
| 2 | One Biz call per request → 503. | #27 | B |
| 3 | A 5 s timeout against a ~4 s Biz → 503. | #28 | B |
| 4 | Only MCP visible: no page/action capabilities. | #29 | C |
| 5 | 403 on `omb.` and other app hosts. | #30 | C |
| 6 | The shown version was stale after a publish. | #31 | A |
| 7 | The preview digest included the git tree, so it was always stale. | #31 / framework | A, F |
| 8 | `machine_paths` failed on the extension's own files. | #34 | A, F |
| 9 | A 401 was reported as `biz_unreachable`. | #33 | A |
| 10 | Repeated identical notices. | #33 | A, E |
| 11 | A pause with no way out (no reauthorize action). | #33–#34 | A, E |
| 12 | v2 shown while Biz had v3 (CLI publish). | #34 | A |
| 13 | `invalidate` during an in-flight report restored the old permissions. | this plan | B |

PR numbers are fyso-ext-biz PRs, taken from the commit history. Fill in the fyso-business and framework fixes while writing those tests.

## Tier 2 and 3: local Fyso Biz in Docker

Already there:
- `fyso-business/infra/postgres-local/compose.yml`: pgvector pg16 on port 5457.
- `wrangler.jsonc` env `local` with Hyperdrive `localConnectionString`.
- D1, KV, R2 and Durable Objects simulated by Miniflare.
- fyso-ext-biz PR #25 (`feat/e2e-local-sweep`, open): a local sweep that runs Biz on the host with `opennextjs preview`. Decide in step 8 whether to merge it first and then adapt it, or to replace it.

New: `docker compose -f infra/local/compose.yml up` in fyso-business.

| Service | Role |
|---|---|
| `postgres` | The existing compose, with a volume, on port 5457. |
| `migrate` | One-shot. The 11 migrations have no `CREATE SCHEMA` or `search_path`, so the runner does it: `CREATE SCHEMA IF NOT EXISTS fyso_business AUTHORIZATION fyb_owner`, then `SET search_path = fyso_business` and `SET ROLE fyb_owner` before applying each file, then grants for `fyb_app`. Fails if any table ends up in `public`. |
| `biz` | Node image. OpenNext build + `wrangler dev --env local` with persisted D1, KV, R2 and Durable Objects, on `http://localhost:8787`. **Override the Hyperdrive connection:** `wrangler.jsonc` points `localConnectionString` at `localhost:5457`, which inside the container is the container itself. Use `postgres:5432` (for example `CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_<BINDING>` or a `wrangler.docker.jsonc`). |
| `seed` | One-shot. Deterministic data:<br>• org `local-org`;<br>• two admins (concurrent publishes);<br>• a member with one active department;<br>• a person with no access;<br>• a deactivated person (freeze);<br>• departments and policy;<br>• an OAuth `framework_access` client with a `localhost` callback.<br>Generated passwords go to `.data/local/credentials.env`, never printed, never the production e2e credentials. |
| `fake-fyso` | Stand-in for the Fyso backend. Its clock can be driven, so the 8 h expiry is testable in seconds. **Scope decided by step 1**: at least login and credential issuing. Biz also reads and writes data in Fyso (`src/infra/cliente-records-fyso`, `editor-agentes-fyso`, `motor-busqueda-documentos-fyso`). If the local env can use `transporte-records-postgres`, records go to Postgres. Otherwise `fake-fyso` must also serve records, and step 7 grows accordingly. |

Framework and extension side: `.env.local-biz` with:
- `FYSO_DIST_BIZ_URL=http://localhost:8787`
- `FYSO_DIST_BIZ_ORGANIZATION=local-org`
- the extension's Biz URL variables

A copier-generated test project then talks to the local Biz instead of fyso.biz.

### Tier 2: contract suite

- The fixtures in `fyso-ext-biz/tests/contract/fixtures/` (request + expected response shape) are the contract. Tier 1 feeds them to the fake transport. Tier 2 sends the same requests to the Docker Biz and checks the same shape. A fixture that passes in tier 1 and fails in tier 2 means the mock is lying.
- **Concurrent publishes against the real handler and Postgres:** two admins send `PUT` with the same `X-Setup-Base` and distinguishable content. Expect exactly one 2xx and one 409, the version increases by exactly one, and a following read returns the winner's content.

### Tier 3: end to end

- Start from PR #25's Playwright sweep, pointed at the Docker Biz.
- **In pre-deploy mode, missing credentials fail the run.** Today the sweep calls `test.skip(!hasCreds, …)`, so an empty `credentials.env` gives a green run that tested nothing. Check the credentials at startup, and after the run assert from the Playwright report that the required admin and member journeys ran and passed. Any skipped required journey fails the run.

## Done criteria

- **Coverage, enforced per file in CI:**
  - extension (`node --test --experimental-test-coverage` with `--test-coverage-include=extensions/biz/**` and per-file checks; a small script reads the report and fails if any listed file is below its threshold, not just the average):
    - ≥ 85 % lines **and** ≥ 85 % branches **each**, in `managed-setup.cjs`, `project-access.cjs`, `profile-session.cjs` and `project-policy.cjs`. 84 % branches in one file fails even if the average is higher;
    - ≥ 70 % lines for every other file in `extensions/biz/` (per file, not pooled);
  - panel (`vitest --coverage`, separate report): ≥ 70 % lines for `panel-src/screens/Setup.tsx` and `panel-src/screens/Biz.tsx`; other screens reported, not gated.
- **Regressions:** the 13 regression tests exist, are named `regression: …` and pass.
- **Isolation:** no tier-1 test uses the network, real mise or machine paths. `tests/machine-paths.test.cjs` stays green.
- **Docker:** `docker compose up` on a clean machine gives a seeded Biz with no tables in `public`. The tier-2 contract suite, concurrent publishes included, passes against it.
- **Before deploy:** the tier-3 sweep passes with every required journey executed (none skipped), and its report records the three repo SHAs.

## Steps and routing (`~/.claude/AGENTS.md`)

| # | Activity | Model | Effort | Depends on |
|---|---|---|---|---|
| 1 | Map Biz's external dependencies: Fyso backend auth, **records (Fyso API vs `transporte-records-postgres` in local)**, email, OAuth, wrangler secrets. Decide what `fake-fyso` must stub. | haiku | medium | — |
| 2 | Shared mocks (1.0): extract the existing harness, add held responses, fixtures folder | sonnet | medium (failures re-run at high) | — |
| 3 | Blocks A, B (incl. the `invalidate` fix), C | sonnet | high | 2 |
| 4 | Blocks D, E (incl. Vitest setup), F | sonnet | medium (failures re-run at high) | 2 (F: none) |
| 5 | Block G | sonnet | high | — |
| 6 | Compose, `biz` image (Hyperdrive override), `migrate` (schema/search_path), `seed` | sonnet | high | 1 |
| 7 | `fake-fyso` with a driveable clock | sonnet | high | 1 |
| 8 | Contract tier (fixtures + concurrent publishes on Postgres), adapt PR #25 to Docker with mandatory credentials and pinned SHAs | sonnet | high | 2, 6, 7 |
| 9 | CI gates: per-file coverage script, `test:panel`, SHA recording | sonnet | medium | 3, 4 |
| 10 | Independent review of each PR | opus | medium | each PR |

Changes from the draft: step 2 goes down to `medium`, because it is now a refactor checked by 45 existing tests. Step 8 goes up to `high`, because concurrency and the pre-deploy gate have no stronger checker. Step 9 is new.

**Parallel waves:**
1. Steps 1, 2, 5 and F.
2. Steps 3, 4, 6 and 7.
3. Steps 8 and 9.
4. Step 10 for each PR.

**Expected PRs:**
- fyso-ext-biz: mocks extraction; blocks A–C; blocks D–E; CI gates; then the contract tier and the Docker sweep.
- agentic-framework: block F.
- fyso-business: block G, then Docker local.
