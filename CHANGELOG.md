# Changelog

Versions are the Git tags of this repository. Earlier releases are described in their tags and pull requests.

## v0.5.0

- People of the Biz project: with Biz-managed access, the people Fyso Biz assigns to the project (`listar_personas_proyecto`) are mirrored into the human-requests people directory as Dagu wiki pages `fyso-people/<uuid>` marked `"source":"biz"`, with a stable UUID per organization and Biz user. Missing people are created, renamed people updated and people Biz no longer lists removed; people added by hand are never touched, and a failed Biz or wiki read changes nothing.
- The sync runs from the connection hook, hourly through the new `ext-biz-people-sync` workflow and on demand with `mise run biz:people-sync` (both installed only with managed access).
- `GET /api/ext/biz/status` reports `people_synced`, `people_count` and `people_sync` with managed access.
- Requires a Fyso Business that offers `listar_personas_proyecto`, and fyso-ext-human-requests v0.2.0 or later to show synced people read-only.
