# Fyso Biz extension

Independent Copier extension for the Fyso Agentic Framework: a business-context page, the native Fyso Biz MCP connection, and a dedicated **Biz Partner** bot with OKR/KPI/palanca context.

## Requirements

- A generated Fyso project with **panel extension API v1 or later**, extension connection hooks and Bot Architect. These framework capabilities are introduced by [framework PR #14](https://github.com/fyso-dev/agentic-framework/pull/14).
- Access to this private repository through your normal GitHub credentials.
- A Fyso Business account. Connect it from the panel (OAuth); a personal MCP token is an optional alternative. The connected account's permissions scope the connection.

Installation refuses an older framework before writing extension slots. Check `framework/panel/extension-api.json` in the generated project.

## Install

```sh
# From the official catalog (latest release tag):
mise run ext:add biz -- --defaults
# Or pin this release explicitly:
mise run ext:add gh:fyso-dev/fyso-ext-biz -- --vcs-ref v0.1.0 --defaults

# Then open the panel → Fyso Biz → "Connect to Fyso Business".
mise run biz:status
mise run biz:check
```

Default origin: `https://fyso.biz`. To choose another origin, add `-d biz_url=https://example.org` when installing. A local Biz (`npm run dev:local` in fyso-business) works with `-d biz_url=http://localhost:8787`; HTTP is accepted only for `localhost`/`127.0.0.1`.

## Connect (OAuth)

The extension runs a small login process (`ext-biz-login`, the extension port) behind the project's web login at `http://biz.<web_domain>:<port>`. "Connect to Fyso Business" registers a public OAuth client with Biz (dynamic registration), sends the person to Biz with PKCE (S256), and stores the grant in `.data/ext/biz/oauth.json` (mode 600, never in git). Access tokens last one hour and refresh automatically; Biz rotates refresh tokens. "Disconnect" forgets the grant locally; revoke it in Biz under *Conectar mis agentes*.

OAuth grants call Biz on `/mcp`; a personal `fyb_` token (`BOT_FYSO_BIZ_TOKEN`, optional, through `mise run secrets`) calls `/api/mcp` and takes precedence when set.

## Bots in Fyso Business

The OAuth grant is one **agent** in Biz: `oauth:<clientId>:<user>`, named after the registered client (`Fyso project <slug>`) unless the person gives it a nickname in Biz. Requests addressed to that name are this project's work.

Bots and coding agents load the `fyso-biz` MCP server from `.mcp.json`. It is a local stdio proxy (`extensions/biz/mcp-proxy.cjs`, started through `run-ext.sh`) that forwards to Biz with the project's current credential, refreshing the OAuth token as needed, so no credential is written to `.mcp.json` or given to a bot. Biz has no per-tool scopes, so the proxy enforces an allow-list (`ALLOWED` in `mcp-proxy.cjs`):

- reads: `contexto`, `buscar_contexto`, `como_trabajar_en_fyso`, `explicar_kpi`, `obtener_alineacion`, `vision_objetivo`, `listar_objetivos`, `listar_solicitudes`, `listar_checkins`, `listar_historial_kpi`, `listar_equipos`, `ver_solicitud`, `ver_entrega`, `ver_nota`;
- the request work cycle: `solicitudes_disponibles`, `tomar_solicitud`, `soltar_solicitud`, `registrar_avance`, `subir_evidencia`, `cerrar_solicitud`, `crear_nota`.
- proposals: `crear_solicitud`, `guardar_plan_objetivo`. Cloud execution through `crear_solicitud` is blocked because Biz authorizes and queues it immediately.

Every other tool is hidden from `tools/list` and refused on `tools/call` with a JSON-RPC error. Person-side decisions (approving palancas, authorizing execution, accepting deliveries) stay in Biz. Biz does not push work: a bot finds it with `solicitudes_disponibles`. The personal-token path goes through the same proxy and allow-list.

## Download an agent team

Panel → Fyso Biz → *Agent teams* lists the teams in the connection's scope (`listar_equipos`). *Download* reads the team's export (`exportar_equipo`, format `fyso-equipo/v1`) and:

1. writes `project/bots/biz/<team>/souls/<agent>.md` (soul and instructions), `brief.md` (the team prompt), `skills/<skill>/SKILL.md` and `source.json` (team id and version), scans them with gitleaks and commits them (`biz: import team <slug> v<version>`);
2. proposes `project/bots/team.yaml` with an OpenMausBot **native team** — a `teams:` entry named after the Biz team whose `brief` is `brief.md`, `team: <name>` on one bot per agent, and one room with the team's name and all its bots — and runs the framework's own `fyso-bots-plan` preview;
3. on *Apply team*, runs `fyso-bots-apply`, which snapshots, applies to OpenMausBot and commits the team file.

Only configuration travels. New bots use the engine of the project's first non-chief bot, `approval: ask` and the team's skills; local changes to model, approval or tools survive a later download. Downloading again updates the bots, the team (found by its brief file, so a rename in Biz follows) and its room in place, removes agents retired in Biz (also from other rooms), keeps comments and unrelated bots and rooms, and refuses to take over a bot, team or room with the same name that did not come from the import. A room's `responder` you add survives while it stays a member. Connectors per agent are not part of the export yet.

The extension contributes its own tab/page through `extensions/biz/pages/overview.yaml` and compiled assets in `extensions/biz/panel/`. It appears only while installed, at `/#/extensions/biz/overview`, using the host's theme/language and optional panel SDK.

After installation and once services are available, its connection hook creates **Biz Partner** through native Bot Architect plan/apply. It uses an offered model, project-root MCP access, business instructions, `ask` approval and computer off. Reconnection reuses the owned bot without overwriting customizations or duplicating it. A collision with an unrelated bot fails safely.

## Publish, synchronize and propose changes to departments

With a framework that supports department templates (D82), the **Teams** tab lists this project's departments (OpenMausBot teams) with their sync state. **Fyso Business is the source of truth**: its teams flow down one way. A department with no Biz team yet is published once (*Publish to Biz*, `publicar_equipo`), which creates the team. After that a local change is never written back: *Send proposal* sends it as a change proposal (`proponer_cambio_equipo`, Biz ADR 0127) and a person accepts or rejects it on Biz. An accepted proposal is a new Biz version that comes down through the normal pull; a rejected one is shown with its reason. The panel reads the decision again every minute while a proposal waits, and on every *Check*.

A department travels as the framework's native package (`omb-team/1`: shared instructions, bots with soul, model, approval and skills, and group chats). `project/biz-teams.json` records, per department and keyed by the Biz team's name, the Biz team id, its version, the package digest at the last publish or pull, its bots and the last proposal; every change to it is committed. The Biz team id is the department's one identity, and a department downloaded before packages (its `source.json`) is recorded under its Biz team id the first time the sync list is read (`biz: link department …`).

| Local change | New version in Biz | Synchronize |
|---|---|---|
| no | no | in sync |
| no | yes | pull it: review the plan, then apply |
| yes | no | *Send proposal*; then *proposal sent*, *rejected* (with the reason) or, once accepted, pull |
| yes | yes | stops: *Pull from Biz* (local edits stay in git history) or *Propose mine* on the current Biz version |

**The Biz name always wins.** On every sync the record takes the Biz team's current name, with or without a new version. A department renamed locally (found again by its bots) is shown under its Biz name: *Restore* prepares the team file with the Biz name for review and apply, and *Propose* sends the new name as a proposal. Design and the Biz contract: [docs/proposals.md](docs/proposals.md).

Nothing merges concurrent edits. Credentials, memory and conversations never travel. See the framework's `docs/team-templates.md`.

## Updates and removal

```sh
mise run ext:update biz -- --defaults
mise run ext:remove biz
```

Copier records the source and tag in `.copier-answers.ext-biz.yml`. Updates follow the framework's normal clean-tree lifecycle. Removal hides the page and deletes extension slots; it preserves the project-owned bot, runtime data and encrypted secret. Delete the bot explicitly through Bot Architect if desired.

## Privacy and behavior

The page reads native Biz context, KPIs, objectives/KRs, objective visions, palancas, requests and teams through the private extension API and Dagu. The Work tab creates agent requests and configures their destination bot through a versioned Dagu workflow; see [dispatch](docs/dispatch.md). Tokens stay in `.data/ext/biz/` or sops, never in browser storage, URLs or workflow parameters. Project gateway users share the connected account's scope.

Bots act in Biz under the project's single agent identity; Biz cannot tell one project bot from another. A bot's approval mode (`ask`) still asks before each MCP call unless the project allows it.

No secrets, organization data or test credentials belong in this repository. The initial integration evidence uses synthetic screenshots; real authenticated reads were checked separately.

## Development

Runtime installs use committed compiled assets and need no frontend build. For authoring, point to a framework checkout/project with API v1 or later and its pinned panel dependencies installed:

```sh
export FYSO_FRAMEWORK_ROOT=/path/to/framework-checkout
mise run build
mise run test
python3 -m unittest discover -s tests -p 'test_packaging.py'
```

The build reuses that framework's pinned TypeScript/Vite tools and SDK types. It emits only extension-owned assets; the browser imports the host SDK as a native ES module. Development files are excluded by Copier.

[Detailed integration behavior](docs/integration.md) · [Initial validation evidence](artifacts/delivery-evidence/initial-integration/README.md).
