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

## Graph Reliability Rules
1. Collection reads follow only HTTPS `@odata.nextLink` URLs on `graph.microsoft.com`, without credentials, custom ports, fragments, redirects, or non-v1.0 paths.
2. Pagination is bounded to 50 pages and 2,000 items. Missing or malformed collection JSON is an error, not an empty result.
3. Reads may be retried once after a network failure, 429, 502, 503, or 504. `Retry-After` is honored with a bounded delay.
4. Mutations are never retried after a network error, timeout, 408, or 5xx because their result may be unknown. A POST is confirmed only when Graph returns an object with an identifier.
5. A Graph 401 invalidates the cached access token and permits one refresh followed by one replay of the refused workflow. A 403 is not treated as token expiry.
6. Exact duplicate task titles are treated as ambiguous, including within the same list. No mutation is sent until a unique task is identified.
7. Multi-list reads retain successful lists and explicitly label a partial result. If every list fails, the operation fails instead of reporting an empty task set.

## Dates And Recurrence
1. Due and start dates remain date-only Graph values in UTC.
2. Reminder clock times are sent as Paris-local values using the Microsoft Graph timezone `Romance Standard Time`, preserving the intended local time across daylight-saving changes.
3. Calendar dates, reminder times, recurrence intervals, weekdays, month numbers, and day numbers are validated before any mutation is sent.
4. Recurrence start dates default to the current date in `Europe/Paris` when no due date exists.

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
