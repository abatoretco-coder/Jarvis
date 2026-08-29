# Culture Intelligence — Phase 5

## Boundary

Agora remains the factual discovery engine. Jarvis stores the local profile,
feedback, favorites and proactive notification history, then performs deterministic
personal reranking. Ollama receives only the bounded candidates and their computed
reasons for presentation; it never selects entity IDs or computes the score.

The persistent identity is `user_id`. It is currently a trusted-client identity,
not multi-user authentication. A central resolver validates and normalizes it;
clients that do not provide it use `CULTURE_DEFAULT_PROFILE_ID` (`local-default` by
default). `threadId` remains only conversation identity. A ResultSet and a pending
reset record their profile ID so neither can mutate a different local profile.

## Persistent data

The existing Jarvis SQLite database gains four additive tables:

- `culture_preference_profiles`: explicit weights, exclusions and proactive opt-in;
- `culture_feedback`: bounded explicit and implicit signals;
- `culture_saved_entities`: local snapshots plus source references;
- `culture_proactive_notifications`: notification fingerprints and timestamps.

Feedback is limited to 2,000 rows per profile and defaults to 730 days of retention.
Implicit signals decay at scoring time; explicit profile weights remain stable until
the user changes or deletes them.

## Deterministic ranking

For personalized discovery Jarvis asks Agora for up to 50 factually compatible
candidates. It combines Agora order with type, tag, venue, daypart, weekday, price,
distance and novelty contributions. Recent repetition and explicit dislikes are
penalties. Explicit query filters remain authoritative because they are applied by
Agora before personalization.

`CULTURE_EXPLORATION_RATIO` defaults to `0.25`. Exploration candidates still satisfy
the factual query and receive `exploration_pick`; no random or LLM-based ID choice is
used. Cold-start profiles preserve Agora's ranking and diversification.

## Internal API

All routes use the existing Jarvis `/v1` API-key protection:

- `GET /v1/culture/profile`
- `GET /v1/culture/profile/export`
- `GET /v1/culture/favorites`
- `DELETE /v1/culture/favorites/{entityType}/{entityId}`
- `DELETE /v1/culture/profile/preferences/{kind}/{key}`
- `PUT /v1/culture/profile/proactive`
- `POST /v1/culture/profile/reset` with `confirm: true`
- `POST /v1/culture/proactive/evaluate`
- `POST /v1/culture/proactive/ack`

The proactive runtime gate is disabled by default. A notification requires the
runtime gate, profile opt-in, fresh Agora facts, a score above the configured
threshold, no explicit rejection, no matching previous fingerprint and an elapsed
cooldown. Evaluation is read-only: it returns a stable fingerprint, and only an
idempotent delivery ACK records the displayed candidate and starts the cooldown.

Favorite API snapshots are marked `currentAvailability: not_refreshed`. Conversational
favorite listing refreshes facts through Agora before claiming a future occurrence;
if the primary Agora ID disappears, Jarvis tries exact ID, exact provenance, then a
deterministic multi-signal confidence match (title, type, categories, venue,
coordinates, source compatibility and date). Title equality alone is insufficient.
A historical snapshot is never reported as current.

## Privacy

Profile and feedback rows remain in Jarvis SQLite. Jarvis sends only geographic,
temporal and explicit discovery filters to Agora, and Agora alone owns provider
credentials. The full profile and feedback history are never sent to Agora,
providers or Ollama. Global profile reset requires explicit confirmation.
