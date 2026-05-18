/**
 * embeddingClient.ts � Embedding vector client (OpenAI only)
 *
 * Calls the OpenAI embeddings API.
 * Includes a simple in-memory LRU cache to avoid redundant API calls.
 */

import type { EmbeddingClientConfig } from './semanticRouter.types';

// -----------------------------------------------------------------------------
// LRU Cache (simple bounded map, FIFO eviction)
// -----------------------------------------------------------------------------

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

// -----------------------------------------------------------------------------
// Core embedding fetch
// -----------------------------------------------------------------------------

export type EmbeddingResult = {
  vector: number[];
  cached: boolean;
  model: string;
  elapsedMs: number;
};

export type BatchEmbeddingResult = {
  vectors: number[][];
  model: string;
  elapsedMs: number;
  cachedCount: number;
  fetchedCount: number;
};

const OPENAI_EMBEDDING_BATCH_MAX = 96;

type PendingTextGroup = {
  text: string;
  positions: number[];
};

function chunkArray<T>(items: T[], size: number): T[][] {
  if (size <= 0) return [items];
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

export async function getEmbeddings(
  texts: string[],
  config: EmbeddingClientConfig,
): Promise<BatchEmbeddingResult> {
  const normalizedTexts = texts.map((t) => String(t ?? ''));
  const vectors = new Array<number[]>(normalizedTexts.length);
  const pendingGroups = new Map<string, PendingTextGroup>();
  let cachedCount = 0;

  normalizedTexts.forEach((text, idx) => {
    const cacheKey = `${config.model}:${text}`;
    const cached = cacheGet(cacheKey);
    if (cached) {
      vectors[idx] = cached;
      cachedCount += 1;
      return;
    }

    const existing = pendingGroups.get(text);
    if (existing) {
      existing.positions.push(idx);
      return;
    }
    pendingGroups.set(text, { text, positions: [idx] });
  });

  if (pendingGroups.size === 0) {
    return {
      vectors: vectors.map((v) => v ?? []),
      model: config.model,
      elapsedMs: 0,
      cachedCount,
      fetchedCount: 0,
    };
  }

  const t0 = Date.now();
  const timeoutMs = config.timeoutMs ?? 5000;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const pendingList = Array.from(pendingGroups.values());
    let fetchedCount = 0;

    const chunks = chunkArray(pendingList, OPENAI_EMBEDDING_BATCH_MAX);
    for (const chunk of chunks) {
      const chunkTexts = chunk.map((entry) => entry.text);
      const chunkVectors = await fetchOpenAiEmbeddings(chunkTexts, config, controller.signal);
      if (chunkVectors.length !== chunk.length) {
        throw new Error('embedding_openai_batch_mismatch');
      }

      chunk.forEach((entry, idx) => {
        const vector = chunkVectors[idx];
        if (!vector || vector.length === 0) {
          throw new Error('embedding_openai_empty_vector');
        }
        const cacheKey = `${config.model}:${entry.text}`;
        cacheSet(cacheKey, vector);
        entry.positions.forEach((pos) => {
          vectors[pos] = vector;
        });
        fetchedCount += entry.positions.length;
      });
    }

    const missing = vectors.findIndex((v) => !Array.isArray(v) || v.length === 0);
    if (missing >= 0) {
      throw new Error('embedding_openai_batch_incomplete');
    }

    return {
      vectors: vectors.map((v) => v ?? []),
      model: config.model,
      elapsedMs: Date.now() - t0,
      cachedCount,
      fetchedCount,
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

export async function getEmbedding(
  text: string,
  config: EmbeddingClientConfig,
): Promise<EmbeddingResult> {
  const t0 = Date.now();
  const cacheKey = `${config.model}:${String(text ?? '')}`;
  const cachedVector = cacheGet(cacheKey);
  const wasCached = Boolean(cachedVector);
  const batch = await getEmbeddings([text], config);
  const vector = batch.vectors[0] ?? [];
  if (!Array.isArray(vector) || vector.length === 0) {
    throw new Error('embedding_openai_empty_vector');
  }
  if (wasCached) {
    return { vector: cachedVector ?? vector, cached: true, model: config.model, elapsedMs: 0 };
  }
  return {
    vector,
    cached: false,
    model: config.model,
    elapsedMs: Date.now() - t0,
  };
}

// -----------------------------------------------------------------------------
// OpenAI provider
// -----------------------------------------------------------------------------

async function fetchOpenAiEmbeddings(
  texts: string[],
  config: EmbeddingClientConfig,
  signal: AbortSignal,
): Promise<number[][]> {
  const base = config.baseUrl.replace(/\/$/, '');
  const response = await fetch(`${base}/embeddings`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${config.apiKey ?? ''}`,
    },
    body: JSON.stringify({ model: config.model, input: texts }),
    signal,
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`embedding_openai_http_${response.status}: ${body.slice(0, 200)}`);
  }

  const data = (await response.json()) as { data?: Array<{ embedding?: number[]; index?: number }> };
  const rows = Array.isArray(data.data) ? data.data : [];
  if (rows.length !== texts.length) {
    throw new Error('embedding_openai_batch_size_mismatch');
  }

  const sorted = [...rows].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
  const vectors = sorted.map((row) => row.embedding ?? []);
  if (vectors.some((v) => !Array.isArray(v) || v.length === 0)) {
    throw new Error('embedding_openai_empty_vector');
  }
  return vectors;
}
