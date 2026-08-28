import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import Fastify, { type FastifyInstance } from 'fastify';

import type { Env } from '../src/env';
import { registerIngestRoute } from '../src/routes/ingest';
import type { AppDeps } from '../src/server';

const source = {
  provider: 'scare', externalId: 'show', sourceUrl: null, fetchedAt: '2026-08-27T08:00:00.000Z',
  sourceModifiedAt: null, freshness: 'fresh', sourceType: 'open_data',
};

function candidate(id: string, title: string, hour: number, occurrenceId = `occ_${id}`, venueName = `Cinéma ${title}`) {
  return {
    item: { id, type: 'movie', title, summary: `Synopsis de ${title}`, categories: ['drama'], attributes: {} },
    occurrence: {
      id: occurrenceId, startsAt: `2026-08-27T${hour}:30:00.000Z`, endsAt: null, status: 'scheduled',
      price: null, isFree: null, bookingUrl: null, attributes: { version: 'VOSTFR' },
    },
    venue: { id: `venue_${occurrenceId}`, name: venueName, distanceKm: 2 }, source, rankReasons: ['nearby'],
  };
}

const candidates = [
  candidate('item_aaaaaaaaaaaaaaaaaaaaaaaa', 'Film A', 17),
  candidate('item_bbbbbbbbbbbbbbbbbbbbbbbb', 'Film B', 18),
  candidate('item_cccccccccccccccccccccccc', 'Film C', 19),
];

function makeEnv(dbPath: string): Env {
  return {
    HA_BASE_URL: undefined,
    HA_TOKEN: undefined,
    CONVERSATION_DB_PATH: dbPath,
    CONVERSATION_RECENT_MESSAGES: 10,
    AGORA_BASE_URL: 'http://agora:8092',
    AGORA_API_TOKEN: 'a'.repeat(32),
    AGORA_TIMEOUT_MS: 100,
    CULTURE_HOME_LATITUDE: 48.85,
    CULTURE_HOME_LONGITUDE: 2.35,
    CULTURE_DEFAULT_RADIUS_KM: 15,
    AGORA_HOME_RADIUS_KM: 15,
    OPENAI_TIMEOUT_MS: 100,
    OLLAMA_BASE_URL: 'http://ollama:11434/v1',
    OLLAMA_MODEL: 'qwen3:8b',
    LIMIT_K: 10,
    LIMIT_M: 20,
    HA_AGENT_MAP: '',
    OAUTH_REFRESH_TOKEN_STORE_PATH: join(tmpdir(), 'jarvis-culture-oauth-test.json'),
  } as unknown as Env;
}

function makeDeps(env: Env): AppDeps {
  return {
    env,
    ha: { getStates: async () => [] } as AppDeps['ha'],
    spotifyWebApi: { isConfigured: () => false } as AppDeps['spotifyWebApi'],
  };
}

function itemResponse(id: string, title: string) {
  return {
    data: {
      id, type: 'movie', title, originalTitle: null, summary: `Synopsis de ${title}`, description: null,
      categories: ['drama'], contributors: [], durationMinutes: 100, imageUrl: null, imageCredit: null,
      attributes: {}, source,
      occurrences: [{
        id: `occ_${id}`, itemId: id, venueId: `venue_${id}`, startsAt: '2026-08-28T18:30:00.000Z',
        endsAt: null, timezone: 'Europe/Paris', status: 'scheduled', price: null, isFree: null,
        bookingUrl: null, attributes: { version: 'VOSTFR' },
        venue: { id: `venue_${id}`, name: `Cinéma ${title}`, latitude: 48.86, longitude: 2.34, distanceKm: 2 }, source,
      }],
    },
  };
}

