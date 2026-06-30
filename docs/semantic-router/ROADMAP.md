# Semantic Router Roadmap

Status: runtime partially live, documentation catch-up required.
Last reviewed: 2026-06-30.

This file is the current roadmap source of truth. Older phase notes in `src/routing/INDEX.md` describe the initial plan and are no longer an accurate implementation status.

## Current State

Implemented:
- Semantic route catalog with E2 and E1 routes.
- Embedding/scoring/decision pipeline.
- E2 dispatcher for search/weather/spotify-oriented routes.
- E1 dispatcher hooks for Spotify, Search, Todo, Mail, Calendar and executor domains.
- Capability registry guard for transactional actions.
- Persistent pending mutations with REST confirm/cancel endpoints.
- Natural confirmation replies for pending mutations (`oui`, `ok`, `je confirme`, `non`, etc.).
- Render policy module under `src/routing/render/*` with policies, types and single-result renderer tests.

Still incomplete:
- Runtime execution paths still build many user-facing strings inline in `src/routes/ingest.ts` and domain agents.
- `ActionExecutionResult` adapters are not consistently used by Spotify/Search/Weather/Todo/Mail/Calendar/Executors.
- Multi-result synthesis does not yet route through `llm_multi_synthesis` from the render policy.
- Documentation around routing and confirmations was behind the actual runtime until this pass.

## Next Work

1. Integrate render service at runtime.
   - Add adapters from each domain executor result to `ActionExecutionResult`.
   - Apply `renderSingleExecutionResult` before voice formatting.
   - Keep raw service text available for debug metadata.

2. Finish multi-result rendering.
   - Add `renderMultipleExecutionResults` with explicit `llm_multi_synthesis` behavior.
   - Preserve per-agent source metadata separately from synthesized speech text.
   - Add tests for search + another agent, with sources retained.

3. Reduce inline response strings.
   - Move repeated confirmation/error/clarification phrasing into render policy or focused helpers.
   - Keep transactional proposal text human-first and keep IDs in `replyMeta` only.

4. Harden activation docs and config.
   - Document exact production values for `SEMANTIC_ROUTER_*`.
   - Keep high-risk E1 actions disabled unless guarded by capability confirmation.

5. Add production UAT coverage.
   - Calendar delete/update/remove proposal and confirmation.
   - Mail/Todo proposal and confirmation.
   - Voice-style affirmative/negative confirmation replies.
   - Dashboard Calendar degraded states.

## Non-goals

- Do not rewrite `POST /v1/ingest` wholesale.
- Do not bypass pending mutations for write/destructive actions.
- Do not expose proposal IDs, calendar IDs, tokens or route internals in spoken/user-facing text.
