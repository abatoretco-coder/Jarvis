/**
 * semanticRouter.ts — Semantic Router orchestrator
 *
 * Pipeline: text → embedding → scoring → decision → result
 *
 * Phase 1A: runs in shadow mode (logs only, never overrides LLM router).
 * Phase 1B+: accepted_e2 routes will bypass the LLM router entirely.
 */

import type { SemanticRouterInput, SemanticRouteResult } from './semanticRouter.types';
import { SEMANTIC_ROUTES } from './semanticRouteCatalog';
import { getEmbedding } from './embeddingClient';
import { scoreRoutes } from './routeScoring';
import { makeRouteDecision } from './routeDecision';

export type { SemanticRouteResult };

export async function trySemanticRouter(input: SemanticRouterInput): Promise<SemanticRouteResult> {
  const t0 = Date.now();
  const { userText, embeddingConfig, options = {}, multiIntentLikelihood = 0, enabledLevels } = input;

  // Filter catalog by enabled levels if specified
  const routes = enabledLevels
    ? SEMANTIC_ROUTES.filter((r) => enabledLevels.includes(r.level))
    : SEMANTIC_ROUTES;

  if (routes.length === 0) {
    return {
      accepted: false,
      decision: 'fallback_llm',
      top1Score: 0,
      top2Score: 0,
      margin: 0,
      top1Intent: '',
      top2Intent: '',
      confidence: 0,
      fallbackReason: 'no_routes',
      elapsedMs: Date.now() - t0,
    };
  }

  // Step 1: get user embedding
  let embeddingResult: Awaited<ReturnType<typeof getEmbedding>>;
  try {
    embeddingResult = await getEmbedding(userText, embeddingConfig);
  } catch (err) {
    return {
      accepted: false,
      decision: 'fallback_llm',
      top1Score: 0,
      top2Score: 0,
      margin: 0,
      top1Intent: '',
      top2Intent: '',
      confidence: 0,
      fallbackReason: 'embedding_failed',
      elapsedMs: Date.now() - t0,
      debug: { embeddingProvider: embeddingConfig.provider },
    };
  }

  // Step 2: score all routes
  let scoring: Awaited<ReturnType<typeof scoreRoutes>>;
  try {
    scoring = await scoreRoutes(embeddingResult.vector, routes, embeddingConfig);
  } catch (err) {
    return {
      accepted: false,
      decision: 'fallback_llm',
      top1Score: 0,
      top2Score: 0,
      margin: 0,
      top1Intent: '',
      top2Intent: '',
      confidence: 0,
      fallbackReason: 'scoring_failed',
      elapsedMs: Date.now() - t0,
    };
  }

  // Step 3: make decision
  const result = makeRouteDecision(scoring, multiIntentLikelihood, options);

  return {
    ...result,
    elapsedMs: Date.now() - t0,
    debug: {
      ...result.debug,
      cachedEmbedding: embeddingResult.cached,
      embeddingProvider: embeddingConfig.provider,
    },
  };
}
