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

## Download an agent team

Panel → Fyso Biz → *Agent teams* lists the teams in the connection's scope (`listar_equipos`). *Download* reads the team's export (`exportar_equipo`, format `fyso-equipo/v1`) and:

1. writes `project/bots/biz/<team>/souls/<agent>.md` (soul, instructions and team prompt), `skills/<skill>/SKILL.md` and `source.json` (team id and version), scans them with gitleaks and commits them (`biz: import team <slug> v<version>`);
2. proposes `project/bots/team.yaml` with one bot per agent and runs the framework's own `fyso-bots-plan` preview;
3. on *Apply team*, runs `fyso-bots-apply`, which snapshots, applies to OpenMausBot and commits the team file.

Only configuration travels. New bots use the engine of the project's first non-chief bot, `approval: ask` and the team's skills; local changes to model, approval or tools survive a later download. Downloading again updates the bots this team created, removes agents retired in Biz, and refuses to take over a bot with the same name that did not come from the team. Connectors per agent are not part of the export yet.

The extension contributes its own tab/page through `extensions/biz/pages/overview.yaml` and compiled assets in `extensions/biz/panel/`. It appears only while installed, at `/#/extensions/biz/overview`, using the host's theme/language and optional panel SDK.

After installation and once services are available, its connection hook creates **Biz Partner** through native Bot Architect plan/apply. It uses an offered model, project-root MCP access, business instructions, `ask` approval and computer off. Reconnection reuses the owned bot without overwriting customizations or duplicating it. A collision with an unrelated bot fails safely.

## Updates and removal

```sh
mise run ext:update biz -- --defaults
mise run ext:remove biz
```

Copier records the source and tag in `.copier-answers.ext-biz.yml`. Updates follow the framework's normal clean-tree lifecycle. Removal hides the page and deletes extension slots; it preserves the project-owned bot, runtime data and encrypted secret. Delete the bot explicitly through Bot Architect if desired.

## Privacy and behavior

The page reads native Biz context, KPIs, objectives/KRs, objective visions, palancas, requests and teams through process-side Dagu workflows. Tokens stay in `.data/ext/biz/` or sops, never in browser storage, URLs or workflow parameters. Project gateway users share the connected account's scope.

Known limit: the `fyso-biz` MCP server that bots and coding agents load from `.mcp.json` still authenticates with `BOT_FYSO_BIZ_TOKEN`. Bots that call Biz directly need that token until the OAuth grant is exposed to them. Native bots retain instructed mutation tools under Biz authorization; requests, execution and acceptance are separate decisions.

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
