# Search Agent

## Scope
External web/news/deep research answers (not Home Assistant conversation execution).

## Detection
1. Key-based detection from HA_AGENT_MAP via isSearchAgentKey.
2. Semantic E2 accepted routes for search.news and search.web quick paths.
3. Semantic E1 accepted routes for search.deep analysis paths.

## Routing Path
1. Direct search execution bypasses Home Assistant.
2. E2 route dispatcher handles live accepted search routes.
3. E1 dispatcher handles deep search routes.

## Execution
1. callSearchAgent is invoked with per-agent config from SEARCH_AGENTS_MAP.
2. Agent config chooses model, temperature, max tokens, and recency filters.
3. External weather route is a dedicated search.news.external_weather variant.

## Response Construction
1. Search returns plain assistant text.
2. Domain set to search for voice formatting.
3. In multi-agent requests, text can be synthesized with other agent outputs.

## Main References
- src/search/agents.ts
- src/routes/ingest.ts
- src/routing/routeDispatcher.ts
- src/routing/semanticRouteCatalog.ts
