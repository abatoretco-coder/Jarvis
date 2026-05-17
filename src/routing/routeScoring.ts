/**
 * routeScoring.ts — Cosine similarity scoring for semantic routes
 *
 * Computes similarity between a user embedding and the canonical example
 * embeddings for every route in the catalog.
 *
 * Phase 1A: supports shadow-mode evaluation.
 */

import type { SemanticRouteDefinition, ScoredRoute } from './semanticRouter.types';
import { getEmbedding } from './embeddingClient';
import type { EmbeddingClientConfig } from './semanticRouter.types';

// ─────────────────────────────────────────────────────────────────────────────
// Cosine similarity
// ─────────────────────────────────────────────────────────────────────────────

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    normA += a[i]! * a[i]!;
    normB += b[i]! * b[i]!;
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

// ─────────────────────────────────────────────────────────────────────────────
// Route-level embedding cache (pre-computed per model)
// Maps: `${provider}:${model}:${routeKey}` → average embedding vector
// ─────────────────────────────────────────────────────────────────────────────

const routeEmbeddingCache = new Map<string, number[]>();

export function clearRouteEmbeddingCache(): void {
  routeEmbeddingCache.clear();
}

/**
 * Returns the cached centroid embedding for a route, or computes it by
 * averaging the embeddings of all its example phrases.
 */
async function getRouteEmbedding(
  route: SemanticRouteDefinition,
  config: EmbeddingClientConfig,
): Promise<number[]> {
  const cacheKey = `${config.provider}:${config.model}:${route.key}`;
  const cached = routeEmbeddingCache.get(cacheKey);
  if (cached) return cached;

  // Embed all examples and average them
  const vectors = await Promise.all(
    route.examples.map((ex) => getEmbedding(ex, config).then((r) => r.vector)),
  );

  const dims = vectors[0]?.length ?? 0;
  if (dims === 0) throw new Error(`route_embedding_empty:${route.key}`);

  const centroid = new Array<number>(dims).fill(0);
  for (const v of vectors) {
    for (let i = 0; i < dims; i++) centroid[i]! += v[i]!;
  }
  for (let i = 0; i < dims; i++) centroid[i]! /= vectors.length;

  routeEmbeddingCache.set(cacheKey, centroid);
  return centroid;
}

// ─────────────────────────────────────────────────────────────────────────────
// Score all routes
// ─────────────────────────────────────────────────────────────────────────────

export type RouteScoringResult = {
  scored: ScoredRoute[];
  top1: ScoredRoute | undefined;
  top2: ScoredRoute | undefined;
  margin: number;
  cachedRoutes: boolean;
  routesScored: number;
};

export async function scoreRoutes(
  userVector: number[],
  routes: SemanticRouteDefinition[],
  config: EmbeddingClientConfig,
): Promise<RouteScoringResult> {
  const allCached = routes.every((r) =>
    routeEmbeddingCache.has(`${config.provider}:${config.model}:${r.key}`)
  );

  const scored: ScoredRoute[] = await Promise.all(
    routes.map(async (route) => {
      const routeVec = await getRouteEmbedding(route, config);
      const score = cosineSimilarity(userVector, routeVec);
      return { routeKey: route.key, score, level: route.level, definition: route };
    }),
  );

  // Sort descending by score
  scored.sort((a, b) => b.score - a.score);

  const top1 = scored[0];
  const top2 = scored[1];
  const margin = top1 && top2 ? top1.score - top2.score : top1?.score ?? 0;

  return {
    scored,
    top1,
    top2,
    margin,
    cachedRoutes: allCached,
    routesScored: routes.length,
  };
}
