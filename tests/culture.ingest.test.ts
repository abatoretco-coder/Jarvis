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
const responseMeta = {
  generatedAt: '2026-08-29T09:00:00.000Z', stale: false, partial: false,
  providers: [{ source: 'scare', status: 'fresh', lastSuccessAt: '2026-08-29T08:00:00.000Z' }],
};

function candidate(
  id: string,
  title: string,
  hour: number,
  occurrenceId = `occ_${id}`,
  venueName = `Cinéma ${title}`,
  options: {
    version?: string;
    contributors?: string[];
    type?: 'movie' | 'theatre' | 'concert' | 'exhibition' | 'comedy' | 'festival' | 'other';
    categories?: string[];
    isFree?: boolean | null;
    price?: { min: number | null; max: number | null; currency: string | null } | null;
  } = {},
) {
  return {
    item: {
      id,
      type: options.type ?? 'movie',
      title,
      summary: `Synopsis de ${title}`,
      categories: options.categories ?? ['drama'],
      contributors: options.contributors ?? [],
      attributes: {},
    },
    occurrence: {
      id: occurrenceId, startsAt: `2026-08-30T${hour}:00:00.000Z`, endsAt: null, status: 'scheduled',
      price: options.price ?? null,
      isFree: options.isFree ?? null,
      bookingUrl: null,
      attributes: options.version || (options.type ?? 'movie') === 'movie' ? { version: options.version ?? 'VOSTFR' } : {},
    },
    venue: { id: `venue_${occurrenceId}`, name: venueName, distanceKm: 2 }, source, rankReasons: ['nearby'],
  };
}

const candidates = [
  candidate('item_aaaaaaaaaaaaaaaaaaaaaaaa', 'Film A', 17, undefined, undefined, { contributors: ['Alice Martin'] }),
  candidate('item_bbbbbbbbbbbbbbbbbbbbbbbb', 'Film B', 18, undefined, undefined, { contributors: ['Amy Adams'] }),
  candidate('item_cccccccccccccccccccccccc', 'Film C', 19, undefined, undefined, { contributors: ['Charlie Dupont'] }),
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
    CONVERSATION_RESULT_SET_TTL_MS: 86_400_000,
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
        id: `occ_${id}`, itemId: id, venueId: `venue_${id}`, startsAt: '2026-08-30T18:30:00.000Z',
        endsAt: null, timezone: 'Europe/Paris', status: 'scheduled', price: null, isFree: null,
        bookingUrl: null, attributes: { version: 'VOSTFR' },
        venue: { id: `venue_${id}`, name: `Cinéma ${title}`, latitude: 48.86, longitude: 2.34, distanceKm: 2 }, source,
      }],
    },
    meta: responseMeta,
  };
}

function itemResponseForCandidates(id: string, title: string, entries: ReturnType<typeof candidate>[]) {
  return {
    data: {
      id, type: 'movie', title, originalTitle: null, summary: `Synopsis de ${title}`, description: null,
      categories: ['drama'], contributors: [], durationMinutes: 100, imageUrl: null, imageCredit: null,
      attributes: {}, source,
      occurrences: entries.map((entry) => ({
        ...entry.occurrence,
        itemId: id,
        venueId: entry.venue.id,
        timezone: 'Europe/Paris',
        venue: { ...entry.venue, latitude: 48.86, longitude: 2.34 },
        source,
      })),
    },
    meta: responseMeta,
  };
}

