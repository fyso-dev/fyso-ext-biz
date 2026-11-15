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

Creation of a request, authorization, execution, delivery verification and acceptance remain separate Biz decisions. No panel refresh mutates business records. Native bot mutations need an explicit human instruction and Biz authorization.

## Privacy and identity

The token stays in sops/process environment, never URL parameters, workflow params, browser storage or generated page output. `.mcp.json` uses an environment placeholder. Gateway users share the connected token owner's department scope; separate projects are required for separate credentials. Dagu retains selected business fields under the project's access and retention rules.

The page is trusted installed code on the authenticated project origin, not a separate identity or sandbox. Compiled assets import the shared SDK through native ES modules; source locales/styles remain owned by this repository.

## Compatibility and tests

Copier reads `framework/panel/extension-api.json` through native external data. API v1 or later is required before initial installation. The compatibility validator tolerates the empty temporary destination Copier uses to render the previous tagged template during updates; tagged-upgrade tests exercise that path with the real Copier consumer.

See the root [README](../README.md) for current commands, requirements and versioned installation. The initial integration evidence under `artifacts/` is a historical snapshot from before this repository was extracted. Unit tests cover the adapter and bot orchestration; packaging tests cover owned slots, unsupported hosts and native tag-to-tag upgrades.
