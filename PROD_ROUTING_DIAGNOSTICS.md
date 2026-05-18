# PROD Routing Diagnostics

This document explains how to force a production data pull from VM400 into local artifacts for routing analysis.

Every run writes a Jarvis version marker and test profile metadata, so each dataset is traceable to the exact code version and probes used.

Each run now includes:
- KPI summary
- Regression diff versus previous run (if available)
- Confidence score and pass/fail outcome

Retention is handled automatically: by default only the latest run is kept.

## Script

Use:
- scripts/collect-prod-routing-data.ps1
- scripts/summarize-prod-routing-runs.ps1
- scripts/check-prod-routing-regressions.ps1
- scripts/register-prod-routing-task.ps1

## What the script collects

- GET /health
- GET /v1/stats
- Pre-snapshot: GET /v1/threads and /v1/threads/{threadId}/history
- Optional live probes on POST /v1/ingest
- Post-snapshot: GET /v1/threads and /v1/threads/{threadId}/history (after probes)
- Optional SSH log pull from home-assistant-jarvis-1
- Retries on transient API failures

Outputs are written in:
- artifacts/prod-routing/<timestamp>/

Global tracking files:
- artifacts/prod-routing/latest.json
- artifacts/prod-routing/index.json

Main files:
- jarvis.version.marker.json
- report.json
- analysis block in report.json (kpis, regression, confidence, outcome)
- health.json
- stats.json
- pre-threads.json
- pre-thread-history-<threadId>.json
- post-threads.json
- post-thread-history-<threadId>.json
- probe-*.json
- jarvis.logs.tail900.log
- jarvis.logs.focus.log

## Usage

From Jarvis repo root:

```powershell
./scripts/collect-prod-routing-data.ps1
```

With explicit probe profile:

```powershell
./scripts/collect-prod-routing-data.ps1 -ProbeProfilePath ".\scripts\probe-profiles\routing-probes-v1.json"
```

With explicit host/user and no probes:

```powershell
./scripts/collect-prod-routing-data.ps1 -HostIP 192.168.1.38 -User loic -RunProbes:$false
```

With explicit Jarvis version marker:

```powershell
./scripts/collect-prod-routing-data.ps1 -JarvisVersionMarker "jarvis-prod-hotfix-2026-05-18" -TestProfileVersion "routing-probes-v1"
```

With explicit API key and specific thread:

```powershell
./scripts/collect-prod-routing-data.ps1 -ApiKey "<api-key>" -ThreadId "desktop-v2-..."
```

Skip SSH logs (API-only capture):

```powershell
./scripts/collect-prod-routing-data.ps1 -SkipSshLogs
```

Tune retries and snapshot limits:

```powershell
./scripts/collect-prod-routing-data.ps1 -RetryCount 3 -RetryDelayMs 900 -ThreadsLimit 40 -ThreadHistoryLimit 120
```

Keep the latest 3 runs instead of only one:

```powershell
./scripts/collect-prod-routing-data.ps1 -KeepRuns 3
```

Allow non-blocking runs even if endpoints/probes fail:

```powershell
./scripts/collect-prod-routing-data.ps1 -FailOnEndpointFailure:$false -FailOnCriticalProbeFailure:$false
```

Generate a multi-run summary:

```powershell
./scripts/summarize-prod-routing-runs.ps1 -MaxRuns 10 -OutputFile ".\artifacts\prod-routing\summary.json"
```

Run regression guard (requires at least 2 runs in index):

```powershell
./scripts/check-prod-routing-regressions.ps1 -MaxSuccessRateDropPct 10 -MaxEndpointFailuresIncrease 0 -MaxCriticalProbeFailures 0
```

Register Windows scheduled task for daily collection:

```powershell
./scripts/register-prod-routing-task.ps1 -TaskName "Jarvis-Prod-Routing-Collect" -Schedule Daily -Time "03:30" -KeepRuns 14
```

## Notes

- API key resolution order:
1. -ApiKey parameter
2. API_KEY in .env
3. first entry of API_KEYS in .env

- Probes are real production calls. Disable them with -RunProbes:$false if needed.

- Probe scenarios are versioned outside the collector in:
- scripts/probe-profiles/*.json

- Each run has a Jarvis marker file with:
1. jarvis_version_marker
2. jarvis_version_source
3. jarvis_git_commit and jarvis_git_branch
4. jarvis_package_version
5. test_profile_version and tests[]
6. run_id and schema_version

- Default policy is strict:
1. endpoint failures trigger a failing run
2. critical probe failures trigger a failing run
3. all artifacts are still written before script exits with error

- The log focus file filters lines that contain:
- semantic_router_
- ingest_complete
- mail_followup_
- spotify_deterministic_gate_
- ha_agent_router_
- multi_intent
