# Fyso Biz extension

Independent Copier extension for the Fyso Agentic Framework: a business-context page, the native Fyso Biz MCP connection, and a dedicated **Biz Partner** bot with OKR/KPI/palanca context.

## Requirements

- A generated Fyso project with **panel extension API v1**, extension connection hooks and Bot Architect. These framework capabilities are introduced by [framework PR #14](https://github.com/fyso-dev/agentic-framework/pull/14).
- Access to this private repository through your normal GitHub credentials.
- A Fyso Biz personal MCP token. The token owner's permissions scope the connection.

Installation refuses an older framework before writing extension slots. Check `framework/panel/extension-api.json` in the generated project.

## Install

```sh
# From the official catalog (latest release tag):
mise run ext:add biz -- --defaults
# Or pin this release explicitly:
mise run ext:add gh:fyso-dev/fyso-ext-biz -- --vcs-ref v0.1.0 --defaults

mise run secrets
# Add BOT_FYSO_BIZ_TOKEN to the encrypted YAML.
mise run down
mise run up
mise run biz:check
```

Default origin: `https://fyso.biz`; MCP endpoint: `/api/mcp`. To choose another origin, add `-d biz_url=https://example.org` when installing.

The extension contributes its own tab/page through `extensions/biz/pages/overview.yaml` and compiled assets in `extensions/biz/panel/`. It appears only while installed, at `/#/extensions/biz/overview`, using the host's theme/language and optional panel SDK.

After the token is configured and services are available, its connection hook creates **Biz Partner** through native Bot Architect plan/apply. It uses an offered model, project-root MCP access, business instructions, `ask` approval and computer off. Reconnection reuses the owned bot without overwriting customizations or duplicating it. A collision with an unrelated bot fails safely.

## Updates and removal

```sh
mise run ext:update biz -- --defaults
mise run ext:remove biz
```

Copier records the source and tag in `.copier-answers.ext-biz.yml`. Updates follow the framework's normal clean-tree lifecycle. Removal hides the page and deletes extension slots; it preserves the project-owned bot, runtime data and encrypted secret. Delete the bot explicitly through Bot Architect if desired.

## Privacy and behavior

The page reads native Biz context, KPIs, objectives/KRs, objective visions, palancas and requests through process-side Dagu workflows. Tokens stay in sops/environment, not browser storage, URLs or workflow parameters. Project gateway users share the token owner's scope. Native bots retain instructed mutation tools under Biz authorization; requests, execution and acceptance are separate decisions.

No secrets, organization data or test credentials belong in this repository. The initial integration evidence uses synthetic screenshots; real authenticated reads were checked separately.

## Development

Runtime installs use committed compiled assets and need no frontend build. For authoring, point to a framework checkout/project with API v1 and its pinned panel dependencies installed:

```sh
export FYSO_FRAMEWORK_ROOT=/path/to/framework-checkout
mise run build
mise run test
python3 -m unittest discover -s tests -p 'test_packaging.py'
```

The build reuses that framework's pinned TypeScript/Vite tools and SDK types. It emits only extension-owned assets; the browser imports the host SDK as a native ES module. Development files are excluded by Copier.

[Detailed integration behavior](docs/integration.md) · [Initial validation evidence](artifacts/delivery-evidence/initial-integration/README.md).
