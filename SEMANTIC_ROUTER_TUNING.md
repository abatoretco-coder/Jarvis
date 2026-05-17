# Semantic Router Tuning Guide

## Scope
This document defines how to tune semantic-router thresholds in live mode for:
- baseline semantic acceptance (E2/E1)
- high-risk E1 activation
- rollout safety analysis from logs

## Runtime Knobs
- `SEMANTIC_ROUTER_ACCEPT_SCORE` (default `0.84`)
- `SEMANTIC_ROUTER_MIN_MARGIN` (default `0.08`)
- `SEMANTIC_ROUTER_E1_ACTIVATION_ENABLED` + `SEMANTIC_ROUTER_ACTIVATED_E1_ROUTES`
- `SEMANTIC_ROUTER_E1_HIGH_RISK_ACTIVATION_ENABLED`
- `SEMANTIC_ROUTER_ACTIVATED_E1_HIGH_RISK_ROUTES`
- `SEMANTIC_ROUTER_HIGH_RISK_ACCEPT_SCORE` (default `0.90`)
- `SEMANTIC_ROUTER_HIGH_RISK_MIN_MARGIN` (default `0.12`)

## Recommended Rollout Policy
1. Start in shadow mode and collect at least a few hundred `semantic_router_result` events.
2. Enable E2 live only for deterministic/safe allowlisted routes.
3. Enable E1 live progressively by route families:
   - read-only routes
   - limited reversible mutations
   - high-risk routes under dedicated high-risk gate
4. Enable high-risk routes only with stricter thresholds and explicit allowlist.

## Log Events To Monitor
- Base semantic decision:
  - `semantic_router_result`
  - `semantic_router_fallback_llm`
- E1 live:
  - `semantic_router_e1_candidate`
  - `semantic_router_e1_live_attempt`
  - `semantic_router_e1_live_handled`
  - `semantic_router_e1_live_fallback_llm`
  - `semantic_router_e1_live_error`
- E1 high-risk:
  - `semantic_router_e1_high_risk_blocked_activation_disabled`
  - `semantic_router_e1_high_risk_blocked_not_allowlisted`
  - `semantic_router_e1_high_risk_blocked_thresholds`
  - `semantic_router_e1_high_risk_live_attempt`
  - `semantic_router_e1_high_risk_live_handled`
  - `semantic_router_e1_high_risk_live_error`

## Daily Tuning Workflow
1. Compute per-route acceptance and fallback rates.
2. Flag routes where accepted semantic decisions frequently fallback in execution.
3. Tighten thresholds for noisy routes:
   - increase accept score by `+0.01` to `+0.03`
   - increase minimum margin by `+0.01` to `+0.03`
4. Loosen thresholds only when:
   - fallback rate is low
   - post-route action correctness is validated
5. For high-risk routes, prefer allowlist reduction before threshold loosening.

## Practical Threshold Bands
- Baseline E1/E2:
  - `accept_score` usually in `[0.82, 0.88]`
  - `min_margin` usually in `[0.06, 0.10]`
- High-risk E1:
  - `accept_score` usually in `[0.90, 0.95]`
  - `min_margin` usually in `[0.12, 0.18]`

## Exit Criteria Before Expanding Allowlist
- Stable error rate on semantic live routes for several days
- No critical wrong-action incidents on activated routes
- High-risk blocked events explainable by config intent (not random drift)
- Integration tests cover new routes and fallback behavior
