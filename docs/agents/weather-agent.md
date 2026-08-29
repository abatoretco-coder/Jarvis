# Weather Agent

## Scope
Local weather from Home Assistant state snapshot (temperature, humidity, precipitation, conditions).

## Detection
1. Semantic E2 routes: weather.current_temperature, weather.current_humidity, weather.current_precipitation, weather.current_conditions.
2. Router target weather from orchestrator routing.
3. Local weather heuristics can inject weather target for local phrasing.
4. External city weather phrasing can be redirected to search.news.external_weather.

## Routing Path
1. Local weather stays on weather agent when intent looks local and single-intent.
2. External weather goes through search agent path.
3. Weather agent is executed as a specialized direct task in ingest flow.

## Execution
1. Build local weather snapshot from HA states.
2. Try deterministic weather reply for simple current-state questions.
3. Fallback to Ollama synthesis for more complex local weather wording.
4. Home Assistant states `unknown` and `unavailable` are treated as missing facts and are never verbalized as weather conditions.

## Response Construction
1. Weather returns plain assistant text.
2. Domain set to weather for voice formatting.
3. In multi-agent requests, weather text can be merged with other outputs.

## Proactive Context Cache
1. Keep local HA weather snapshot warm for temperature, humidity, precipitation and current conditions.
2. Prepared answers can cover simple local weather questions when the snapshot is fresh.
3. External city/weather questions still route through search instead of reusing local weather cache.

## Main References
- src/routes/ingest.ts
- src/weather/weatherSnapshot.ts
- src/weather/deterministicWeatherReply.ts
- src/routing/semanticRouteCatalog.ts
- docs/PROACTIVE_CONTEXT_CACHE.md
