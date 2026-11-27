# Integration behavior

This repository owns the Biz page, MCP adapter, connection hook and bot profile. The framework provides only generic static-page hosting, panel SDK v1 or later, encrypted secrets, extension processes and routes, Dagu, native Bot Architect and the bots plan/apply workflows. The OAuth login (`auth.cjs`, `gateway.cjs`) and the team import (`team.cjs`) belong to this extension.

## Native business reads

| Surface | MCP read |
|---|---|
| Departments, KPIs, active objectives/KRs | `contexto({departamento_id?})` |
| Requests | `listar_solicitudes({})`, with selected-department filtering |
| Objective plan, palancas and decisions | `vision_objetivo({objetivo_id})`, only when advertised read-only |

The connected server is authoritative. The adapter discovers tools, accepts JSON/SSE transport, disables redirects, requires HTTPS and bounds response size/time. Missing capabilities and denied reads are explicit; measurements retain null vs zero and range thresholds retain both bounds. Failed refreshes clear previous content. Changing department invalidates pending objective reads.

## Bot and connection lifecycle

The framework invokes `extensions/biz/connect.sh` after installation into a running project and on startup once required secrets are configured. Native Bot Architect owns the guarded create plan/apply, snapshots and project team commit. Biz Partner receives business instructions and root cwd for the native `fyso-biz` MCP, an offered model, ask approval and computer off.

Repeated connections preserve the same owned bot without overwriting customizations. A conflicting unrelated name fails safely. Removing the extension hides its tab and removes slots while retaining its project-owned bot, encrypted secret and runtime data. Delete that bot explicitly through Bot Architect when desired.

With Biz-managed access (`biz_access_organization` set; `biz_access_project` is optional), the hook then delivers the configured system (`managed-teams.cjs`). It reads the teams of the person's departments from Biz (`departamentos_framework`, each team once) when no project is set, or, when `biz_access_project` is set, the project's teams (`proyectos_framework` with `proyecto_id`, the legacy path). It stops without changing anything when Biz answers for another organization or does not list the project, or when the framework lacks `framework/scripts/managed-bots.cjs` (`managed_bots_not_supported`). Team by team it pulls the department package (`exportar_equipo`, the same pull as the panel, Biz wins), records the departments and bots delivered so far as managed by owner `biz` through the framework helper (which replaces that owner's record and commits `project/bots/managed.json`), and applies the proposed team file through `panel-actions.sh plan`/`apply` (`TEAM_B64`, `TEAM_BASE_B64`, the plan's removal revision); the pull is then marked applied in `project/biz-teams.json` and its record flagged `managed`. A team already at Biz's version (`listar_equipos`) is skipped, so rerunning the hook changes nothing, and a failed apply is retried by the next run. Without managed access the hook only provisions Biz Partner.

Creation of a request, authorization, execution, delivery verification and acceptance remain separate Biz decisions. No panel refresh mutates business records. Native bot mutations need an explicit human instruction and Biz authorization.

## People of the Biz project

`people-sync.cjs` mirrors the people Biz assigns to a project into the human-requests people directory. The project is the `biz_people_project` answer (`FYSO_BIZ_PEOPLE_PROJECT`), or `FYSO_BIZ_ACCESS_PROJECT` when that is empty (the answer defaults to `biz_access_project`, so managed installs need nothing new). Only the extension's own Biz connection is used: no framework access API, and the panel login, `panel-access.caddy`, `authorize.caddy`, `mcp-authorize` and the Workflows and feedback pages stay tied to `biz_access_project` alone. Flow, in this order, so that any failed read changes nothing:

