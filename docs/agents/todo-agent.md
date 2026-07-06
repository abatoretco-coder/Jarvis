# Todo Agent

## Scope
Task management through Microsoft To Do / Graph APIs.

## Detection
1. Key-based detection from HA_AGENT_MAP using isTodoAgentKey.
2. Semantic E1 todo routes can dispatch directly through e1RouteDispatcher.
3. Router LLM can also return todo target.

## Routing Path
1. Direct specialized execution (bypass Home Assistant).
2. E1 accepted route -> dispatchAcceptedE1Route -> callTodoAgent.

## Execution
1. callTodoAgent validates env and plans action via OpenAI planner.
2. Planner output is translated to Graph operations.
3. Deterministic period inference is applied for list_tasks when period is omitted.

## Response Construction
1. Returns operation text (created, listed, checked, deleted, etc.).
2. Domain set to todo for voice formatting.
3. May be synthesized with other agent responses in multi-target requests.

## Proactive Context Cache
1. Keep today, overdue, next tasks, important tasks and list names warm.
2. Use fresh snapshots for "tasks today", "overdue" and "next task" questions.
3. Mutations can use cached task candidates, but creation/update/delete/complete still execute only after the normal action path and required confirmations.

## Main References
- src/todo/todoAgent.ts
- src/routes/ingest.ts
- src/routing/e1RouteDispatcher.ts
- docs/PROACTIVE_CONTEXT_CACHE.md
