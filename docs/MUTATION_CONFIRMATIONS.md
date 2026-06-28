# Mutation Confirmations

Natural-language write or destructive actions should be represented in the capability registry with `effect: write` or `effect: destructive` and `requiresConfirmation: true`.

Current Calendar behavior:

- Read actions can execute directly.
- `calendar.create_event` returns a confirmable proposal from `/v1/ingest` instead of creating the event immediately.
- The response uses stable `replyMeta.kind = "calendar"` and carries `semanticDecision: "confirmation_required"`.

This keeps transactional operations out of accidental single-turn execution while preserving existing read workflows.
