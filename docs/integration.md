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

With Biz-managed access (`biz_access_organization` and `biz_access_project` set), the hook then delivers the project's configured system (`managed-teams.cjs`). It reads the project's teams from Biz (`proyectos_framework` with `proyecto_id`) and stops without changing anything when Biz answers for another organization or does not list the project, or when the framework lacks `framework/scripts/managed-bots.cjs` (`managed_bots_not_supported`). Team by team it pulls the department package (`exportar_equipo`, the same pull as the panel, Biz wins), records the departments and bots delivered so far as managed by owner `biz` through the framework helper (which replaces that owner's record and commits `project/bots/managed.json`), and applies the proposed team file through `panel-actions.sh plan`/`apply` (`TEAM_B64`, `TEAM_BASE_B64`, the plan's removal revision); the pull is then marked applied in `project/biz-teams.json` and its record flagged `managed`. A team already at Biz's version (`listar_equipos`) is skipped, so rerunning the hook changes nothing, and a failed apply is retried by the next run. Without managed access the hook only provisions Biz Partner.

Creation of a request, authorization, execution, delivery verification and acceptance remain separate Biz decisions. No panel refresh mutates business records. Native bot mutations need an explicit human instruction and Biz authorization.

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
