/**
 * embeddingClient.ts — Embedding vector client
 *
 * Supports Ollama (local) and OpenAI (cloud) embedding providers.
 * Includes a simple in-memory LRU cache to avoid redundant API calls.
 *
 * Phase 1A: used by the Semantic Router in shadow mode.
 */

import type { EmbeddingClientConfig } from './semanticRouter.types';

// ─────────────────────────────────────────────────────────────────────────────
// LRU Cache (simple bounded map, FIFO eviction)
// ─────────────────────────────────────────────────────────────────────────────

const CACHE_MAX = 512;
const embeddingCache = new Map<string, number[]>();

function cacheGet(key: string): number[] | undefined {
  return embeddingCache.get(key);
}

function cacheSet(key: string, value: number[]): void {
  if (embeddingCache.size >= CACHE_MAX) {
    // Evict oldest entry
    const firstKey = embeddingCache.keys().next().value;
    if (firstKey !== undefined) embeddingCache.delete(firstKey);
  }
  embeddingCache.set(key, value);
}

export function clearEmbeddingCache(): void {
  embeddingCache.clear();
}

// ─────────────────────────────────────────────────────────────────────────────
// Core embedding fetch
// ─────────────────────────────────────────────────────────────────────────────

export type EmbeddingResult = {
  vector: number[];
  cached: boolean;
  provider: string;
  model: string;
  elapsedMs: number;
};

export async function getEmbedding(
  text: string,
  config: EmbeddingClientConfig,
): Promise<EmbeddingResult> {
  const cacheKey = `${config.provider}:${config.model}:${text}`;
  const cached = cacheGet(cacheKey);
  if (cached) {
    return { vector: cached, cached: true, provider: config.provider, model: config.model, elapsedMs: 0 };
  }

  const t0 = Date.now();
  const timeoutMs = config.timeoutMs ?? 5000;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    let vector: number[];

    if (config.provider === 'ollama') {
      vector = await fetchOllamaEmbedding(text, config, controller.signal);
    } else {
      vector = await fetchOpenAiEmbedding(text, config, controller.signal);
    }

    cacheSet(cacheKey, vector);
    return {
      vector,
      cached: false,
      provider: config.provider,
      model: config.model,
      elapsedMs: Date.now() - t0,
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Ollama provider
// ─────────────────────────────────────────────────────────────────────────────

async function fetchOllamaEmbedding(
  text: string,
  config: EmbeddingClientConfig,
  signal: AbortSignal,
): Promise<number[]> {
  const base = config.baseUrl.replace(/\/$/, '');
  const response = await fetch(`${base}/api/embeddings`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: config.model, prompt: text }),
    signal,
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`embedding_ollama_http_${response.status}: ${body.slice(0, 200)}`);
  }

  const data = (await response.json()) as { embedding?: number[] };
  const vector = data.embedding;
  if (!Array.isArray(vector) || vector.length === 0) {
    throw new Error('embedding_ollama_empty_vector');
  }
  return vector;
}

// ─────────────────────────────────────────────────────────────────────────────
// OpenAI provider
// ─────────────────────────────────────────────────────────────────────────────

async function fetchOpenAiEmbedding(
  text: string,
  config: EmbeddingClientConfig,
  signal: AbortSignal,
): Promise<number[]> {
  const base = config.baseUrl.replace(/\/$/, '');
  const response = await fetch(`${base}/embeddings`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${config.apiKey ?? ''}`,
    },
    body: JSON.stringify({ model: config.model, input: text }),
    signal,
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`embedding_openai_http_${response.status}: ${body.slice(0, 200)}`);
  }

  const data = (await response.json()) as { data?: Array<{ embedding?: number[] }> };
  const vector = data.data?.[0]?.embedding;
  if (!Array.isArray(vector) || vector.length === 0) {
    throw new Error('embedding_openai_empty_vector');
  }
  return vector;
}
