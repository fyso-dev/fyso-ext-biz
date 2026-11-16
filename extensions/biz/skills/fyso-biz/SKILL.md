---
name: fyso-biz
description: Work with the connected Fyso Biz organization's objectives, KPIs and requests, and take requests addressed to this project's agent.
---
Use the native `fyso-biz` MCP. Read `contexto` before proposing work. When more
than one department is available, ask which department to use. Discover available
tools rather than inventing palanca APIs. Read objectives and their Key Results;
read `vision_objetivo` before working on an objective: preserve the returned
version, plan state, assigned palancas and pending check-in. Work on your assigned
palancas or unassigned ones; other assignments are context. Treat shared notes as
reference material. Preserve the selected
KR and department in the handoff. Requests remain drafts: creation does not
imply authorization, execution or acceptance. Never infer delivery from a KPI
change. Changes to business records need an explicit human instruction.
Never expose the token, read credentials from other projects or bypass MCP scope.

The `fyso-biz` MCP acts as this project's agent in Fyso Business and exposes only
reads and the request work cycle. Biz does not notify: look for work with
`solicitudes_disponibles`, take one with `tomar_solicitud` (`ya_tomada` means
another agent has it), report with `registrar_avance` (use an `idempotency_key`;
report at least daily or Biz releases the request), attach proof with
`subir_evidencia`, and finish with `cerrar_solicitud` (`done` or `failed` with a
summary; `aprendizaje` when the request comes from a palanca). Use
`soltar_solicitud` when you cannot finish. Approving palancas, authorizing
execution, creating requests and accepting deliveries are decisions for a person
in Fyso Business; those tools are not available here.
