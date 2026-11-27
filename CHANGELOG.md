# Changelog

Versions are the Git tags of this repository. Earlier releases are described in their tags and pull requests.

## v0.7.1

- Fix: `copier update` failed with "Update the framework before enabling Biz-managed access" when `biz_access_organization` was set. Copier renders the old version in a temporary directory without `framework/panel/*.json`, so the missing access API read as version 0. The validator now refuses a missing or too-low access API only when the host's `extension-api.json` is present (a real host); the replay is tolerated.
- Fix: with Biz-managed access configured but no profile session, the Biz screen hid the Access and Setup tabs, so a project that never connected had no way to reach Connect. The Setup tab now shows whenever managed access is configured (`GET /api/ext/biz/profile/status` answers 200 only then), with a **Connect Fyso Biz** action that starts the profile login and explains the steps (sign in, consent, preview and warning before anything changes). An old grant (`reauthorize_required`) shows the same action. The Access tab appears once connected; without managed access nothing changes.
- Fix: the sign-in page CSP was `form-action 'self'`, and Chrome applies it to the form's redirect chain, so the 303 to Biz was blocked and the person stayed on the page. It now allows the validated Biz origin (`form-action 'self' <Biz origin>`, never a wildcard).

## v0.7.0

- Biz-managed setup: the organization's framework setup, published to Biz by an administrator as a distribution, reaches every member. New **Setup** tab: connect (profile login `framework_access`, age key registered with Biz, `dist:plan` plus the policy removals shown as a warning, snapshot, confirm), cancel (disconnect, nothing changed), disconnect and, for administrators, publish (`dist:publish`).
- "Compatible" mode removes only what the policy forbids: extensions and MCP servers outside the setup and the catalog (`framework:extensions:*`, `framework:mcp_servers:*`), own bots without `framework:bots:create`, and the teams of departments the person no longer holds.
- New workflow `ext-biz-sync` (every 15 minutes, `mise run biz:setup:sync`): same etag does nothing; a change is applied after a snapshot and announced in the panel. Administrators publish again when recipients are pending or changed. A failed, unexpectedly empty or `reauthorize_required` answer pauses the sync and removes nothing.
- `frozen: true` after a setup was delivered: read-only (as `cuidado`) in the panel policy and the MCP policy, sync stops, the secrets the distribution delivered are removed from `secrets.enc.yaml`. `frozen` on a project that never received a setup is shown as "no access yet" and changes nothing. Unfrozen when Biz answers `frozen: false`.
- The MCP policy now enforces the policy: a `cuidado` or frozen person may only call read tools.
- The mise environment sets `FYSO_DIST_BIZ_URL`, `FYSO_DIST_BIZ_ORGANIZATION` and `FYSO_DIST_BIZ_TOKEN_CMD` (`profile-token.cjs`) for the framework's Biz transport. Requires agentic-framework with the Biz transport (PR #131) and a Biz with the managed-setup endpoints (fyso-business ADR 0134).
- Fix: the managed-teams reauthorize guard now reads the access report with the profile token (it sent the agent grant), and a failed read blocks the destructive steps (unflagging, re-recording departments) instead of allowing them.
- Found by the end-to-end test against a fake Biz: the publisher registers its own age key before its first publish (a first publish with secrets failed), a project that never started snapshots by committing only, unfreezing installs the setup again so the removed secrets return, a second freeze does not leave an already removed secret pending, and a sync that installed nothing no longer reports replaced files.

## v0.6.0

- Access by department: `biz_access_project` is optional. `biz_access_organization` alone enables managed access (panel and MCP policy, template slots, feedback, managed-teams delivery); `project` is sent to Biz only when set. Installs that still set it work unchanged.
- `GET /oauth/framework-access` is read for the new optional `admin`, `departments` and `policy`; a Biz without them behaves as before. `GET /api/panel-access` returns them too.
- Managed teams come from `departamentos_framework` when no project is set; with `biz_access_project` set the legacy `proyectos_framework` path is kept unchanged.
- `reauthorize_required` from Biz (old OAuth grants) is no longer read as having no departments: the **Your departments** tab asks to reconnect Fyso Biz and the managed-teams delivery skips without changing anything.
- New panel tab **Your departments**: the person's departments with role, and their framework-freedom level.
- With a policy present, MCP server management also requires `framework:mcp_servers:catalog`.
- Template slot file names now depend on `biz_access_organization`.

## v0.5.2

- People sync without managed access: the new optional answer `biz_people_project` (a Fyso Biz project UUID, env `FYSO_BIZ_PEOPLE_PROJECT`) syncs that project's people over the project's own Biz connection. It does not enable Biz-managed access, does not need the framework access API and does not change the panel login: `panel-access.caddy`, `authorize.caddy`, `mcp-authorize` and the Workflows and feedback pages remain tied to `biz_access_project`.
- `biz_people_project` defaults to `biz_access_project`, so managed installs keep syncing unchanged; with it empty, `FYSO_BIZ_ACCESS_PROJECT` is still used.
- Without `biz_access_organization`, the organization that scopes the person ids is read from Biz (`proyectos_framework` → `organizacion`). Ids are derived exactly as in v0.5.0, so pages already synced are kept. Without a valid organization the run fails closed with `organization_unavailable`.
- The `ext-biz-people-sync` workflow, the `biz:people-sync` task, the connection-hook run and `people_synced`/`people_count`/`people_sync` in `GET /api/ext/biz/status` now follow the people project instead of managed access. Managed-teams delivery still requires managed access.

## v0.5.1

- Managed access: answering a human request from the panel (`POST /api/dagu/dag-runs/<workflow>/<run>/human-tasks/…/complete`, `…/push-back`, `…/resume`) now requires `workflow:<workflow>:run`; it was always refused before.
- Managed access: Dagu's wiki (`/api/dagu/wiki`, `/api/dagu/wiki/page`), used by the human-requests People directory, requires `action:wiki:read` to read and `action:wiki:write` to create, edit or delete; it was always refused before.

## v0.5.0

- People of the Biz project: with Biz-managed access, the people Fyso Biz assigns to the project (`listar_personas_proyecto`) are mirrored into the human-requests people directory as Dagu wiki pages `fyso-people/<uuid>` marked `"source":"biz"`, with a stable UUID per organization and Biz user. Missing people are created, renamed people updated and people Biz no longer lists removed; people added by hand are never touched, and a failed Biz or wiki read changes nothing.
- The sync runs from the connection hook, hourly through the new `ext-biz-people-sync` workflow and on demand with `mise run biz:people-sync` (both installed only with managed access).
- `GET /api/ext/biz/status` reports `people_synced`, `people_count` and `people_sync` with managed access.
- Requires a Fyso Business that offers `listar_personas_proyecto`, and fyso-ext-human-requests v0.2.0 or later to show synced people read-only.
