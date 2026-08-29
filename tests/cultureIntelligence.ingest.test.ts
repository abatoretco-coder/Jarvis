import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import Fastify, { type FastifyInstance } from 'fastify';

import { createConversationDb } from '../src/conversation/repositories/SqliteRepositories';
import type { AgoraCandidate } from '../src/culture/contracts';
import { CulturePersonalizationService } from '../src/culture/CulturePersonalizationService';
import { CultureProfileRepository } from '../src/culture/CultureProfileRepository';
import type { Env } from '../src/env';
import { registerCultureProfileRoutes } from '../src/routes/cultureProfile';
import { registerIngestRoute } from '../src/routes/ingest';
import type { AppDeps } from '../src/server';

const source: AgoraCandidate['source'] = {
  provider: 'openagenda', externalId: 'source', sourceUrl: 'https://example.test/source',
  fetchedAt: '2026-08-29T08:00:00.000Z', sourceModifiedAt: null,
  freshness: 'fresh', sourceType: 'open_data',
};
const responseMeta = {
  generatedAt: '2026-08-29T09:00:00.000Z', stale: false, partial: false,
  providers: [{ source: 'openagenda', status: 'fresh', lastSuccessAt: '2026-08-29T08:00:00.000Z' }],
};

function candidate(
  id: string,
  type: AgoraCandidate['item']['type'],
  categories: string[],
  index: number,
): AgoraCandidate {
  return {
    item: {
      id: `item-${index}`, type, title: id, summary: `Résumé ${id}`, categories, contributors: [], attributes: {},
    },
    occurrence: {
      id: `occ-${index}`, startsAt: `2026-09-05T${18 + index}:00:00.000Z`, endsAt: null,
      status: 'scheduled', price: { min: 10 + index * 10, max: 20 + index * 10, currency: 'EUR' },
      isFree: false, bookingUrl: null, attributes: {},
    },
    venue: { id: `venue-${index}`, name: `Lieu ${id}`, distanceKm: 2 + index },
    source: { ...source, externalId: `source-${id}` },
    rankReasons: ['date_match'],
  };
}

const candidates = [
  candidate('Théâtre classique', 'theatre', ['classique'], 0),
  candidate('Expo photo', 'exhibition', ['photo'], 1),
  candidate('Concert jazz', 'concert', ['jazz'], 2),
];

function itemResponse(id: string) {
  const found = candidates.find((entry) => entry.item.id === id) ?? candidates[0]!;
  return {
    data: {
      ...found.item,
      originalTitle: null,
      description: null,
      durationMinutes: null,
      imageUrl: null,
      imageCredit: null,
      source: found.source,
      occurrences: [{
        ...found.occurrence,
        itemId: found.item.id,
        venueId: found.venue.id,
        timezone: 'Europe/Paris',
        venue: { ...found.venue, latitude: 48.86, longitude: 2.34 },
        source,
      }],
    },
    meta: responseMeta,
  };
}

function env(dbPath: string, proactiveEnabled = false): Env {
  return {
    HA_BASE_URL: undefined,
    HA_TOKEN: undefined,
    CONVERSATION_DB_PATH: dbPath,
    CONVERSATION_RECENT_MESSAGES: 10,
    CONVERSATION_RESULT_SET_TTL_MS: 86_400_000,
    AGORA_BASE_URL: 'http://agora:8092',
    AGORA_API_TOKEN: 'a'.repeat(32),
    AGORA_TIMEOUT_MS: 500,
    CULTURE_HOME_LATITUDE: 48.85,
    CULTURE_HOME_LONGITUDE: 2.35,
    CULTURE_DEFAULT_RADIUS_KM: 15,
    CULTURE_DEFAULT_PROFILE_ID: 'local-default',
    CULTURE_EXPLORATION_RATIO: 0.25,
    CULTURE_FEEDBACK_RETENTION_DAYS: 730,
    CULTURE_PROACTIVE_ENABLED: proactiveEnabled,
    CULTURE_PROACTIVE_THRESHOLD: 92,
    CULTURE_PROACTIVE_COOLDOWN_MS: 0,
    CULTURE_PROACTIVE_LOOKAHEAD_HOURS: 48,
    AGORA_HOME_RADIUS_KM: 15,
    OPENAI_TIMEOUT_MS: 500,
    OLLAMA_BASE_URL: 'http://ollama:11434/v1',
    OLLAMA_MODEL: 'qwen3:8b',
    LIMIT_K: 10,
    LIMIT_M: 20,
    HA_AGENT_MAP: '',
    OAUTH_REFRESH_TOKEN_STORE_PATH: join(tmpdir(), 'jarvis-culture-intelligence-oauth.json'),
  } as unknown as Env;
}