describe('Culture through /v1/ingest', () => {
  let app: FastifyInstance;

  test('keeps a single Culture dispatch block after merge reconciliation', () => {
    const ingestSource = readFileSync(resolve(process.cwd(), 'src/routes/ingest.ts'), 'utf8');
    expect(ingestSource.match(/const inferredCulture = inferCultureRequest/gu)).toHaveLength(1);
    expect(ingestSource.match(/selectedResult: referencedCultureResult/gu)).toHaveLength(1);
  });

  beforeEach(() => {
    app = Fastify({ logger: false });
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await app.close();
  });

  test('routes a factual request to Agora and resolves the second item on the same thread', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'jarvis-culture-ingest-'));
    registerIngestRoute(app, makeDeps(makeEnv(join(tempDir, 'conversation.sqlite'))));
    const fetchMock = jest.spyOn(global, 'fetch').mockImplementation(async (input) => {
      const url = new URL(String(input));
      if (url.pathname === '/v1/discover') {
        return new Response(JSON.stringify({
          data: candidates,
          meta: {
            generatedAt: '2026-08-27T09:00:00.000Z', stale: false, partial: false, nextCursor: null,
            providers: [{ source: 'scare', status: 'fresh', lastSuccessAt: '2026-08-27T08:00:00.000Z' }],
          },
        }), { status: 200 });
      }
      if (url.pathname.includes('item_bbbbbbbbbbbbbbbbbbbbbbbb')) {
        return new Response(JSON.stringify(itemResponse('item_bbbbbbbbbbbbbbbbbbbbbbbb', 'Film B')), { status: 200 });
      }
      return new Response('not found', { status: 404 });
    });

    const first = await app.inject({
      method: 'POST', url: '/v1/ingest', payload: { threadId: 'culture-conversation', text: 'Quels films passent ce soir ?' },
    });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ threadId: 'culture-conversation', replyMeta: { kind: 'culture', source: 'agora' } });
    expect(first.json<{ responseText: string }>().responseText).toContain('Film B');
    const discoverUrl = new URL(String(fetchMock.mock.calls[0]?.[0]));
    expect(discoverUrl.pathname).toBe('/v1/discover');
    expect(discoverUrl.searchParams.get('lat')).toBe('48.85');
    expect(discoverUrl.searchParams.get('radiusKm')).toBe('15');

    const second = await app.inject({
      method: 'POST', url: '/v1/ingest', payload: { threadId: 'culture-conversation', text: 'Le deuxième, il parle de quoi ?' },
    });
    expect(second.statusCode).toBe(200);
    expect(second.json<{ responseText: string }>().responseText).toContain('Synopsis de Film B');
    const itemCall = fetchMock.mock.calls.find(([url]) => String(url).includes('/v1/items/item_bbbbbbbbbbbbbbbbbbbbbbbb'));
    expect(itemCall).toBeDefined();
    const itemUrl = new URL(String(itemCall?.[0]));
    expect(itemUrl.searchParams.get('lat')).toBe(discoverUrl.searchParams.get('lat'));
    expect(itemUrl.searchParams.get('lon')).toBe(discoverUrl.searchParams.get('lon'));
    expect(itemUrl.searchParams.get('radiusKm')).toBe(discoverUrl.searchParams.get('radiusKm'));
    expect(itemUrl.searchParams.get('from')).toBe(discoverUrl.searchParams.get('from'));
    expect(itemUrl.searchParams.get('to')).toBe(discoverUrl.searchParams.get('to'));
  });

  test('keeps distinct showtime identity and resolves the displayed second occurrence without a broad item query', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'jarvis-culture-showtimes-'));
    registerIngestRoute(app, makeDeps(makeEnv(join(tempDir, 'conversation.sqlite'))));
    const showtimes = [
      candidate('item_aaaaaaaaaaaaaaaaaaaaaaaa', 'Film A', 17, 'occ_showtime_1', 'Cinéma A'),
      candidate('item_aaaaaaaaaaaaaaaaaaaaaaaa', 'Film A', 19, 'occ_showtime_2', 'Cinéma B'),
    ];
    const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      data: showtimes,
      meta: {
        generatedAt: '2026-08-27T09:00:00.000Z', stale: false, partial: false, nextCursor: null,
        providers: [{ source: 'scare', status: 'fresh', lastSuccessAt: '2026-08-27T08:00:00.000Z' }],
      },
    }), { status: 200 }));

    const first = await app.inject({
      method: 'POST', url: '/v1/ingest', payload: { threadId: 'showtime-conversation', text: 'Séances de Film A ce soir ?' },
    });
    expect(first.statusCode).toBe(200);
    const firstText = first.json<{ responseText: string }>().responseText;
    expect(firstText).toContain('1. Film A — Cinéma A');
    expect(firstText).toContain('2. Film A — Cinéma B');

    const second = await app.inject({
      method: 'POST', url: '/v1/ingest', payload: { threadId: 'showtime-conversation', text: 'La deuxième ?' },
    });
    expect(second.statusCode).toBe(200);
    const secondText = second.json<{ responseText: string }>().responseText;
    expect(secondText).toContain('Film A');
    expect(secondText).toContain('Cinéma B');
    expect(secondText).not.toContain('Cinéma A');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
