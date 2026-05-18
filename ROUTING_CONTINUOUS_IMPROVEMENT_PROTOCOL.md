# Routing Continuous Improvement Protocol

This protocol defines an evidence-first loop for improving Jarvis routing quality and latency using real production behavior.

## Goal

Use real production traces (requests, route decisions, outcomes, logs, latency) to continuously improve:
- routing correctness
- routing determinism
- response latency

## Evidence Collection (Production)

Run from Jarvis root:

```powershell
./scripts/collect-prod-routing-data.ps1 -RunProbes:$false -KeepRuns 14 -ThreadsLimit 80 -ThreadHistoryLimit 250
```

When validating deployment behavior with controlled traffic:

```powershell
./scripts/collect-prod-routing-data.ps1 -RunProbes:$true -KeepRuns 14
```

## Required Artifacts per Run

Inside artifacts/prod-routing/<runId>/:
- report.json
- pre-threads.json
- pre-thread-history-<threadId>.json
- jarvis.logs.focus.log
- stats.json
- jarvis.version.marker.json

## Routing Decision Trace Contract

The backend must emit ingest_routing_trace for each routed request.

Required fields:
- router_status: fulfilled/rejected
- router_reason or router_error
- router_targets_raw
- router_targets_final
- local_weather_candidate
- local_weather_injected
- local_weather_search_removed
- multi_intent_likelihood

## Automated Evidence Analysis

Analyze the latest run:

```powershell
./scripts/analyze-routing-evidence.ps1
```

Analyze a specific run and save output:

```powershell
./scripts/analyze-routing-evidence.ps1 -RunId 20260518-221026-09886d1a -OutputFile .\artifacts\prod-routing\routing-analysis.json
```

## Weekly Improvement Loop

1. Collect production evidence.
2. Run evidence analysis.
3. Identify top regressions by user impact:
- wrong route (e.g., local weather sent to external search)
- router timeout fallback frequency
- partial multi-intent execution
4. Produce code-level actions in priority order.
5. Implement and run routing tests.
6. Deploy and collect a post-deploy run.
7. Compare with previous run and keep only measurable improvements.

## Routing KPIs

Track these KPIs continuously:
- router_abort_rate = router_abort / router_start
- weather_misroute_rate (derived from traces and thread-history)
- multi_intent_partial_rate (derived from thread-history + traces)
- ingest_p95_ms

## Release Gate (Routing)

A routing change should not be promoted when one of these conditions is true:
- router_abort_rate increases versus previous stable run
- ingest_p95_ms regresses beyond threshold
- weather_misroute_rate increases
- critical multi-intent path quality regresses

## Notes

- Prefer deterministic local weather handling when no explicit external location is requested.
- Keep request-level routing traces stable and machine-parseable.
- Favor evidence from real user traffic over synthetic probes for final decisions.
