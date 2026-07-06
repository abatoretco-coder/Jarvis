# Executors Agent

## Scope
Home automation executor intents (timers and other HA execution commands).

## Detection
1. Semantic E1 executor routes target executors agent.
2. Router LLM can target executors from HA_AGENT_MAP.
3. Timer wording has a dedicated direct detector in ingest flow.

## Routing Path
1. If timer pattern is detected, Jarvis tries direct timer execution first.
2. Otherwise executors goes through specialized Home Assistant conversation call.
3. If executors route is not usable, flow can fall back to general agent.

## Execution
1. Timer direct path:
   - parse duration from text
   - locate timer entity
   - call timer.start service via HA
2. Generic executors path:
   - callHomeAssistantConversation with executors agent id

## Response Construction
1. Returns execution acknowledgement or clear error text.
2. Domain set to executor for voice formatting.
3. Can be merged in multi-agent synthesis responses.

## Proactive Context Cache
1. Keep selected read-only HA entity states warm: timers, lights, covers, scenes and other high-value home state.
2. Use snapshots for state questions like remaining timer time or whether a light is on.
3. Never call HA services from proactive refresh; execution commands still run only through the live executor path.

## Main References
- src/routes/ingest.ts
- src/routing/semanticRouteCatalog.ts
- src/conversation/ConversationService.ts
- docs/PROACTIVE_CONTEXT_CACHE.md
