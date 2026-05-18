# Jarvis Scripts Index

## Core Ops (kept)

- analyze-routing-evidence.ps1: Analyze one production routing run and extract routing KPIs/risk flags.
- collect-prod-routing-data.ps1: Collect production routing artifacts (health, stats, threads, logs, probes).
- summarize-prod-routing-runs.ps1: Summarize recent routing runs from artifacts.
- check-prod-routing-regressions.ps1: Compare latest and previous run and fail on configured regression thresholds.
- register-prod-routing-task.ps1: Register a scheduled task that runs the production routing collector.

## Build/Dev Utility (kept)

- check-capabilities.ts: Check that declared capabilities match executor-handled action types.
- generate-api-keys.ts: Generate API keys for multi-client setup.
- oauth-helper.ts: OAuth URL/exchange helper for Microsoft and Google integrations.
- spotify_pkce_refresh_token.mjs: Get Spotify refresh token via PKCE flow.
- preview-replies.ts: Preview reply-builder outputs for manual validation.

## Targeted Diagnostics (kept)

- diag-music-planner.ps1: Trigger one ingest music request and inspect recent relevant backend logs.
- verify-nl-agent-actions.ps1: Batch-check natural language music requests and correlate actions from logs.
- verify-public-search-playlists.ps1: Verify public search + playlist behavior over ingest and logs.

## Profiles

- probe-profiles/routing-probes-v1.json: Probe profile used by production routing collector.

## Removed as Redundant

- ../simple-test.sh: Removed (duplicated conversation-window checks with less coverage).
- ../test-window.sh: Removed (overlaps with test-conversation-window.sh).

## Canonical Conversation Window Tests

- ../test-conversation-window.ps1
- ../test-conversation-window.sh
