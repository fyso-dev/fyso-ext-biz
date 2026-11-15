# Project request dispatch (experimental)

The scheduled workflow polls every five minutes, but is disabled until the project owner creates and versions `project/biz-dispatch.json`:

```json
{"enabled": true, "kind": "bot", "target": "EXACT_NATIVE_BOT_ID"}
```

Use `kind: "room"` with its native channel ID for a room. Select an existing bot or room with access to the `fyso-biz` MCP and its skill. This setting authorizes that target to receive and attempt assigned work; its native approval policy still applies. The file belongs to the project and is never installed or overwritten by this extension. Set `enabled` to `false` to stop new handoffs. The workflow requires this project's explicit OMB port and never discovers a desktop instance.

Only requests with `agenteDestino` exactly equal to the connected Biz identity are delivered. Requests available to any agent are intentionally excluded because another project could also see them. The bot takes the request through Biz, follows its authorization, reports progress and closes or releases it. The history records the chosen bot or room, not which room member performed work. All bots share the OAuth identity; they should sign progress with their bot name. An OMB acknowledgement means only that the handoff was accepted, not that work completed.

A private durable reservation is created **before** each send in `.data/ext/biz/dispatch/`. If the process fails or dies before the acknowledgement, the entry remains `uncertain` and is never resent automatically. Inspect the OMB conversation and Biz request before any recovery; removing the corresponding reservation after verifying that no delivery occurred permits the next poll to retry. Preserve these files across restarts. Losing this local data can allow a duplicate handoff. The send and a Biz action cannot form an atomic transaction, and external effects are not exactly once.

On a confirmed handoff the receipt includes the OMB conversation ID and a deterministic send ID. OMB's send ID deduplicates within a conversation, while `run` creates a new conversation by default; it does not make retries across new conversations safe. A room configured to respond only to mentions may accept the message without starting an agent, so configure its responder and verify the run in OMB.

The Work tab reports explicitly assigned pending requests and recent local handoff states. Available work can still appear after it was sent until a bot takes it. It does not claim completion; consult Biz for authoritative execution and evidence. This path requires integration validation against the pinned OMB and Biz versions; uploading evidence also requires Biz storage to be configured.
