/**
 * Semantic Router — Phase 1A tests
 *
 * Tests for:
 * 1. cosineSimilarity (routeScoring)
 * 2. makeRouteDecision (routeDecision) — accept/reject logic
 * 3. trySemanticRouter (semanticRouter) — shadow mode, with mocked embedding
 */

import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { cosineSimilarity, clearRouteEmbeddingCache } from '../src/routing/routeScoring';
import { makeRouteDecision } from '../src/routing/routeDecision';
import { clearEmbeddingCache } from '../src/routing/embeddingClient';
import type { RouteScoringResult } from '../src/routing/routeScoring';
import type { SemanticRouteDefinition } from '../src/routing/semanticRouter.types';

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function mockScoredRoute(
  key: string,
  score: number,
  level: SemanticRouteDefinition['level'] = 'E2',
): import('../src/routing/semanticRouter.types').ScoredRoute {
  return {
    routeKey: key,
    score,
    level,
    definition: {
      key,
      level,
      targetAgentId: 'spotify',
      examples: ['example'],
      plannerRequired: false,
    },
  };
}

function mockScoring(overrides: Partial<RouteScoringResult> = {}): RouteScoringResult {
  const top1 = mockScoredRoute('spotify.pause', 0.92);
  const top2 = mockScoredRoute('spotify.play', 0.72);
  return {
    scored: [top1, top2],
    top1,
    top2,
    margin: 0.20,
    cachedRoutes: false,
    routesScored: 20,
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// cosineSimilarity
// ─────────────────────────────────────────────────────────────────────────────

describe('cosineSimilarity', () => {
  it('returns 1.0 for identical vectors', () => {
    const v = [0.1, 0.5, -0.3, 0.7];
    expect(cosineSimilarity(v, v)).toBeCloseTo(1.0);
  });

  it('returns 0.0 for orthogonal vectors', () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0.0);
  });

  it('returns -1.0 for opposite vectors', () => {
    expect(cosineSimilarity([1, 0], [-1, 0])).toBeCloseTo(-1.0);
  });

  it('returns 0.0 for empty vectors', () => {
    expect(cosineSimilarity([], [])).toBe(0);
  });

  it('returns 0.0 for mismatched lengths', () => {
    expect(cosineSimilarity([1, 2], [1, 2, 3])).toBe(0);
  });

  it('returns 0.0 for zero vector', () => {
    expect(cosineSimilarity([0, 0, 0], [1, 0, 0])).toBe(0);
  });

  it('returns correct similarity for realistic vectors', () => {
    // Two vectors with ~80% similarity
    const a = [0.9, 0.1, -0.2, 0.4];
    const b = [0.85, 0.15, -0.18, 0.42];
    const sim = cosineSimilarity(a, b);
    expect(sim).toBeGreaterThan(0.95); // very similar
    expect(sim).toBeLessThanOrEqual(1.0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// makeRouteDecision — accept cases
// ─────────────────────────────────────────────────────────────────────────────

describe('makeRouteDecision — accept', () => {
  it('accepts E2 route when score >= acceptScore and margin >= minMargin', () => {
    const scoring = mockScoring(); // top1=0.92, margin=0.20
    const result = makeRouteDecision(scoring, 0, { acceptScore: 0.84, minMargin: 0.08 });

    expect(result.accepted).toBe(true);
    expect(result.decision).toBe('accepted_e2');
    expect(result.top1Intent).toBe('spotify.pause');
    expect(result.top1Score).toBeCloseTo(0.92);
    expect(result.margin).toBeCloseTo(0.20);
  });

  it('accepts E1 route with decision accepted_e1', () => {
    const top1 = mockScoredRoute('todo.list_tasks', 0.90, 'E1');
    const top2 = mockScoredRoute('todo.list_tasks.today', 0.70, 'E1');
    const scoring = mockScoring({ top1, top2, margin: 0.20, scored: [top1, top2] });
    const result = makeRouteDecision(scoring, 0, { acceptScore: 0.84, minMargin: 0.08 });

    expect(result.accepted).toBe(true);
    expect(result.decision).toBe('accepted_e1');
  });

  it('accepts exactly at acceptScore threshold', () => {
    const top1 = mockScoredRoute('spotify.pause', 0.84);
    const top2 = mockScoredRoute('spotify.play', 0.70);
    const scoring = mockScoring({ top1, top2, margin: 0.14, scored: [top1, top2] });
    const result = makeRouteDecision(scoring, 0, { acceptScore: 0.84, minMargin: 0.08 });

    expect(result.accepted).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// makeRouteDecision — reject cases
// ─────────────────────────────────────────────────────────────────────────────

describe('makeRouteDecision — reject', () => {
  it('rejects when top1 score is below acceptScore', () => {
    const top1 = mockScoredRoute('spotify.pause', 0.75);
    const top2 = mockScoredRoute('spotify.play', 0.60);
    const scoring = mockScoring({ top1, top2, margin: 0.15, scored: [top1, top2] });
    const result = makeRouteDecision(scoring, 0, { acceptScore: 0.84, minMargin: 0.08 });

    expect(result.accepted).toBe(false);
    expect(result.decision).toBe('rejected_low_score');
    expect(result.fallbackReason).toBe('low_score');
  });

  it('rejects when margin is below minMargin', () => {
    const top1 = mockScoredRoute('spotify.pause', 0.88);
    const top2 = mockScoredRoute('spotify.play', 0.85);
    const scoring = mockScoring({ top1, top2, margin: 0.03, scored: [top1, top2] });
    const result = makeRouteDecision(scoring, 0, { acceptScore: 0.84, minMargin: 0.08 });

    expect(result.accepted).toBe(false);
    expect(result.decision).toBe('rejected_low_margin');
    expect(result.fallbackReason).toBe('low_margin');
  });

  it('rejects multi-intent when likelihood exceeds threshold', () => {
    const scoring = mockScoring(); // would otherwise accept
    const result = makeRouteDecision(scoring, 0.7, {
      acceptScore: 0.84,
      minMargin: 0.08,
      multiIntentThreshold: 0.5,
    });

    expect(result.accepted).toBe(false);
    expect(result.decision).toBe('rejected_multi_intent');
  });

  it('rejects when E2 is disabled', () => {
    const scoring = mockScoring(); // E2 route
    const result = makeRouteDecision(scoring, 0, { acceptScore: 0.84, minMargin: 0.08, enableE2: false });

    expect(result.accepted).toBe(false);
    expect(result.decision).toBe('fallback_llm');
  });

  it('rejects when E1 is disabled and route is E1', () => {
    const top1 = mockScoredRoute('todo.list_tasks', 0.90, 'E1');
    const top2 = mockScoredRoute('todo.list_tasks.today', 0.70, 'E1');
    const scoring = mockScoring({ top1, top2, margin: 0.20, scored: [top1, top2] });
    const result = makeRouteDecision(scoring, 0, { acceptScore: 0.84, minMargin: 0.08, enableE1: false });

    expect(result.accepted).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// trySemanticRouter — shadow mode with mocked embeddings
// ─────────────────────────────────────────────────────────────────────────────

// Mock the embedding client to avoid real HTTP calls
jest.mock('../src/routing/embeddingClient', () => ({
  getEmbedding: jest.fn(),
  clearEmbeddingCache: jest.fn(),
}));

import { getEmbedding } from '../src/routing/embeddingClient';
import { trySemanticRouter } from '../src/routing/semanticRouter';

const mockedGetEmbedding = getEmbedding as jest.MockedFunction<typeof getEmbedding>;

const MOCK_EMBEDDING_CONFIG = {
  baseUrl: 'https://api.openai.com/v1',
  model: 'text-embedding-3-small',
};

describe('trySemanticRouter', () => {
  beforeEach(() => {
    clearRouteEmbeddingCache();
    clearEmbeddingCache();
    mockedGetEmbedding.mockReset();
  });

  it('returns fallback_llm when embedding fails', async () => {
    mockedGetEmbedding.mockRejectedValue(new Error('connection refused'));

    const result = await trySemanticRouter({
      userText: 'pause la musique',
      embeddingConfig: MOCK_EMBEDDING_CONFIG,
    });

    expect(result.accepted).toBe(false);
    expect(result.fallbackReason).toBe('embedding_failed');
  });

  it('accepts spotify.pause with high confidence embedding', async () => {
    // We'll mock all embeddings — the route embeddings for examples and the user embedding.
    // Use identical vectors to get cosine similarity = 1.0 for the matching route.
    const PAUSE_VECTOR = [1, 0, 0, 0, 0];
    const OTHER_VECTOR = [0, 1, 0, 0, 0];

    mockedGetEmbedding.mockImplementation(async (text: string) => {
      // User query → returns PAUSE_VECTOR
      if (text === 'pause la musique') {
        return { vector: PAUSE_VECTOR, cached: false, model: 'text-embedding-3-small', elapsedMs: 5 };
      }
      // Spotify pause examples → PAUSE_VECTOR (high match)
      if (
        text === 'pause' ||
        text === 'pause la musique' ||
        text === 'arrête le son' ||
        text === 'coupe la musique' ||
        text === 'mets en pause'
      ) {
        return { vector: PAUSE_VECTOR, cached: false, model: 'text-embedding-3-small', elapsedMs: 5 };
      }
      // All other examples → OTHER_VECTOR (low match)
      return { vector: OTHER_VECTOR, cached: false, model: 'text-embedding-3-small', elapsedMs: 5 };
    });

    const result = await trySemanticRouter({
      userText: 'pause la musique',
      embeddingConfig: MOCK_EMBEDDING_CONFIG,
      options: { acceptScore: 0.84, minMargin: 0.08 },
      enabledLevels: ['E2'],
    });

    expect(result.accepted).toBe(true);
    expect(result.decision).toBe('accepted_e2');
    expect(result.top1Intent).toBe('spotify.pause');
    expect(result.top1Score).toBeGreaterThan(0.84);
    expect(result.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(result.debug?.cachedEmbedding).toBe(false);
  });

  it('rejects ambiguous input with low margin', async () => {
    // Two routes get nearly identical similarity → low margin → rejected
    const SIMILAR_VECTOR = [0.7, 0.7, 0.1, 0, 0];

    mockedGetEmbedding.mockResolvedValue({
      vector: SIMILAR_VECTOR,
      cached: false,
      model: 'text-embedding-3-small',
      elapsedMs: 5,
    });

    const result = await trySemanticRouter({
      userText: 'mets du jazz et donne-moi les actus',
      embeddingConfig: MOCK_EMBEDDING_CONFIG,
      options: { acceptScore: 0.5, minMargin: 0.08 }, // low acceptScore to isolate margin rejection
      enabledLevels: ['E2'],
    });

    // When all embeddings are identical, margin = 0 → rejected_low_margin
    expect(result.accepted).toBe(false);
    expect(result.decision).toBe('rejected_low_margin');
  });

  it('includes elapsedMs in result', async () => {
    mockedGetEmbedding.mockRejectedValue(new Error('offline'));

    const result = await trySemanticRouter({
      userText: 'test',
      embeddingConfig: MOCK_EMBEDDING_CONFIG,
    });

    expect(typeof result.elapsedMs).toBe('number');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Phase 1A fixture cases — simple intent mapping
// ─────────────────────────────────────────────────────────────────────────────

describe('Phase 1A fixtures — acceptance criteria', () => {
  beforeEach(() => {
    clearRouteEmbeddingCache();
    mockedGetEmbedding.mockReset();
  });

  const FIXTURES = [
    { text: 'pause la musique', expectedIntent: 'spotify.pause' },
    { text: 'morceau suivant', expectedIntent: 'spotify.next' },
    { text: 'quelle température à la maison', expectedIntent: 'weather.current_temperature' },
    { text: 'météo à Paris demain', expectedIntent: 'search.news.external_weather' },
    { text: 'quelles sont les actus du jour', expectedIntent: 'search.news.current_news' },
  ];

  for (const fixture of FIXTURES) {
    it(`top1 intent for "${fixture.text}" maps to ${fixture.expectedIntent}`, async () => {
      // Build vectors: user vector and matching route vector are identical.
      // Other route examples get a random-ish orthogonal vector.
      const matchVector = [1, 0, 0, 0, 0];
      const noMatchVector = [0, 1, 0, 0, 0];

      const { SEMANTIC_ROUTES } = await import('../src/routing/semanticRouteCatalog');
      const matchRoute = SEMANTIC_ROUTES.find((r) => r.key === fixture.expectedIntent);
      if (!matchRoute) throw new Error(`Route not found: ${fixture.expectedIntent}`);
      const matchExamples = new Set(matchRoute.examples);

      mockedGetEmbedding.mockImplementation(async (text: string) => {
        const isMatch = text === fixture.text || matchExamples.has(text);
        return {
          vector: isMatch ? matchVector : noMatchVector,
          cached: false,
          model: 'text-embedding-3-small',
          elapsedMs: 1,
        };
      });

      const result = await trySemanticRouter({
        userText: fixture.text,
        embeddingConfig: MOCK_EMBEDDING_CONFIG,
        options: { acceptScore: 0.84, minMargin: 0.08 },
      });

      expect(result.top1Intent).toBe(fixture.expectedIntent);
      expect(result.accepted).toBe(true);
    });
  }

  const REJECT_FIXTURES = [
    'mets du jazz et donne-moi les actus',
    "rappelle-moi demain d'appeler Paul et regarde si j'ai un mail de lui",
  ];

  for (const text of REJECT_FIXTURES) {
    it(`rejects multi-intent phrase: "${text}"`, async () => {
      const someVector = [1, 0, 0, 0, 0];
      mockedGetEmbedding.mockResolvedValue({
        vector: someVector,
        cached: false,
        model: 'text-embedding-3-small',
        elapsedMs: 1,
      });

      const result = await trySemanticRouter({
        userText: text,
        embeddingConfig: MOCK_EMBEDDING_CONFIG,
        options: { acceptScore: 0.84, minMargin: 0.08 },
        multiIntentLikelihood: 0.8, // force multi-intent
      });

      expect(result.accepted).toBe(false);
      expect(result.decision).toBe('rejected_multi_intent');
    });
  }
});