function deps(runtimeEnv: Env): AppDeps {
  return {
    env: runtimeEnv,
    ha: { getStates: async () => [] } as AppDeps['ha'],
    spotifyWebApi: { isConfigured: () => false } as AppDeps['spotifyWebApi'],
  };
}

function installFetchMock() {
  return jest.spyOn(global, 'fetch').mockImplementation(async (input) => {
    const url = new URL(String(input));
    if (url.hostname === 'ollama') {
      return new Response(JSON.stringify({ message: { content: 'Recommandation personnalisée locale.' } }), { status: 200 });
    }
    if (url.pathname === '/v1/discover') {
      const requestedTypes = url.searchParams.get('types')?.split(',') ?? [];
      const data = requestedTypes.length
        ? candidates.filter((entry) => requestedTypes.includes(entry.item.type))
        : candidates;
      return new Response(JSON.stringify({
        data,
        meta: {
          generatedAt: '2026-08-29T09:00:00.000Z', stale: false, partial: false, nextCursor: null,
          providers: [{ source: 'openagenda', status: 'fresh', lastSuccessAt: '2026-08-29T08:00:00.000Z' }],
        },
      }), { status: 200 });
    }
    const itemId = decodeURIComponent(url.pathname.split('/').at(-1) ?? '');
    if (url.pathname.startsWith('/v1/items/')) {
      if (itemId === 'legacy-occurrence') return new Response('not found', { status: 404 });
      return new Response(JSON.stringify(itemResponse(itemId)), { status: 200 });
    }
    return new Response('not found', { status: 404 });
  });
}

