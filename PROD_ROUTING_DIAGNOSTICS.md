# PROD Routing Diagnostics

This document explains how to force a production data pull from VM400 into local artifacts for routing analysis.

## Script

Use:
- scripts/collect-prod-routing-data.ps1

## What the script collects

- GET /health
- GET /v1/stats
- GET /v1/threads?limit=20
- GET /v1/threads/{threadId}/history?limit=50 (latest thread or explicit ThreadId)
- Optional live probes on POST /v1/ingest
- Optional SSH log pull from home-assistant-jarvis-1

Outputs are written in:
- artifacts/prod-routing/<timestamp>/

Main files:
- report.json
- health.json
- stats.json
- threads.json
- thread-history-<threadId>.json
- probe-*.json
- jarvis.logs.tail900.log
- jarvis.logs.focus.log

## Usage

From Jarvis repo root:

```powershell
./scripts/collect-prod-routing-data.ps1
```

With explicit host/user and no probes:

```powershell
./scripts/collect-prod-routing-data.ps1 -HostIP 192.168.1.38 -User loic -RunProbes:$false
```

With explicit API key and specific thread:

```powershell
./scripts/collect-prod-routing-data.ps1 -ApiKey "<api-key>" -ThreadId "desktop-v2-..."
```

Skip SSH logs (API-only capture):

```powershell
./scripts/collect-prod-routing-data.ps1 -SkipSshLogs
```

## Notes

- API key resolution order:
1. -ApiKey parameter
2. API_KEY in .env
3. first entry of API_KEYS in .env

- Probes are real production calls. Disable them with -RunProbes:$false if needed.

- The log focus file filters lines that contain:
- semantic_router_
- ingest_complete
- mail_followup_
- spotify_deterministic_gate_
- ha_agent_router_
- multi_intent
