# Spotify Agent

## Scope
Spotify controls and music playback workflows.

## Detection
1. Explicit contract: incoming payload has domain=spotify and a valid action.
2. Semantic E2 direct routes: pause, play, next, previous, now_playing, list_devices, clear_queue.
3. Semantic E1 planner routes: search, search_and_play, queue_add, transfer, add_to_playlist, volume_set.
4. Router direct shortcut: if LLM router returns spotify action plus usable slots, Jarvis can skip planner.

## Routing Path
1. explicit_contract: direct execution from API payload.
2. router_direct: direct execution from router output.
3. music_planner: planner resolves action and slots before execution.

## Execution
1. Entry point: executeSpotifyCapability.
2. Per-action logic in spotifyExecutor includes no-op checks and deterministic error messages.
3. Device-sensitive actions may fail with contextual errors when no active Spotify device exists.

## Response Construction
1. Single spotify result uses buildSpotifyIngestPayload.
2. replyMeta.kind is spotify.
3. music.routing.path is explicit_contract, router_direct, or music_planner.
4. music.execution.status mirrors success, need_clarification, or error.

## Main References
- src/routes/ingest.ts
- src/spotify/spotifyExecutor.ts
- src/spotify/musicRoutingMatrix.ts
- src/spotify/contracts.ts
