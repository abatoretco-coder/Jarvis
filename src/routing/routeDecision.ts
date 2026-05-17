/**
 * routeDecision.ts — Accept/reject logic for the Semantic Router
 *
 * Given scored routes and thresholds, decides whether to accept a semantic
 * route or fall back to the LLM router.
 *
 * Phase 1A: decision logic is computed but never overrides the LLM router.
 */

import type {
  SemanticRouteDecision,
  SemanticRouteResult,
  SemanticRouterOptions,
} from './semanticRouter.types';
import { DEFAULT_SEMANTIC_ROUTER_OPTIONS } from './semanticRouter.types';
import type { RouteScoringResult } from './routeScoring';

export function makeRouteDecision(
  scoring: RouteScoringResult,
  multiIntentLikelihood: number,
  options: SemanticRouterOptions,
): SemanticRouteResult {
  const opts = { ...DEFAULT_SEMANTIC_ROUTER_OPTIONS, ...options };
  const { top1, top2, margin } = scoring;

  const top1Score = top1?.score ?? 0;
  const top2Score = top2?.score ?? 0;
  const top1Intent = top1?.routeKey ?? '';
  const top2Intent = top2?.routeKey ?? '';

  // Level filtering
  const routeLevel = top1?.level;
  if (routeLevel === 'E2' && !opts.enableE2) {
    return buildRejected('fallback_llm', top1Score, top2Score, margin, top1Intent, top2Intent, 'level_disabled');
  }
  if (routeLevel === 'E1' && !opts.enableE1) {
    return buildRejected('fallback_llm', top1Score, top2Score, margin, top1Intent, top2Intent, 'level_disabled');
  }
  if (routeLevel === 'D0' && !opts.enableD0) {
    return buildRejected('fallback_llm', top1Score, top2Score, margin, top1Intent, top2Intent, 'level_disabled');
  }

  // Multi-intent check
  if (multiIntentLikelihood > opts.multiIntentThreshold) {
    return buildRejected('rejected_multi_intent', top1Score, top2Score, margin, top1Intent, top2Intent, 'multi_intent');
  }

  // Score threshold
  if (top1Score < opts.acceptScore) {
    return buildRejected('rejected_low_score', top1Score, top2Score, margin, top1Intent, top2Intent, 'low_score');
  }

  // Margin threshold
  if (margin < opts.minMargin) {
    return buildRejected('rejected_low_margin', top1Score, top2Score, margin, top1Intent, top2Intent, 'low_margin');
  }

  // Accept
  const level = top1?.level ?? 'E2';
  let decision: SemanticRouteDecision;
  if (level === 'D0') decision = 'accepted_d0';
  else if (level === 'E2') decision = 'accepted_e2';
  else decision = 'accepted_e1';

  return {
    accepted: true,
    decision,
    matchedRoute: top1?.definition,
    top1Score,
    top2Score,
    margin,
    top1Intent,
    top2Intent,
    confidence: top1Score,
    debug: {
      cachedRoutes: scoring.cachedRoutes,
      routesScored: scoring.routesScored,
    },
  };
}

function buildRejected(
  decision: SemanticRouteDecision,
  top1Score: number,
  top2Score: number,
  margin: number,
  top1Intent: string,
  top2Intent: string,
  fallbackReason: string,
): SemanticRouteResult {
  return {
    accepted: false,
    decision,
    top1Score,
    top2Score,
    margin,
    top1Intent,
    top2Intent,
    confidence: top1Score,
    fallbackReason,
  };
}
