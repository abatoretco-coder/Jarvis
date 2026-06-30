# Mutation Confirmations

Write or destructive actions must be represented in the capability registry with `effect: write` or `effect: destructive` and `requiresConfirmation: true`.

## Current behavior

- Read actions can execute directly.
- Calendar `create_event`, `delete_event`, `update_event`, and `remove_from_event` create pending proposals instead of executing immediately.
- Mail and Todo mutations create pending proposals from structured planned actions.
- Pending proposals are persisted in SQLite through `pending_mutations`.
- REST clients can list, confirm, or cancel proposals:
  - `GET /v1/pending-mutations?threadId=...`
  - `POST /v1/pending-mutations/:proposalId/confirm`
  - `POST /v1/pending-mutations/:proposalId/cancel`
- Voice/text confirmation is bound to the active `threadId` and `clientChannel`.
- The user-facing proposal text is conversational: `Tu confirmes ?`
- Technical identifiers stay in `replyMeta` and REST payloads, not in spoken text.

## Natural confirmation replies

Accepted confirmations include short affirmative replies such as:

- `oui`
- `ok`
- `ouais`
- `d'accord`
- `vas-y`
- `c'est bon`
- `fais-le`
- `je confirme`
- `valide`

Accepted cancellations include:

- `non`
- `nan`
- `nope`
- `annule`
- `laisse tomber`
- `pas maintenant`
- `ne fais rien`

## Safety rules

- A wrong explicit proposal ID returns a conflict instead of executing another proposal.
- Confirmation executes the stored structured payload, not a newly planned free-text command.
- Double confirmation is idempotent at repository level.
- New unrelated intent cancels the active pending mutation in the same thread.
- Secrets, OAuth codes, API keys, refresh tokens, calendar IDs and proposal IDs must not be spoken or exposed in natural assistant text.

This keeps transactional operations out of accidental single-turn execution while preserving a conversational UX.
