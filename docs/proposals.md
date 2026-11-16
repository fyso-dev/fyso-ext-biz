# Change proposals for Biz departments

## Finding (2026-11-16)

Fyso Business had no proposal, suggestion or review concept for teams. It had a one-shot publish: `publicar_equipo` (ADR 0126) creates a team at version 1 or publishes the next version when `version_base` is the current one (`version_conflict` otherwise), storing the `omb-team/1` package in the version's `equipo_changelog` entry; `exportar_equipo` returns it. The existing `sugerencias` and `propuesta` code is about objectives, plans and context notes, not teams. Team catalogue screens were retired (ADR 0115), so there is no Biz page for teams. This extension published every local change directly (`teams-sync.cjs` `publish`, with *Publish mine* after a conflict).

## Model

- Biz -> project is one-way. Biz is the source of truth for teams and their names.
- A department with no Biz team yet is published once with `publicar_equipo`: a proposal needs a team to point at, and creating it is not a change to someone else's team. `publish` refuses a linked department (`linked_to_biz`).
- Any later local change, including a rename, is a proposal. Nothing is written back directly.

## Biz contract (fyso-business ADR 0127)

| Tool | Input | Result |
|---|---|---|
| `proponer_cambio_equipo` | `equipo_id`, `version_base`, `paquete` (`omb-team/1`), `mensaje?` | `{propuesta: {id, equipo_id, version_base, estado: "pendiente", ...}}`; `version_conflict` with `version_actual` when the base is stale; nothing published |
| `listar_propuestas_equipo` | `equipo_id?`, `estado?` | `{propuestas: [{id, estado, version_base, motivo, version_resultante, desactualizada, decidida_por, decidida_en, ...}]}` without the package |
| `decidir_propuesta_equipo` | `propuesta_id`, `decision` (`aceptar`/`rechazar`), `motivo?` | admin only; accepting publishes the package as the next version (`version_resultante`); a proposal whose base is no longer current is rejected with motivo `version_conflict` |

Identity of a proposal: `equipo_id` + `version_base`. States: `pendiente` -> `aceptada` | `rechazada`. Biz stores proposals as `equipo_changelog` entries without a version (extra record keys, no schema change). There is no Biz review page: a person decides through their MCP agent, like other Biz decisions.

## Local state and flow

`project/biz-teams.json`, per department keyed by the Biz name: `{equipoId, version, digest, bots, proposal?: {id, digest, base, state, reason?, version?, decidedBy?, decidedAt?, sentAt}}`.

1. Local digest differs from the recorded one -> `propose`. *Send proposal* (`team-propose`) exports the package and calls `proponer_cambio_equipo` on the recorded version (`overwrite` after a conflict: on Biz's current one). The record gets `proposal.state: pending`.
2. `team-sync` reads `listar_propuestas_equipo` for pending proposals and records the decision (`biz: record the Biz decision …`). The panel polls every minute while one is pending.
3. Accepted: Biz's version is `proposal.version` and the local digest is the proposed one -> `pull` (not a conflict). The pull records the new version and drops the proposal.
4. Rejected: `rejected` with the reason. The person pulls the Biz version to discard the change, or edits and proposes again.
5. Name: every sync renames the record to the Biz team's `nombre`. A local department holding the record's bots under another name is `renamed`: *Restore* (`team-rename`) returns the team file with the Biz name for the usual review and apply (the extension never writes `team.yaml`); *Propose* sends the renamed package. When accepted, Biz takes the new name and the record follows it.

Not covered: merging concurrent edits, diffs of a proposal in Biz, withdrawing a pending proposal, notifying the project (it polls).
