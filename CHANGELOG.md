# Changelog

Versions are the Git tags of this repository. Earlier releases are described in their tags and pull requests.

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