describe('Phase 5 Culture intelligence through /v1/ingest', () => {
  let app: FastifyInstance;
  let directory: string;
  let dbPath: string;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'jarvis-culture-intelligence-'));
    dbPath = join(directory, 'conversation.sqlite');
    app = Fastify({ logger: false });
    registerIngestRoute(app, deps(env(dbPath)));
  });

  afterEach(async () => {
    jest.useRealTimers();
    jest.restoreAllMocks();
    await app.close();
    rmSync(directory, { recursive: true, force: true });
  });

  test('learns from a focused result, saves it, personalizes later and refreshes the favorite', async () => {
    const fetchMock = installFetchMock();
    const profile = { user_id: 'profile-a' };
    const first = await app.inject({
      method: 'POST', url: '/v1/ingest',
      payload: { threadId: 'learning', text: 'Qu’est-ce qu’on fait ce soir ?', ...profile },
    });
    expect(first.statusCode).toBe(200);
    expect(first.json<{ responseText: string }>().responseText).toContain('Expo photo');
    expect(first.json<{ cultureCandidates: Array<{ personalizationReasons: string[] }> }>().cultureCandidates[0]?.personalizationReasons)
      .toContain('cold_start');

    const selected = await app.inject({
      method: 'POST', url: '/v1/ingest',
      payload: { threadId: 'learning', text: 'Le deuxième', ...profile },
    });
    expect(selected.json<{ responseText: string }>().responseText).toContain('Expo photo');
    const liked = await app.inject({
      method: 'POST', url: '/v1/ingest',
      payload: { threadId: 'learning', text: 'J’adore ce genre.', ...profile },
    });
    expect(liked.json<{ responseText: string }>().responseText).toContain('influencera');
    const saved = await app.inject({
      method: 'POST', url: '/v1/ingest',
      payload: { threadId: 'learning', text: 'Garde-le.', ...profile },
    });
    expect(saved.json<{ responseText: string }>().responseText).toContain('sauvegardé localement');

    const recommendation = await app.inject({
      method: 'POST', url: '/v1/ingest',
      payload: { threadId: 'later', text: 'Qu’est-ce que tu me conseilles samedi ?', ...profile },
    });
    expect(recommendation.statusCode).toBe(200);
    expect(recommendation.json<{ cultureCandidates: Array<{ title: string; personalizationReasons: string[] }> }>().cultureCandidates[0])
      .toMatchObject({ title: 'Expo photo', personalizationReasons: expect.arrayContaining(['matches_preference:photo']) });
    const ollamaCalls = fetchMock.mock.calls.filter(([url]) => new URL(String(url)).hostname === 'ollama');
    const body = JSON.parse(String((ollamaCalls.at(-1)?.[1] as RequestInit | undefined)?.body)) as {
      messages: Array<{ content: string }>;
    };
    const prompt = body.messages.map((message) => message.content).join('\n');
    expect(prompt.indexOf('Expo photo')).toBeLessThan(prompt.indexOf('Théâtre classique'));
    expect(prompt).toContain('matches_preference:photo');

    const why = await app.inject({
      method: 'POST', url: '/v1/ingest',
      payload: { threadId: 'later', text: 'Pourquoi tu me proposes le premier ?', ...profile },
    });
    expect(why.json<{ responseText: string }>().responseText).toContain('préférence « photo »');

    const similar = await app.inject({
      method: 'POST', url: '/v1/ingest',
      payload: { threadId: 'later', text: 'Dans le même style.', ...profile },
    });
    expect(similar.statusCode).toBe(200);
    const similarDiscover = fetchMock.mock.calls
      .map(([url]) => new URL(String(url)))
      .filter((url) => url.pathname === '/v1/discover')
      .at(-1);
    expect(similarDiscover?.searchParams.get('tags')).toBe('photo');

    const exploration = await app.inject({
      method: 'POST', url: '/v1/ingest',
      payload: { threadId: 'exploration', text: 'Propose-moi quelque chose de différent.', ...profile },
    });
    expect(exploration.statusCode).toBe(200);
    const explorationCall = fetchMock.mock.calls.filter(([url]) => new URL(String(url)).hostname === 'ollama').at(-1);
    const explorationBody = JSON.parse(String((explorationCall?.[1] as RequestInit | undefined)?.body)) as {
      messages: Array<{ content: string }>;
    };
    expect(explorationBody.messages.map((message) => message.content).join('\n')).toContain('exploration_pick');

    const favorites = await app.inject({
      method: 'POST', url: '/v1/ingest',
      payload: { threadId: 'favorites', text: 'Montre-moi mes favoris.', ...profile },
    });
    expect(favorites.json<{ responseText: string }>().responseText).toContain('prochaine occurrence confirmée');
    await app.inject({
      method: 'POST', url: '/v1/ingest',
      payload: { threadId: 'favorites', text: 'Le premier', ...profile },
    });
    const availability = await app.inject({
      method: 'POST', url: '/v1/ingest',
      payload: { threadId: 'favorites', text: 'C’est toujours disponible ?', ...profile },
    });
    expect(availability.statusCode).toBe(200);
    expect(availability.json<{ responseText: string }>().responseText).toContain('Expo photo');
  });

  test('penalizes theatre generically but honors an explicit theatre request', async () => {
    const fetchMock = installFetchMock();
    const profile = { user_id: 'profile-negative' };
    const feedback = await app.inject({
      method: 'POST', url: '/v1/ingest',
      payload: { threadId: 'negative', text: 'Je n’aime pas le théâtre.', ...profile },
    });
    expect(feedback.statusCode).toBe(200);
    const generic = await app.inject({
      method: 'POST', url: '/v1/ingest',
      payload: { threadId: 'negative-2', text: 'Trouve-moi quelque chose qui devrait me plaire demain.', ...profile },
    });
    expect(generic.statusCode).toBe(200);
    const ollamaCall = fetchMock.mock.calls.filter(([url]) => new URL(String(url)).hostname === 'ollama').at(-1);
    const body = JSON.parse(String((ollamaCall?.[1] as RequestInit | undefined)?.body)) as { messages: Array<{ content: string }> };
    const prompt = body.messages.map((message) => message.content).join('\n');
    expect(prompt.indexOf('Théâtre classique')).toBeGreaterThan(prompt.indexOf('Expo photo'));

    const explicit = await app.inject({
      method: 'POST', url: '/v1/ingest',
      payload: { threadId: 'negative-3', text: 'Je veux justement du théâtre demain.', ...profile },
    });
    expect(explicit.statusCode).toBe(200);
    expect(explicit.json<{ responseText: string }>().responseText).toContain('Théâtre classique');
  });

  test('keeps two profile identities independent even on comparable requests', async () => {
    const fetchMock = installFetchMock();
    await app.inject({
      method: 'POST', url: '/v1/ingest',
      payload: { threadId: 'profile-a', user_id: 'a', text: 'J’adore les expos photo.' },
    });
    await app.inject({
      method: 'POST', url: '/v1/ingest',
      payload: { threadId: 'profile-b', user_id: 'b', text: 'J’adore les concerts jazz.' },
    });
    await app.inject({
      method: 'POST', url: '/v1/ingest',
      payload: { threadId: 'recommend-a', user_id: 'a', text: 'Qu’est-ce que tu me conseilles samedi ?' },
    });
    await app.inject({
      method: 'POST', url: '/v1/ingest',
      payload: { threadId: 'recommend-b', user_id: 'b', text: 'Qu’est-ce que tu me conseilles samedi ?' },
    });
    const prompts = fetchMock.mock.calls.filter(([url]) => new URL(String(url)).hostname === 'ollama').map((call) => {
      const body = JSON.parse(String((call[1] as RequestInit | undefined)?.body)) as { messages: Array<{ content: string }> };
      return body.messages.map((message) => message.content).join('\n');
    });
    expect(prompts.at(-2)?.indexOf('Expo photo')).toBeLessThan(prompts.at(-2)?.indexOf('Concert jazz') ?? 0);
    expect(prompts.at(-1)?.indexOf('Concert jazz')).toBeLessThan(prompts.at(-1)?.indexOf('Expo photo') ?? 0);
  });

  test('forgets a focused venue completely without changing another profile', async () => {
    installFetchMock();
    await app.inject({
      method: 'POST', url: '/v1/ingest',
      payload: { threadId: 'forget-venue', user_id: 'forget-a', text: 'Qu’est-ce qu’on fait ce soir ?' },
    });
    await app.inject({
      method: 'POST', url: '/v1/ingest',
      payload: { threadId: 'forget-venue', user_id: 'forget-a', text: 'Le premier' },
    });
    await app.inject({
      method: 'POST', url: '/v1/ingest',
      payload: { threadId: 'forget-venue', user_id: 'forget-a', text: 'J’aime ce lieu.' },
    });
    const beforeDb = createConversationDb(dbPath);
    const beforeRepository = new CultureProfileRepository(beforeDb);
    beforeRepository.updatePreferences('forget-b', { venueWeights: { 'venue-0': 3 } });
    const beforeScore = new CulturePersonalizationService(beforeRepository, 0).rank({
      profileId: 'forget-a', candidates: [candidates[0]!], limit: 1,
    })[0]!.personalizationScore;
    beforeDb.close();
    const forgotten = await app.inject({
      method: 'POST', url: '/v1/ingest',
      payload: { threadId: 'forget-venue', user_id: 'forget-a', text: 'Oublie que j’aime ce lieu.' },
    });
    expect(forgotten.statusCode).toBe(200);
    const afterDb = createConversationDb(dbPath);
    const afterRepository = new CultureProfileRepository(afterDb);
    const afterScore = new CulturePersonalizationService(afterRepository, 0).rank({
      profileId: 'forget-a', candidates: [candidates[0]!], limit: 1,
    })[0]!.personalizationScore;
    expect(beforeScore).toBeGreaterThan(afterScore);
    expect(afterScore).toBe(100);
    expect(afterRepository.listFeedback('forget-a')).toEqual([]);
    expect(afterRepository.getProfile('forget-b').venueWeights['venue-0']).toBe(3);
    afterDb.close();
  });

  test('does not reuse another profile result set or reset confirmation on the same thread', async () => {
    installFetchMock();
    await app.inject({
      method: 'POST', url: '/v1/ingest',
      payload: { threadId: 'shared-profile-thread', user_id: 'a', text: 'Qu’est-ce qu’on fait ce soir ?' },
    });
    await app.inject({
      method: 'POST', url: '/v1/ingest',
      payload: { threadId: 'shared-profile-thread', user_id: 'b', text: 'Garde le premier.' },
    });

    await app.inject({
      method: 'POST', url: '/v1/ingest',
      payload: { threadId: 'shared-profile-thread', user_id: 'a', text: 'J’adore les expos photo.' },
    });
    await app.inject({
      method: 'POST', url: '/v1/ingest',
      payload: { threadId: 'shared-profile-thread', user_id: 'a', text: 'Réinitialise mes préférences Culture.' },
    });
    await app.inject({
      method: 'POST', url: '/v1/ingest',
      payload: { threadId: 'shared-profile-thread', user_id: 'b', text: 'Je confirme.' },
    });

    const db = createConversationDb(dbPath);
    const repository = new CultureProfileRepository(db);
    expect(repository.listSaved('b')).toHaveLength(0);
    expect(repository.getProfile('a').tagWeights.photo).toBeGreaterThan(0);
    db.close();
  });

  test('recovers a favorite through saved provenance when its primary Agora id disappeared', async () => {
    const db = createConversationDb(dbPath);
    const repository = new CultureProfileRepository(db);
    repository.saveEntity({
      profileId: 'fallback-profile',
      entityType: 'agora.occurrence',
      entityId: 'legacy-occurrence',
      sourceRefs: [{ provider: 'openagenda', externalId: 'source-Expo photo', sourceUrl: source.sourceUrl }],
      title: 'Expo photo',
      categories: ['photo'],
      venue: { id: 'legacy-venue', name: 'Ancien lieu' },
      occurrenceDate: '2026-09-05T19:00:00.000Z',
      metadata: {},
    });
    db.close();
    const fetchMock = installFetchMock();
    const favorites = await app.inject({
      method: 'POST', url: '/v1/ingest',
      payload: { threadId: 'fallback-favorite', user_id: 'fallback-profile', text: 'Montre mes favoris.' },
    });
    expect(favorites.statusCode).toBe(200);
    expect(favorites.json<{ responseText: string }>().responseText).toContain('prochaine occurrence confirmée');
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/v1/discover'))).toBe(true);
    const selected = await app.inject({
      method: 'POST', url: '/v1/ingest',
      payload: { threadId: 'fallback-favorite', user_id: 'fallback-profile', text: 'Le premier' },
    });
    expect(selected.json<{ responseText: string }>().responseText).toContain('Expo photo');
  });

  test('lists only future weekend favorites when requested on Sunday evening', async () => {
    jest.useFakeTimers({
      doNotFake: ['clearImmediate', 'clearTimeout', 'nextTick', 'queueMicrotask', 'setImmediate', 'setTimeout'],
    }).setSystemTime(new Date('2026-09-06T16:00:00.000Z'));
    const saturday = candidate('Favori samedi', 'concert', ['jazz'], 10);
    saturday.occurrence.id = 'past-saturday';
    saturday.occurrence.startsAt = '2026-09-05T13:00:00.000Z';
    saturday.source.externalId = 'past-source';
    const sunday = candidate('Favori dimanche', 'concert', ['jazz'], 11);
    sunday.occurrence.id = 'future-sunday';
    sunday.occurrence.startsAt = '2026-09-06T19:00:00.000Z';
    sunday.source.externalId = 'future-source';
    const db = createConversationDb(dbPath);
    const repository = new CultureProfileRepository(db);
    for (const entry of [saturday, sunday]) {
      repository.saveEntity({
        profileId: 'weekend-profile', entityType: 'agora.occurrence', entityId: entry.occurrence.id,
        sourceRefs: [{ provider: entry.source.provider, externalId: entry.source.externalId }],
        title: entry.item.title, categories: entry.item.categories,
        venue: { id: entry.venue.id, name: entry.venue.name },
        occurrenceDate: entry.occurrence.startsAt, metadata: { candidate: entry },
      });
    }
    db.close();
    const discoverUrls: URL[] = [];
    jest.spyOn(global, 'fetch').mockImplementation(async (input) => {
      const url = new URL(String(input));
      if (url.pathname !== '/v1/discover') return new Response('not found', { status: 404 });
      discoverUrls.push(url);
      const data = url.searchParams.get('q')?.includes('samedi') ? [saturday] : [sunday];
      return new Response(JSON.stringify({ data, meta: { ...responseMeta, nextCursor: null } }), { status: 200 });
    });
    const response = await app.inject({
      method: 'POST', url: '/v1/ingest',
      payload: { threadId: 'weekend-favorites', user_id: 'weekend-profile', text: 'Montre-moi mes favoris pour ce week-end.' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json<{ responseText: string }>().responseText).toContain('Favori dimanche');
    expect(response.json<{ responseText: string }>().responseText).not.toContain('Favori samedi');
    expect(discoverUrls).toHaveLength(2);
    expect(discoverUrls.every((url) => url.searchParams.get('from') === '2026-09-06T16:00:00.000Z')).toBe(true);
  });

  test('requires confirmation before resetting the full Culture profile', async () => {
    installFetchMock();
    await app.inject({
      method: 'POST', url: '/v1/ingest',
      payload: { threadId: 'reset', user_id: 'reset-profile', text: 'J’adore les expos photo.' },
    });
    const proposed = await app.inject({
      method: 'POST', url: '/v1/ingest',
      payload: { threadId: 'reset', user_id: 'reset-profile', text: 'Réinitialise mes préférences Culture.' },
    });
    expect(proposed.json()).toMatchObject({ replyMeta: { semanticDecision: 'confirmation_required' } });
    const confirmed = await app.inject({
      method: 'POST', url: '/v1/ingest',
      payload: { threadId: 'reset', user_id: 'reset-profile', text: 'Je confirme.' },
    });
    expect(confirmed.statusCode).toBe(200);
    expect(confirmed.json<{ responseText: string }>().responseText).toContain('réinitialisé');
    const inspected = await app.inject({
      method: 'POST', url: '/v1/ingest',
      payload: { threadId: 'reset', user_id: 'reset-profile', text: 'Qu’est-ce que tu sais de mes goûts ?' },
    });
    expect(inspected.json<{ responseText: string }>().responseText).toContain('pas encore assez');
  });

  test('does not execute an expired Culture reset and does not capture an ordinal deletion without Culture context', async () => {
    installFetchMock();
    await app.inject({
      method: 'POST', url: '/v1/ingest',
      payload: { threadId: 'expired-reset', user_id: 'kept-profile', text: 'J’adore les expos photo.' },
    });
    await app.inject({
      method: 'POST', url: '/v1/ingest',
      payload: { threadId: 'expired-reset', user_id: 'kept-profile', text: 'Réinitialise mes préférences Culture.' },
    });
    const db = createConversationDb(dbPath);
    db.prepare("UPDATE pending_mutations SET expires_at_ms=0 WHERE thread_id='expired-reset'").run();
    db.close();
    const expiredConfirmation = await app.inject({
      method: 'POST', url: '/v1/ingest',
      payload: { threadId: 'expired-reset', user_id: 'kept-profile', text: 'Je confirme.' },
    });
    expect(expiredConfirmation.statusCode).toBe(503);
    const inspected = await app.inject({
      method: 'POST', url: '/v1/ingest',
      payload: { threadId: 'expired-reset', user_id: 'kept-profile', text: 'Qu’est-ce que tu sais de mes goûts ?' },
    });
    expect(inspected.json<{ responseText: string }>().responseText).toContain('photo');

    const unrelated = await app.inject({
      method: 'POST', url: '/v1/ingest', payload: { threadId: 'no-culture-context', text: 'Supprime la première.' },
    });
    expect(unrelated.json()).not.toMatchObject({ replyMeta: { source: 'local_profile' } });
  });
});