1. Biz: `listar_personas_proyecto({proyecto: <people project>})` on the extension's own MCP session (the hook and workflow open one with `biz.token()`, as `managed-teams.cjs` does). The answer must name the same project and list `{id, nombre}` with a non-empty id and name, or the run stops (`project_mismatch`, `unexpected_response`); Biz's `proyecto_desconocido` and `personas_no_disponibles` are reported as such. The tool is not in the bot proxy's `ALLOWED`: bots read people through the directory, and the extension calls Biz directly, not through the proxy.
2. Organization: the person ids are scoped by the organization slug. It is `FYSO_BIZ_ACCESS_ORGANIZATION` when set; otherwise `proyectos_framework({proyecto_id: <people project>})` on the same session, whose answer carries `organizacion`. A missing or invalid slug (`^[a-z0-9][a-z0-9-]{0,62}$`), or a Biz without `proyectos_framework`, stops the run with `organization_unavailable`.
3. Wiki: all `fyso-people/` pages are listed and read through Dagu's REST API (`http://127.0.0.1:$FYSO_DAGU_PORT/api/v1/wiki…`, the API the panel reaches at `/api/dagu/wiki`) with the project's technical Dagu credential (`FYSO_ADMIN_USER`/`FYSO_ADMIN_PASSWORD`, passed by `run-ext.sh` like every `FYSO_*` variable and used the same way by the framework's `dagu-client.cjs`). Writing through Dagu, not the files under `project/wiki/`, keeps Dagu's own wiki handling in charge.
4. Writes: a person's page is `fyso-people/<id>` where `<id>` is sha256(`fyso-biz-person:<organization>:<biz id>`), first 16 bytes, version 4 and variant 10xx, formatted as a UUID (unchanged since v0.5.0, so the same organization and Biz id keep their page). Its content is `{"version":1,"name":<name>,"source":"biz","biz_id":<biz id>}` and a newline; names are one line, trimmed, at most 80 characters. Missing pages are created (`POST /wiki`), pages whose content differs are rewritten (`PATCH`), and pages marked `"source":"biz"` whose person Biz no longer lists are deleted. Pages without that mark, or not valid JSON, are never written, even at a synced id (counted as `conflicts`).

One run at a time (`.data/ext/biz/people-sync.lock`, stale after ten minutes). Each run records `{at, ok, count, created, updated, removed, conflicts}` or `{at, ok:false, error}` in `.data/ext/biz/people-sync.json`, keeping the last good count; `GET /status` adds `people_synced`, `people_count` and `people_sync` from it whenever a people project is configured. The connection hook runs the sync whenever a people project is configured, before the managed-access team delivery, and does not fail on it; the `ext-biz-people-sync` workflow and the `biz:people-sync` task (installed when `biz_people_project` or `biz_access_project` is set) run it hourly and on demand; the workflow fails visibly in Dagu and fails visibly in Dagu. Dagu's wiki has no compare-and-swap, so a person edited in the panel at the same moment can lose that edit; the panel shows synced people read-only.

## Agent identity and the bot proxy

One OAuth grant is one Biz agent, `oauth:<clientId>:<tenantUserId>`, named by its nickname in Biz or the registered client name (`Fyso project <slug>`). A request created with `ejecutor: agente` and `agente_destino` set to that name is reserved for this project. Biz offers the agent work cycle over MCP (ADR 0104/0110/0116/0120/0121): `solicitudes_disponibles` (pull only; no push), `tomar_solicitud` (conditional: a second taker gets `ya_tomada`), `registrar_avance` (plan/paso/medicion/actividad; 24 h without a heartbeat releases the request), `subir_evidencia`, `cerrar_solicitud` (`done`/`failed` with a summary) and `soltar_solicitud`.

Biz has no per-tool scope: the same grant could call person-side decision tools (`aprobar_palanca`, `aceptar_entrega`, `autorizar_ejecucion`, …). Bots therefore never receive the grant. `.mcp.json` declares `fyso-biz` as a stdio server, `framework/scripts/run-ext.sh biz -- node extensions/biz/mcp-proxy.cjs`, which:

- answers `initialize` and `ping` itself and relays `tools/list` and `tools/call` to Biz with `biz.token()` (the personal token when set, else the OAuth access token, refreshed under the store's lock);
- reconnects when the credential changes and retries once after a 401/403, which Biz returns before running anything; other failures are not retried, so a call is never executed twice;
- exposes only the tools in `ALLOWED` (one list in `mcp-proxy.cjs`: reads, selected proposals and the work cycle). Others are filtered from `tools/list` and refused on `tools/call` with JSON-RPC error `-32602` without contacting Biz.

Add a tool to `ALLOWED` only when it reads, or when it belongs to the agent's own work on a request.

## Native team import

A downloaded Biz team becomes an OpenMausBot native team in `project/bots/team.yaml`: `teams: [{name, brief: {file: ${FYSO_ROOT}/project/bots/biz/<slug>/brief.md}}]` (the team prompt, given by OpenMausBot to every member), `team: <name>` on each imported bot and one room `{name, team, members}`. No `chief` or `responder` is set. The import owns the team whose brief is its `brief.md`, the room named after that team and the bots whose soul lives under its directory; it never takes over anything else with the same name (`name_conflict`, `team_conflict`).

## Privacy and identity

The project connection token stays in sops/process environment or `.data/ext/biz/`, never URL parameters, workflow params, browser storage, `.mcp.json` or generated page output. Gateway users share the connected token owner's department scope; separate projects are required for separate credentials. Dagu retains selected business fields under the project's access and retention rules.

The page is trusted installed code on the authenticated project origin, not a separate identity or sandbox. Compiled assets import the shared SDK through native ES modules; source locales/styles remain owned by this repository.

## Feedback receipt recovery

The extension uses the signed-in person's Biz access token server-side for
feedback. When it has no usable local receipt, it looks up the report with
authenticated `GET /oauth/framework-feedback`, scoped by organization, project
and report ID. A 404 means Biz has no receipt, a 409 means confirmation is
pending, and an unavailable lookup blocks a new submission. An unreadable or
invalid local receipt also blocks submission unless Biz can recover it.

An available receipt can be returned after the local Markdown is archived.
A first submission requires the local Markdown. If GitHub publication is
confirmed but the local cache write fails, reopening the report retries
receipt recovery and storage without another publication request.

## Compatibility and tests

Copier reads `framework/panel/extension-api.json` through native external data. API v1 or later is required before initial installation. The compatibility validator tolerates the empty temporary destination Copier uses to render the previous tagged template during updates; tagged-upgrade tests exercise that path with the real Copier consumer.

See the root [README](../README.md) for current commands, requirements and versioned installation. The initial integration evidence under `artifacts/` is a historical snapshot from before this repository was extracted. Unit tests cover the adapter and bot orchestration; packaging tests cover owned slots, unsupported hosts and native tag-to-tag upgrades.


## Access by department

Contract with Biz (additive; the project-based forms keep working). `GET /oauth/framework-access?organization=<slug>[&project=<uuid>][&capability=<name>]`:

- With `capability`: `{"allowed": boolean}`.
- Without it: `{"capabilities": string[], "admin": boolean, "departments": [{id, name, role: {id, name, custom, levels}, teams: [{id, name}]}], "policy": {"preset": "cuidado|equilibrado|libre|personalizado", "extensions", "mcp_servers", "bots", "read", "write", "shell", "publish", "ai"}}`. Only `capabilities` is required; a non-`string[]` fails closed. Malformed `departments` entries are dropped and an unknown `preset` is shown as `personalizado`; both are display data only.
- Without a project, an old OAuth grant whose identity Biz cannot recover answers HTTP 200 with `{"capabilities": [], "reauthorize_required": true}` (or `{"allowed": false, "reauthorize_required": true}`). The report exposes it as `reauthorizeRequired`; `/api/panel-access` returns `reauthorizeRequired: true` and the **Your departments** tab asks the person to reconnect Fyso Biz instead of showing no departments. The managed-teams delivery skips (`skipped: "reauthorize_required"`) and changes nothing; an unreadable report never blocks it. Administrators and owners get the `libre` preset at its maximum, and people without a stored policy are `equilibrado`.
- `project` is sent only when `biz_access_project` is set. `FYSO_BIZ_ACCESS_ORGANIZATION` alone turns on the panel and MCP policy, the template slots (`authorize.caddy`, `panel-access.caddy`, `mcp-authorize`, the Workflows and feedback pages), the feedback endpoint (`/oauth/framework-feedback`, `project` optional) and the managed-teams delivery. The people sync still needs a project (`biz_people_project`).
- `GET /api/panel-access` (the framework's rewrite to `/profile/access`) returns `capabilities`, `remoteCredentialPath`, `admin`, `departments` and `policy` for the panel's **Your departments** tab.

Capability mapping in `project-policy.cjs`: the action capability of each route still decides. When Biz sends a `policy`, `frameworkRequirement()` additionally requires `framework:mcp_servers:catalog` for MCP server management (`action:connectors:manage`). It narrows access and never widens it, so a Biz without policy behaves as before.

Still needing a framework-core hook (no panel action or gate exists in the extension): `framework:extensions:catalog|any` (extension install and which catalogs), `framework:mcp_servers:any` (catalog vs custom server, the body is not visible to the policy), `framework:bots:create` (creating bots, which shares the `fyso-bots-apply` workflow with pulling Biz teams), `framework:machine:read|write[:ask]`, `framework:shell[:ask]` (agent computer, file and command permissions), `framework:publish` and `framework:ai:standard|high` (model choice and consumption).

## Biz-managed setup (v0.7.0)

Needs Biz's managed-setup endpoints (`GET /oauth/framework-access` with `setup`, `etag`, `recipients_pending`, `frozen`; `/setup`; `/recipient`; `/recipients`, all with `?organization=`) and the framework's Biz transport (`dist:key`, `dist:plan --json`, `dist:add biz`, `dist:update`, `dist:publish`).

- **Credential:** the `framework_access` profile grant. The panel session keeps it only on **Connect** (`profile-oauth.json` under `.data/ext/biz/`, renewable); Cancel and Disconnect delete it. `profile-token.cjs` prints a fresh token for `FYSO_DIST_BIZ_TOKEN_CMD`.
- **Connect:** `/api/ext/biz/profile/setup/{status,preview,confirm,cancel,publish,disconnect}` (`managed-setup.cjs`). `preview` registers the age key and returns the plan and removals; `confirm` takes the digest of what was shown (`preview_changed` if it moved), snapshots, installs, delivers teams and removes.
- **Sync:** `ext-biz-sync` runs `managed-setup.cjs sync`. State is `.data/ext/biz/setup.json`; notices appear in the Setup tab.
- **Freeze:** state `frozen` makes `project-policy.cjs` refuse non-read requests and `mcp-policy.cjs` refuse non-read tools, and removes the delivered secrets (`sops unset`, needs sops 3.9+). Unfrozen when Biz answers `frozen: false`; the setup is then installed once more, so the delivered secrets return when the published version was encrypted for this installation's key. A project that never started commits only before a change (git is its state), as `dist.sh` does.
- **Limits:** "in the setup" is `contents` of `dist:plan --json` (the full sets of the incoming version); with an older framework it falls back to what earlier plans listed as added. Catalog extensions are those that `marketplace.cjs resolve` maps to the installed source; catalog MCP servers are those of `framework/mcp.json`.
- **Several admins:** `dist:publish` exits 3 (`stale_base`) when Biz has a newer version. The panel then offers **Update and merge** (`/profile/setup/merge`: snapshot, `dist:update` merge, publish again); exit 4 (conflict, project unchanged) lists the files from `.data/dist/merge-conflicts.json` and stops. The sync's automatic republish merges once and retries; on a conflict it pauses (`publishPaused`) with a panel notice, and a later manual publish clears it. The admin's edits are never discarded.
