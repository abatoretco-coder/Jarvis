# Routing Overview

This document explains how Jarvis chooses an execution path for each request.

> Relecture: architecture-review/00_REVIEW_PLAN_CHECKLIST.md

## 1. Routing Priority (authoritative order)

1. Explicit Spotify contract wins first.
- If payload contains domain=spotify with valid action, Jarvis executes spotify directly.
- This is a first-class deterministic branch of the main workflow, not a hidden shortcut.

2. Semantic router runs for text requests when enabled.
- E2 and E1 acceptance depends on score, margin, and multi-intent guard.
- Accepted routes can be executed live depending on activation allowlists.

3. Orchestrator LLM router resolves specialized targets.
- Targets can include spotify, search, weather, todo, mail, executors, or others from HA_AGENT_MAP.

4. Specialized task execution runs.
- Spotify/search/todo/mail/weather/executors are attempted as specialized handlers.

5. General HA fallback only if needed.
- Used when routing failed, no usable target remained, or specialized tasks produced no usable output.

## 2. Decision Components

## Semantic Router
- Embedding scoring over semantic route catalog.
- Decision checks:
  - level enabled
  - multi-intent threshold
  - accept score threshold
  - score margin threshold

References:
- src/routing/semanticRouter.ts
- src/routing/routeDecision.ts
- src/routing/semanticRouteCatalog.ts

## Orchestrator Router
- Structured LLM output selecting target agents with confidence.
- Confidence threshold filters targets.
- Supports spotify direct action+slots payload when present.

References:
- src/conversation/orchestratorRouter.ts
- src/routes/ingest.ts

## 3. Specialized Execution Paths

## Spotify
- explicit_contract, router_direct, or music_planner.
- Single spotify result returns enriched spotify payload.

## Search
- Direct execution, bypassing Home Assistant.
- E2 dispatcher for fast routes; E1 dispatcher for deep routes.

## Weather
- Local weather from HA states.
- Deterministic local reply first for simple questions.
- OpenAI weather synthesis fallback for complex local questions.

## Todo / Mail
- Direct execution with external APIs, bypassing Home Assistant.
- Routed by key or semantic E1 dispatcher.

## Executors
- Timer has direct deterministic execution path.
- Other executor intents call HA specialized conversation agent.

## 4. Multi-agent Behavior

1. Multiple specialized targets can run in parallel.
2. If exactly one specialized result exists:
- return it directly.
3. If multiple results exist:
- synthesize into one coherent response.
4. If all specialized results fail or are null:
- fallback to general HA.

References:
- src/routes/ingest.ts
- src/conversation/orchestratorRouter.ts

## 5. Response Metadata

## Spotify payload shape
- replyMeta.kind=spotify
- replyMeta.routeKey=spotify.<action>
- music.routing.path in {explicit_contract, router_direct, music_planner}
- music.execution.status in {success, need_clarification, error}

## Non-spotify payload shape
- replyMeta.kind by domain (search, todo, mail, executor, weather, general)
- replyMeta.source indicates semantic/router/fallback path
- fallbackReason=general_fallback when applicable

Reference:
- src/routes/ingest.ts

## 6. Key Guardrails

1. No hidden fallback chains between unrelated domains.
2. Search agents bypass Home Assistant by design.
3. Explicit spotify contract is never overridden by router decisions.
4. General HA is fallback only, not a parallel pre-warmed path.