describe('Culture through /v1/ingest', () => {
  let app: FastifyInstance;

  test('keeps a single Culture dispatch block after merge reconciliation', () => {
    const ingestSource = readFileSync(resolve(process.cwd(), 'src/routes/ingest.ts'), 'utf8');
    expect(ingestSource.match(/const inferredCulture = inferCultureRequest/gu)).toHaveLength(1);
    expect(ingestSource.match(/selectedResult: referencedCultureResult/gu)).toHaveLength(1);
  });

  test('uses the calling client location and rejects incomplete coordinates', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'jarvis-culture-client-location-'));
    const env = makeEnv(join(tempDir, 'conversation.sqlite'));
    env.CULTURE_HOME_LATITUDE = undefined;
    env.CULTURE_HOME_LONGITUDE = undefined;
    env.AGORA_HOME_LAT = undefined;
    env.AGORA_HOME_LON = undefined;
    registerIngestRoute(app, makeDeps(env));
    const fetchMock = jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      data: [candidate('item_location', 'Signes', 20)],
      meta: { ...responseMeta, nextCursor: null },
    }), { status: 200 }));

    const response = await app.inject({
      method: 'POST',
      url: '/v1/ingest',
      payload: {
        threadId: 'client-location',
        text: 'Trouve-moi des séances de ciné pour ce soir autour de chez moi',
        clientContext: {
          channel: 'desktop',
          location: { latitude: 48.8282838, longitude: 2.3079543, accuracyM: 25 },
        },
      },
    });

    expect(response.statusCode).toBe(200);
    const agoraUrl = new URL(String(fetchMock.mock.calls[0]?.[0]));
    expect(agoraUrl.searchParams.get('lat')).toBe('48.8282838');
    expect(agoraUrl.searchParams.get('lon')).toBe('2.3079543');
    expect(agoraUrl.searchParams.get('q')).toBeNull();
    expect(agoraUrl.searchParams.get('audience')).toBe('mainstream');

    const invalid = await app.inject({
      method: 'POST',
      url: '/v1/ingest',
      payload: {
        threadId: 'client-location-invalid',
        text: 'Quelles séances autour de moi ?',
        clientContext: { location: { latitude: 48.8282838 } },
      },
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json<{ error: string }>().error).toBe('invalid_body');
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
      if (url.pathname.includes('item_cccccccccccccccccccccccc')) {
        return new Response(JSON.stringify(itemResponse('item_cccccccccccccccccccccccc', 'Film C')), { status: 200 });
      }
      if (url.hostname === 'ollama') {
        return new Response(JSON.stringify({ message: { content: 'Pitch ciblé de Film B.' } }), { status: 200 });
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
    expect(itemUrl.searchParams.has('types')).toBe(false);
    expect(itemUrl.searchParams.has('version')).toBe(false);

    const focused = await app.inject({
      method: 'POST', url: '/v1/ingest', payload: { threadId: 'culture-conversation', text: 'Et lui ?' },
    });
    expect(focused.statusCode).toBe(200);
    expect(focused.json<{ responseText: string }>().responseText).toContain('Synopsis de Film B');

    const pitch = await app.inject({
      method: 'POST', url: '/v1/ingest', payload: { threadId: 'culture-conversation', text: 'Pitche-le-moi' },
    });
    expect(pitch.statusCode).toBe(200);
    expect(pitch.json<{ responseText: string }>().responseText).toBe('Pitch ciblé de Film B.');
    const ollamaCall = fetchMock.mock.calls.find(([url]) => new URL(String(url)).hostname === 'ollama');
    const ollamaBody = JSON.parse(String((ollamaCall?.[1] as RequestInit | undefined)?.body)) as {
      messages: Array<{ content: string }>;
    };
    const ollamaPrompt = ollamaBody.messages.map((message) => message.content).join('\n');
    expect(ollamaPrompt).toContain('Film B');
    expect(ollamaPrompt).not.toContain('Film A');
    expect(ollamaPrompt).not.toContain('Film C');
    const attributed = await app.inject({
      method: 'POST', url: '/v1/ingest', payload: { threadId: 'culture-conversation', text: 'Le film avec Amy Adams' },
    });
    expect(attributed.statusCode).toBe(200);
    expect(attributed.json<{ responseText: string }>().responseText).toContain('Synopsis de Film B');

    const third = await app.inject({
      method: 'POST', url: '/v1/ingest', payload: { threadId: 'culture-conversation', text: 'Le troisième' },
    });
    expect(third.statusCode).toBe(200);
    expect(third.json<{ responseText: string }>().responseText).toContain('Synopsis de Film C');
    const focusedThird = await app.inject({
      method: 'POST', url: '/v1/ingest', payload: { threadId: 'culture-conversation', text: 'Et lui ?' },
    });
    expect(focusedThird.statusCode).toBe(200);
    expect(focusedThird.json<{ responseText: string }>().responseText).toContain('Synopsis de Film C');

    const filmBCalls = fetchMock.mock.calls.filter(([url]) => String(url).includes('/v1/items/item_bbbbbbbbbbbbbbbbbbbbbbbb'));
    const filmCCalls = fetchMock.mock.calls.filter(([url]) => String(url).includes('/v1/items/item_cccccccccccccccccccccccc'));
    expect(filmBCalls).toHaveLength(4);
    expect(filmCCalls).toHaveLength(2);
  });

  test('keeps distinct Dune showtimes and revalidates the exact selected occurrence', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'jarvis-culture-showtimes-'));
    registerIngestRoute(app, makeDeps(makeEnv(join(tempDir, 'conversation.sqlite'))));
    const showtimes = [
      candidate('item_dune', 'Dune', 17, 'occ_showtime_1', 'Cinéma A', { version: 'VF' }),
      candidate('item_dune', 'Dune', 18, 'occ_showtime_2', 'Cinéma B', { version: 'VOSTFR' }),
    ];
    const fetchMock = jest.spyOn(global, 'fetch').mockImplementation(async (input) => {
      const url = new URL(String(input));
      return new Response(JSON.stringify(url.pathname.startsWith('/v1/items/')
        ? itemResponseForCandidates('item_dune', 'Dune', showtimes)
        : {
            data: showtimes,
            meta: { ...responseMeta, nextCursor: null },
          }), { status: 200 });
    });

    const first = await app.inject({
      method: 'POST', url: '/v1/ingest', payload: { threadId: 'showtime-conversation', text: 'Séances de Dune demain ?' },
    });
    expect(first.statusCode).toBe(200);
    const firstText = first.json<{ responseText: string }>().responseText;
    expect(firstText).toContain('1. Dune — Cinéma A');
    expect(firstText).toContain('2. Dune — Cinéma B');

    const second = await app.inject({
      method: 'POST', url: '/v1/ingest', payload: { threadId: 'showtime-conversation', text: 'Celle de 20h ?' },
    });
    expect(second.statusCode).toBe(200);
    const secondText = second.json<{ responseText: string }>().responseText;
    expect(secondText).toContain('Dune');
    expect(secondText).toContain('Cinéma B');
    expect(secondText).not.toContain('Cinéma A');

    const versionSelection = await app.inject({
      method: 'POST', url: '/v1/ingest', payload: { threadId: 'showtime-conversation', text: 'Celle en VO' },
    });
    expect(versionSelection.statusCode).toBe(200);
    expect(versionSelection.json<{ responseText: string }>().responseText).toContain('Cinéma B');
    expect(versionSelection.json<{ responseText: string }>().responseText).toContain('VOSTFR');

    const explicitShowtime = await app.inject({
      method: 'POST', url: '/v1/ingest', payload: { threadId: 'showtime-conversation', text: 'La séance de 20h' },
    });
    expect(explicitShowtime.statusCode).toBe(200);
    expect(explicitShowtime.json<{ responseText: string }>().responseText).toContain('Cinéma B');
    expect(fetchMock).toHaveBeenCalledTimes(4);
    const itemCalls = fetchMock.mock.calls.map(([url]) => new URL(String(url))).filter((url) => url.pathname.startsWith('/v1/items/'));
    expect(itemCalls).toHaveLength(3);
    expect(itemCalls.every((url) => Date.parse(url.searchParams.get('from') ?? '') >= Date.now() - 1_000)).toBe(true);
  });

  test('refetches Agora while preserving structured constraints across successive refinements', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'jarvis-culture-refinement-'));
    registerIngestRoute(app, makeDeps(makeEnv(join(tempDir, 'conversation.sqlite'))));
    const fetchMock = jest.spyOn(global, 'fetch').mockImplementation(async (input) => {
      const url = new URL(String(input));
      if (url.pathname.includes('item_bbbbbbbbbbbbbbbbbbbbbbbb')) {
        return new Response(JSON.stringify(itemResponse('item_bbbbbbbbbbbbbbbbbbbbbbbb', 'Film B')), { status: 200 });
      }
      if (url.pathname.includes('item_cccccccccccccccccccccccc')) {
        return new Response(JSON.stringify(itemResponse('item_cccccccccccccccccccccccc', 'Film C')), { status: 200 });
      }
      return new Response(JSON.stringify({
        data: candidates,
        meta: {
          generatedAt: '2026-08-27T09:00:00.000Z', stale: false, partial: false, nextCursor: null,
          providers: [{ source: 'scare', status: 'fresh', lastSuccessAt: '2026-08-27T08:00:00.000Z' }],
        },
      }), { status: 200 });
    });

    for (const text of ['Quels films passent ce soir ?', 'Seulement en VO.', 'À moins de 5 km.', 'Et après 21h ?']) {
      const response = await app.inject({
        method: 'POST', url: '/v1/ingest', payload: { threadId: 'refinement-conversation', text },
      });
      expect(response.statusCode).toBe(200);
    }

    expect(fetchMock).toHaveBeenCalledTimes(4);
    const [initial, versionRefinement, radiusRefinement, timeRefinement] = fetchMock.mock.calls
      .map(([url]) => new URL(String(url)));
    expect(versionRefinement?.searchParams.get('version')).toBe('VO');
    expect(radiusRefinement?.searchParams.get('version')).toBe('VO');
    expect(radiusRefinement?.searchParams.get('radiusKm')).toBe('5');
    expect(timeRefinement?.searchParams.get('version')).toBe('VO');
    expect(timeRefinement?.searchParams.get('radiusKm')).toBe('5');
    expect(timeRefinement?.searchParams.get('q')).toBeNull();
    expect(timeRefinement?.searchParams.get('from')).toContain('T19:00:00.000Z');
    for (const refined of [versionRefinement, radiusRefinement]) {
      expect(refined?.searchParams.get('lat')).toBe(initial?.searchParams.get('lat'));
      expect(refined?.searchParams.get('lon')).toBe(initial?.searchParams.get('lon'));
      expect(refined?.searchParams.get('from')).toBe(initial?.searchParams.get('from'));
      expect(refined?.searchParams.get('to')).toBe(initial?.searchParams.get('to'));
      expect(refined?.searchParams.get('types')).toBe('movie');
    }

    const last = await app.inject({
      method: 'POST', url: '/v1/ingest', payload: { threadId: 'refinement-conversation', text: 'Et la dernière ?' },
    });
    expect(last.statusCode).toBe(200);
    expect(last.json<{ responseText: string }>().responseText).toContain('Film C');
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });

  test('reuses the active voice-hub Culture thread before the Home Assistant preflight', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'jarvis-culture-voice-thread-'));
    registerIngestRoute(app, makeDeps(makeEnv(join(tempDir, 'conversation.sqlite'))));
    const fetchMock = jest.spyOn(global, 'fetch').mockImplementation(async () => new Response(JSON.stringify({
      data: candidates,
      meta: {
        generatedAt: '2026-08-27T09:00:00.000Z', stale: false, partial: false, nextCursor: null,
        providers: [{ source: 'scare', status: 'fresh', lastSuccessAt: '2026-08-27T08:00:00.000Z' }],
      },
    }), { status: 200 }));
    const clientContext = { channel: 'ha.voice-hub', voiceMode: 'short' };

    const initial = await app.inject({
      method: 'POST', url: '/v1/ingest', payload: {
        threadId: 'culture-voice-thread-a',
        text: 'Quels films passent ce soir ?',
        clientContext,
      },
    });
    expect(initial.statusCode).toBe(200);
    expect(initial.json()).toMatchObject({ threadId: 'culture-voice-thread-a' });

    const refinement = await app.inject({
      method: 'POST', url: '/v1/ingest', payload: {
        threadId: 'culture-voice-thread-b',
        text: 'Seulement en VO.',
        clientContext,
      },
    });

    expect(refinement.statusCode).toBe(200);
    expect(refinement.json()).toMatchObject({ threadId: 'culture-voice-thread-a' });
    expect(refinement.json()).not.toMatchObject({ error: 'ha_not_configured' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [initialUrl, refinementUrl] = fetchMock.mock.calls.map(([url]) => new URL(String(url)));
    expect(refinementUrl?.searchParams.get('version')).toBe('VO');
    for (const parameter of ['lat', 'lon', 'radiusKm', 'from', 'to', 'types']) {
      expect(refinementUrl?.searchParams.get(parameter)).toBe(initialUrl?.searchParams.get(parameter));
    }
  });

  test('keeps a factual multi-outing conversation and bounds comparison to the requested candidates', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'jarvis-culture-mixed-outings-'));
    registerIngestRoute(app, makeDeps(makeEnv(join(tempDir, 'conversation.sqlite'))));
    const mixed = [
      candidate('item_concert', 'Concert jazz', 18, 'occ_concert', 'Club Jazz', { type: 'concert', categories: ['Jazz'], isFree: true }),
      candidate('item_expo', 'Expo photo', 19, 'occ_expo', 'Galerie Photo', { type: 'exhibition', categories: ['Photo'], isFree: true }),
      candidate('item_theatre', 'Pièce du soir', 20, 'occ_theatre', 'Théâtre Test', { type: 'theatre', categories: ['Théâtre'], isFree: false, price: { min: 25, max: 30, currency: 'EUR' } }),
      candidate('item_movie', 'Film du soir', 21, 'occ_movie', 'Cinéma Test', { isFree: true }),
      candidate('item_festival', 'Festival local', 22, 'occ_festival', 'Parc Test', { type: 'festival', categories: ['Festival'], isFree: true }),
    ];
    const expoTomorrow = [
      candidate('item_expo', 'Expo photo', 18, 'occ_expo_tomorrow_1', 'Galerie A', { type: 'exhibition', categories: ['Photo'], isFree: true }),
      candidate('item_expo', 'Expo photo', 19, 'occ_expo_tomorrow_2', 'Galerie B', { type: 'exhibition', categories: ['Photo'], isFree: true }),
      candidate('item_expo', 'Expo photo', 20, 'occ_expo_tomorrow_3', 'Galerie C', { type: 'exhibition', categories: ['Photo'], isFree: true }),
    ];
    const fetchMock = jest.spyOn(global, 'fetch').mockImplementation(async (input, init) => {
      const url = new URL(String(input));
      if (url.hostname === 'ollama') {
        return new Response(JSON.stringify({ message: { content: 'Je choisirais la première option.' } }), { status: 200 });
      }
      if (url.pathname.startsWith('/v1/items/')) {
        const itemId = decodeURIComponent(url.pathname.split('/').at(-1) ?? '');
        const entries = [...mixed, ...expoTomorrow].filter((entry) => entry.item.id === itemId);
        const selected = entries[0];
        return selected
          ? new Response(JSON.stringify(itemResponseForCandidates(itemId, selected.item.title, entries)), { status: 200 })
          : new Response('not found', { status: 404 });
      }
      const data = url.searchParams.get('q') === 'Expo photo'
        ? expoTomorrow
        : url.searchParams.get('freeOnly') === 'true'
          ? mixed.filter((entry) => entry.occurrence.isFree)
          : mixed;
      void init;
      return new Response(JSON.stringify({
        data,
        meta: {
          generatedAt: '2026-08-29T09:00:00.000Z', stale: false, partial: false, nextCursor: null,
          providers: [
            { source: 'paris_data', status: 'fresh', lastSuccessAt: '2026-08-29T08:00:00.000Z' },
            { source: 'ticketmaster', status: 'disabled', lastSuccessAt: null, disabledReason: 'missing_api_key' },
          ],
        },
      }), { status: 200 });
    });

    const initial = await app.inject({
      method: 'POST', url: '/v1/ingest', payload: { threadId: 'mixed-outings', text: 'Qu’est-ce qu’on peut faire ce soir autour de chez moi ?' },
    });
    expect(initial.statusCode).toBe(200);
    expect(initial.json<{ responseText: string }>().responseText).toContain('Concert jazz');
    expect(initial.json<{ responseText: string }>().responseText).toContain('Expo photo');

    const free = await app.inject({
      method: 'POST', url: '/v1/ingest', payload: { threadId: 'mixed-outings', text: 'Seulement gratuit.' },
    });
    expect(free.statusCode).toBe(200);
    expect(new URL(String(fetchMock.mock.calls.at(-1)?.[0])).searchParams.get('freeOnly')).toBe('true');

    const selected = await app.inject({
      method: 'POST', url: '/v1/ingest', payload: { threadId: 'mixed-outings', text: 'Le deuxième.' },
    });
    expect(selected.statusCode).toBe(200);
    expect(selected.json<{ responseText: string }>().responseText).toContain('Expo photo');
    expect(selected.json<{ responseText: string }>().responseText).toContain('Galerie Photo');

    const location = await app.inject({
      method: 'POST', url: '/v1/ingest', payload: { threadId: 'mixed-outings', text: 'C’est où et à quelle heure ?' },
    });
    expect(location.statusCode).toBe(200);
    expect(location.json<{ responseText: string }>().responseText).toContain('Galerie Photo');

    const tomorrow = await app.inject({
      method: 'POST', url: '/v1/ingest', payload: { threadId: 'mixed-outings', text: 'Et demain ?' },
    });
    expect(tomorrow.statusCode).toBe(200);
    const tomorrowUrl = new URL(String(fetchMock.mock.calls.at(-1)?.[0]));
    expect(tomorrowUrl.searchParams.get('q')).toBe('Expo photo');
    expect(tomorrowUrl.searchParams.get('types')).toBe('exhibition');
    expect(tomorrow.json<{ responseText: string }>().responseText).toContain('Galerie C');

    const comparison = await app.inject({
      method: 'POST', url: '/v1/ingest', payload: {
        threadId: 'mixed-outings',
        text: 'Entre le premier et le troisième, lequel tu conseilles ?',
      },
    });
    expect(comparison.statusCode).toBe(200);
    expect(comparison.json<{ responseText: string }>().responseText).toBe('Je choisirais la première option.');
    const ollamaCall = fetchMock.mock.calls.find(([url]) => new URL(String(url)).hostname === 'ollama');
    const ollamaBody = JSON.parse(String((ollamaCall?.[1] as RequestInit | undefined)?.body)) as { messages: Array<{ content: string }> };
    const prompt = ollamaBody.messages.map((message) => message.content).join('\n');
    expect(prompt).toContain('Galerie A');
    expect(prompt).toContain('Galerie C');
    expect(prompt).not.toContain('Galerie B');
  });

  test('preserves combined weekday, budget, free and generic multi-source constraints through ingest', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'jarvis-culture-natural-multisource-'));
    registerIngestRoute(app, makeDeps(makeEnv(join(tempDir, 'conversation.sqlite'))));
    const mixed = [
      candidate('item_concert', 'Concert accessible', 18, 'occ_concert', 'Salle Concert', {
        type: 'concert', price: { min: 20, max: 50, currency: 'EUR' },
      }),
      candidate('item_expo', 'Expo gratuite', 19, 'occ_expo', 'Galerie Expo', { type: 'exhibition', isFree: true }),
      candidate('item_theatre', 'Pièce du soir', 20, 'occ_theatre', 'Théâtre Test', { type: 'theatre' }),
    ];
    const fetchMock = jest.spyOn(global, 'fetch').mockImplementation(async (input) => {
      const url = new URL(String(input));
      if (url.hostname === 'ollama') {
        return new Response(JSON.stringify({ message: { content: 'Voici plusieurs sorties possibles.' } }), { status: 200 });
      }
      return new Response(JSON.stringify({
        data: mixed,
        meta: {
          generatedAt: '2026-08-29T09:00:00.000Z', stale: false, partial: true, nextCursor: null,
          providers: [
            { source: 'paris_data', status: 'fresh', lastSuccessAt: '2026-08-29T08:00:00.000Z' },
            { source: 'ticketmaster', status: 'unavailable', lastSuccessAt: null },
          ],
        },
      }), { status: 200 });
    });

    for (const [threadId, text] of [
      ['natural-concert', 'Un concert vendredi soir à moins de 30 €'],
      ['natural-expo', 'Une expo gratuite dimanche'],
      ['natural-generic', 'Qu’est-ce qu’on fait ce soir ?'],
    ]) {
      const response = await app.inject({ method: 'POST', url: '/v1/ingest', payload: { threadId, text } });
      expect(response.statusCode).toBe(200);
      expect(response.json()).not.toMatchObject({ error: 'ha_not_configured' });
    }

    const agoraUrls = fetchMock.mock.calls
      .map(([input]) => new URL(String(input)))
      .filter((url) => url.hostname === 'agora');
    expect(agoraUrls).toHaveLength(3);
    expect(agoraUrls[0]?.searchParams.get('types')).toBe('concert');
    expect(agoraUrls[0]?.searchParams.get('maxPrice')).toBe('30');
    expect(agoraUrls[1]?.searchParams.get('types')).toBe('exhibition');
    expect(agoraUrls[1]?.searchParams.get('freeOnly')).toBe('true');
    expect(agoraUrls[2]?.searchParams.has('types')).toBe(false);
  });

  test('uses the focused item for a factual after-21h occurrence refresh', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'jarvis-culture-focus-refinement-'));
    const dbPath = join(tempDir, 'conversation.sqlite');
    registerIngestRoute(app, makeDeps(makeEnv(dbPath)));
    const fetchMock = jest.spyOn(global, 'fetch').mockImplementation(async (input) => {
      const url = new URL(String(input));
      if (url.pathname.includes('item_bbbbbbbbbbbbbbbbbbbbbbbb')) {
        return new Response(JSON.stringify(itemResponse('item_bbbbbbbbbbbbbbbbbbbbbbbb', 'Film B')), { status: 200 });
      }
      return new Response(JSON.stringify({
        data: candidates,
        meta: {
          generatedAt: '2026-08-27T09:00:00.000Z', stale: false, partial: false, nextCursor: null,
          providers: [{ source: 'scare', status: 'fresh', lastSuccessAt: '2026-08-27T08:00:00.000Z' }],
        },
      }), { status: 200 });
    });

    await app.inject({
      method: 'POST', url: '/v1/ingest', payload: { threadId: 'focus-refinement', text: 'Quels films passent ce soir ?' },
    });
    const selection = await app.inject({
      method: 'POST', url: '/v1/ingest', payload: { threadId: 'focus-refinement', text: 'Le deuxième' },
    });
    expect(selection.statusCode).toBe(200);
    expect(selection.json<{ responseText: string }>().responseText).toContain('Film B');
    const response = await app.inject({
      method: 'POST', url: '/v1/ingest', payload: { threadId: 'focus-refinement', text: 'Il passe où après 21h ?' },
    });

    expect(response.statusCode).toBe(200);
    const lastUrl = new URL(String(fetchMock.mock.calls.at(-1)?.[0]));
    expect(lastUrl.pathname).toBe('/v1/discover');
    expect(lastUrl.searchParams.get('q')).toBe('Film B');
    expect(lastUrl.searchParams.get('radiusKm')).toBe('15');
    expect(lastUrl.searchParams.get('from')).toContain('T19:00:00.000Z');

    const combined = await app.inject({
      method: 'POST', url: '/v1/ingest', payload: {
        threadId: 'focus-refinement',
        text: 'Seulement en VO et à moins de 5 km.',
      },
    });
    expect(combined.statusCode).toBe(200);
    const combinedUrl = new URL(String(fetchMock.mock.calls.at(-1)?.[0]));
    expect(combinedUrl.searchParams.get('q')).toBe('Film B');
    expect(combinedUrl.searchParams.get('version')).toBe('VO');
    expect(combinedUrl.searchParams.get('radiusKm')).toBe('5');
    expect(combinedUrl.searchParams.get('from')).toBe(lastUrl.searchParams.get('from'));

    const after21From = combinedUrl.searchParams.get('from');
    const tomorrow = await app.inject({
      method: 'POST', url: '/v1/ingest', payload: { threadId: 'focus-refinement', text: 'Et demain ?' },
    });
    expect(tomorrow.statusCode).toBe(200);
    const tomorrowUrl = new URL(String(fetchMock.mock.calls.at(-1)?.[0]));
    expect(tomorrowUrl.searchParams.get('q')).toBe('Film B');
    expect(tomorrowUrl.searchParams.get('radiusKm')).toBe('5');
    expect(Date.parse(tomorrowUrl.searchParams.get('from') ?? '') - Date.parse(after21From ?? '')).toBe(86_400_000);
  });

  test('stores and resolves a venue as an agora.venue ResultSet item', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'jarvis-culture-venues-'));
    registerIngestRoute(app, makeDeps(makeEnv(join(tempDir, 'conversation.sqlite'))));
    const venues = [{
      id: 'venue_cinema_x',
      name: 'Cinéma X',
      type: 'cinema',
      address: null,
      city: 'Paris',
      postalCode: null,
      country: 'FR',
      latitude: 48.86,
      longitude: 2.34,
      timezone: 'Europe/Paris',
      websiteUrl: null,
      attributes: {},
      distanceKm: 2.4,
      source,
    }];
    const fetchMock = jest.spyOn(global, 'fetch').mockImplementation(async (input) => {
      const url = new URL(String(input));
      return new Response(JSON.stringify({
        data: url.pathname === '/v1/venues' ? venues : venues[0],
        meta: responseMeta,
      }), { status: 200 });
    });

    const search = await app.inject({
      method: 'POST', url: '/v1/ingest', payload: { threadId: 'venue-reference', text: 'Quels cinémas sont proches ?' },
    });
    expect(search.statusCode).toBe(200);
    expect(search.json<{ responseText: string }>().responseText).toContain('Cinéma X');

    const selection = await app.inject({
      method: 'POST', url: '/v1/ingest', payload: { threadId: 'venue-reference', text: 'Le premier' },
    });
    expect(selection.statusCode).toBe(200);
    expect(selection.json<{ responseText: string }>().responseText).toContain('Cinéma X — Paris · 2.4 km');

    const focusedVenue = await app.inject({
      method: 'POST', url: '/v1/ingest', payload: { threadId: 'venue-reference', text: 'Ce cinéma ?' },
    });
    expect(focusedVenue.statusCode).toBe(200);
    expect(focusedVenue.json<{ responseText: string }>().responseText).toContain('Cinéma X — Paris · 2.4 km');
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(new URL(String(fetchMock.mock.calls[1]?.[0])).pathname).toBe('/v1/venues/venue_cinema_x');
    expect(new URL(String(fetchMock.mock.calls[2]?.[0])).pathname).toBe('/v1/venues/venue_cinema_x');
  });

  test('returns a bounded clarification for an ambiguous venue reference without guessing an ID', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'jarvis-culture-ambiguity-'));
    registerIngestRoute(app, makeDeps(makeEnv(join(tempDir, 'conversation.sqlite'))));
    const sharedVenue = [
      candidate('item_aaaaaaaaaaaaaaaaaaaaaaaa', 'Film A', 17, 'occ_shared_1', 'Cinéma Commun'),
      candidate('item_bbbbbbbbbbbbbbbbbbbbbbbb', 'Film B', 18, 'occ_shared_2', 'Cinéma Commun'),
    ];
    const fetchMock = jest.spyOn(global, 'fetch').mockImplementation(async () => new Response(JSON.stringify({
      data: sharedVenue,
      meta: {
        generatedAt: '2026-08-27T09:00:00.000Z', stale: false, partial: false, nextCursor: null,
        providers: [{ source: 'scare', status: 'fresh', lastSuccessAt: '2026-08-27T08:00:00.000Z' }],
      },
    }), { status: 200 }));

    await app.inject({
      method: 'POST', url: '/v1/ingest', payload: { threadId: 'ambiguous-reference', text: 'Séances ce soir ?' },
    });
    const response = await app.inject({
      method: 'POST', url: '/v1/ingest', payload: { threadId: 'ambiguous-reference', text: 'Celle au cinéma Commun' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json<{ responseText: string }>().responseText).toContain('Précise le numéro parmi');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test('reports an expired ResultSet instead of falling through to another agent', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'jarvis-culture-expired-'));
    const env = makeEnv(join(tempDir, 'conversation.sqlite'));
    env.CONVERSATION_RESULT_SET_TTL_MS = 1;
    registerIngestRoute(app, makeDeps(env));
    const fetchMock = jest.spyOn(global, 'fetch').mockImplementation(async () => new Response(JSON.stringify({
      data: candidates,
      meta: {
        generatedAt: '2026-08-27T09:00:00.000Z', stale: false, partial: false, nextCursor: null,
        providers: [{ source: 'scare', status: 'fresh', lastSuccessAt: '2026-08-27T08:00:00.000Z' }],
      },
    }), { status: 200 }));

    await app.inject({
      method: 'POST', url: '/v1/ingest', payload: { threadId: 'expired-reference', text: 'Films ce soir ?' },
    });
    const currentTime = Date.now();
    jest.spyOn(Date, 'now').mockReturnValue(currentTime + 1_000);
    const response = await app.inject({
      method: 'POST', url: '/v1/ingest', payload: { threadId: 'expired-reference', text: 'Le premier' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json<{ responseText: string }>().responseText).toContain('liste précédente a expiré');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test('reports an out-of-range ordinal without another Agora call', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'jarvis-culture-missing-'));
    registerIngestRoute(app, makeDeps(makeEnv(join(tempDir, 'conversation.sqlite'))));
    const fetchMock = jest.spyOn(global, 'fetch').mockImplementation(async () => new Response(JSON.stringify({
      data: candidates.slice(0, 2),
      meta: {
        generatedAt: '2026-08-27T09:00:00.000Z', stale: false, partial: false, nextCursor: null,
        providers: [{ source: 'scare', status: 'fresh', lastSuccessAt: '2026-08-27T08:00:00.000Z' }],
      },
    }), { status: 200 }));

    await app.inject({
      method: 'POST', url: '/v1/ingest', payload: { threadId: 'missing-reference', text: 'Films ce soir ?' },
    });
    const response = await app.inject({
      method: 'POST', url: '/v1/ingest', payload: { threadId: 'missing-reference', text: 'Le cinquième' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json<{ responseText: string }>().responseText).toContain('Je ne retrouve pas ce résultat');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test('does not leak focus between two threadIds', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'jarvis-culture-thread-isolation-'));
    registerIngestRoute(app, makeDeps(makeEnv(join(tempDir, 'conversation.sqlite'))));
    const fetchMock = jest.spyOn(global, 'fetch').mockImplementation(async (input) => {
      const url = new URL(String(input));
      if (url.pathname.includes('item_bbbbbbbbbbbbbbbbbbbbbbbb')) {
        return new Response(JSON.stringify(itemResponse('item_bbbbbbbbbbbbbbbbbbbbbbbb', 'Film B')), { status: 200 });
      }
      return new Response(JSON.stringify({
        data: candidates,
        meta: {
          generatedAt: '2026-08-27T09:00:00.000Z', stale: false, partial: false, nextCursor: null,
          providers: [{ source: 'scare', status: 'fresh', lastSuccessAt: '2026-08-27T08:00:00.000Z' }],
        },
      }), { status: 200 });
    });

    for (const threadId of ['isolated-a', 'isolated-b']) {
      await app.inject({
        method: 'POST', url: '/v1/ingest', payload: { threadId, text: 'Films ce soir ?' },
      });
    }
    await app.inject({
      method: 'POST', url: '/v1/ingest', payload: { threadId: 'isolated-a', text: 'Le deuxième' },
    });
    const response = await app.inject({
      method: 'POST', url: '/v1/ingest', payload: { threadId: 'isolated-b', text: 'Et lui ?' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json<{ responseText: string }>().responseText).toContain('Je ne retrouve pas ce résultat');
    const itemCalls = fetchMock.mock.calls.filter(([url]) => String(url).includes('/v1/items/'));
    expect(itemCalls).toHaveLength(1);
  });
});