describe('Phase 5 Culture profile and proactive API', () => {
  let app: FastifyInstance;
  let directory: string;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'jarvis-culture-profile-routes-'));
    app = Fastify({ logger: false });
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await app.close();
    rmSync(directory, { recursive: true, force: true });
  });

  test('requires explicit reset confirmation and exports only the selected profile', async () => {
    registerCultureProfileRoutes(app, deps(env(join(directory, 'conversation.sqlite'))));
    expect((await app.inject({ method: 'POST', url: '/v1/culture/profile/reset', payload: { user_id: 'a' } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/v1/culture/profile/reset', payload: { user_id: 'a', confirm: true } })).statusCode).toBe(200);
    const exported = await app.inject({ method: 'GET', url: '/v1/culture/profile/export?user_id=a' });
    expect(exported.json()).toMatchObject({ data: { profile: { profileId: 'a' }, savedEntities: [], feedback: [] } });
  });

  test('only suppresses a proactive candidate after an idempotent delivery ack', async () => {
    const runtimeEnv = env(join(directory, 'conversation.sqlite'), true);
    registerCultureProfileRoutes(app, deps(runtimeEnv));
    const db = createConversationDb(runtimeEnv.CONVERSATION_DB_PATH);
    const repository = new CultureProfileRepository(db);
    repository.updatePreferences('proactive', { tagWeights: { jazz: 8 } });
    repository.setProactiveEnabled('proactive', true);
    db.close();
    installFetchMock();
    const first = await app.inject({
      method: 'POST', url: '/v1/culture/proactive/evaluate', payload: { user_id: 'proactive' },
    });
    const firstBody = first.json<{
      shouldNotify: boolean;
      reason: string;
      candidates: Array<{ fingerprint: string; entityType: string; entityId: string }>;
    }>();
    expect(firstBody).toMatchObject({ shouldNotify: true });
    const second = await app.inject({
      method: 'POST', url: '/v1/culture/proactive/evaluate', payload: { user_id: 'proactive' },
    });
    expect(second.json()).toMatchObject({ shouldNotify: true });
    const proposed = firstBody.candidates[0]!;
    const acknowledgement = {
      fingerprint: proposed.fingerprint,
      entityType: proposed.entityType,
      entityId: proposed.entityId,
    };
    const ack = await app.inject({
      method: 'POST', url: '/v1/culture/proactive/ack',
      payload: { user_id: 'proactive', ...acknowledgement, reason: firstBody.reason },
    });
    expect(ack.json()).toEqual({ acknowledged: true, duplicate: false });
    const duplicateAck = await app.inject({
      method: 'POST', url: '/v1/culture/proactive/ack',
      payload: { user_id: 'proactive', ...acknowledgement, reason: firstBody.reason },
    });
    expect(duplicateAck.json()).toEqual({ acknowledged: false, duplicate: true });
    const afterAck = await app.inject({
      method: 'POST', url: '/v1/culture/proactive/evaluate', payload: { user_id: 'proactive' },
    });
    expect(afterAck.json()).toMatchObject({ shouldNotify: false, reason: 'no_new_candidate_above_threshold' });

    const otherProfile = createConversationDb(runtimeEnv.CONVERSATION_DB_PATH);
    const otherRepository = new CultureProfileRepository(otherProfile);
    otherRepository.updatePreferences('other', { tagWeights: { jazz: 8 } });
    otherRepository.setProactiveEnabled('other', true);
    otherProfile.close();
    const isolated = await app.inject({
      method: 'POST', url: '/v1/culture/proactive/evaluate', payload: { user_id: 'other' },
    });
    expect(isolated.json()).toMatchObject({ shouldNotify: true });
  });
});
