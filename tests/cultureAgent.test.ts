import { describe, expect, jest, test } from '@jest/globals';

import { createConversationDb, SqliteThreadRepository } from '../src/conversation/repositories/SqliteRepositories';
import { executeCulture, inferCultureRequest, resolveCultureWindow } from '../src/culture/cultureAgent';
import { loadEnv } from '../src/env';
import { ConversationResultSetRepository } from '../src/resultSets/ConversationResultSetRepository';

const source = {
  provider: 'scare',
  externalId: 'show-1',
  sourceUrl: null,
  fetchedAt: '2026-08-27T08:00:00.000Z',
  sourceModifiedAt: null,
  freshness: 'fresh',
  sourceType: 'open_data',
};

function candidate(id: string, title: string, occurrenceSuffix = id, venueName = 'Cinéma exact') {
  return {
    item: { id, type: 'movie', title, summary: null, categories: [], attributes: {} },
    occurrence: {
      id: `occ_${occurrenceSuffix}`,
      startsAt: '2026-08-28T18:30:00.000Z',
      endsAt: null,
      status: 'scheduled',
      price: null,
      isFree: null,
      bookingUrl: null,
      attributes: { version: 'VO' },
    },
    venue: { id: `venue_${occurrenceSuffix}`, name: venueName, distanceKm: 2.1 },
    source,
    rankReasons: ['nearby'],
  };
}

function discoverResponse(data = [candidate('item_aaaaaaaaaaaaaaaaaaaaaaaa', 'Film exact')]) {
  return {
    data,
    meta: {
      generatedAt: '2026-08-27T09:00:00.000Z',
      stale: false,
      partial: false,
      nextCursor: null,
      providers: [{ source: 'scare', status: 'fresh', lastSuccessAt: '2026-08-27T08:00:00.000Z' }],
    },
  };
}

describe('cultureAgent', () => {
  test('recognizes deterministic cinema constraints and title searches', () => {
    expect(inferCultureRequest('Quels films passent demain en VO ?')).toMatchObject({
      action: 'discover', slots: { types: ['movie'], version: 'VO' },
    });
    expect(inferCultureRequest('Séances de Dune demain soir en VOSTFR')).toMatchObject({
      action: 'find_occurrences', slots: { query: 'dune', version: 'VOSTFR' },
    });
    expect(inferCultureRequest('Où voir Film X demain ?')).toMatchObject({
      action: 'find_occurrences', slots: { query: 'film x' },
    });
    expect(inferCultureRequest('Où puis-je voir Film X demain ?')).toMatchObject({
      action: 'find_occurrences', slots: { query: 'film x' },
    });
    expect(inferCultureRequest('Quels cinémas ont des séances près de chez moi ?')?.action).toBe('find_venues');
    expect(inferCultureRequest('Pitche-moi les trois meilleurs films')).toMatchObject({
      action: 'recommend_candidates', slots: { limit: 3 },
    });
    expect(inferCultureRequest('Pitche-moi les trois meilleurs')).toBeNull();
    expect(inferCultureRequest('Qu’est-ce qui pourrait être sympa ce soir ?')).toMatchObject({
      action: 'recommend_candidates', slots: { types: ['movie'] },
    });
  });

  test('resolves Paris windows across days, evening midnight and multi-day periods', () => {
    const summerNow = new Date('2026-08-27T10:00:00.000Z');
    expect(resolveCultureWindow('aujourd’hui', summerNow)).toEqual({
      from: '2026-08-26T22:00:00.000Z', to: '2026-08-27T22:00:00.000Z',
    });
    expect(resolveCultureWindow('demain', summerNow)).toEqual({
      from: '2026-08-27T22:00:00.000Z', to: '2026-08-28T22:00:00.000Z',
    });
    expect(resolveCultureWindow('demain soir', summerNow)).toEqual({
      from: '2026-08-28T16:00:00.000Z', to: '2026-08-29T00:00:00.000Z',
    });
    expect(resolveCultureWindow('cette semaine', summerNow)).toEqual({
      from: '2026-08-26T22:00:00.000Z', to: '2026-09-02T22:00:00.000Z',
    });
  });

  test('sends exact location, interval and VO filters to Agora and stores generic references', async () => {
    const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue(new Response(JSON.stringify(discoverResponse()), {
      status: 200, headers: { 'content-type': 'application/json' },
    }));
    const db = createConversationDb(':memory:');
    await new SqliteThreadRepository(db).getOrCreate('culture-thread');
    const resultSets = new ConversationResultSetRepository(db);
    const env = loadEnv({
      REQUIRE_API_KEY: 'false',
      AGORA_BASE_URL: 'http://agora:8092',
      AGORA_API_TOKEN: 'a'.repeat(32),
      CULTURE_HOME_LATITUDE: '48.85',
      CULTURE_HOME_LONGITUDE: '2.35',
      CULTURE_DEFAULT_RADIUS_KM: '12',
    });
    const result = await executeCulture({
      action: 'discover',
      slots: { types: ['movie'], version: 'VO' },
      text: 'films demain soir en VO',
      threadId: 'culture-thread',
      env,
      resultSets,
      now: new Date('2026-08-27T10:00:00.000Z'),
    });
    expect(result.text).toContain('Film exact');
    expect(result.text).toContain('prix non communiqué');
    expect(resultSets.findActive('culture-thread')?.items[0]).toMatchObject({
      entityType: 'agora.item', entityId: 'item_aaaaaaaaaaaaaaaaaaaaaaaa',
    });
    const calledUrl = new URL(String(fetchMock.mock.calls[0]?.[0]));
    expect(calledUrl.searchParams.get('lat')).toBe('48.85');
    expect(calledUrl.searchParams.get('lon')).toBe('2.35');
    expect(calledUrl.searchParams.get('radiusKm')).toBe('12');
    expect(calledUrl.searchParams.get('from')).toBe('2026-08-28T16:00:00.000Z');
    expect(calledUrl.searchParams.get('to')).toBe('2026-08-29T00:00:00.000Z');
    expect(calledUrl.searchParams.get('version')).toBe('VO');
    expect(calledUrl.searchParams.get('limit')).toBe('50');
    fetchMock.mockRestore();
    db.close();
  });

  test('deduplicates movie discovery but preserves distinct explicit showtimes', async () => {
    const sameMovie = 'item_aaaaaaaaaaaaaaaaaaaaaaaa';
    const responseCandidates = [
      candidate(sameMovie, 'Film unique', 'showtime_1', 'Cinéma A'),
      candidate(sameMovie, 'Film unique', 'showtime_2', 'Cinéma B'),
      candidate('item_bbbbbbbbbbbbbbbbbbbbbbbb', 'Film B'),
    ];
    const fetchMock = jest.spyOn(global, 'fetch').mockImplementation(async () => (
      new Response(JSON.stringify(discoverResponse(responseCandidates)), { status: 200 })
    ));
    const db = createConversationDb(':memory:');
    const threads = new SqliteThreadRepository(db);
    await threads.getOrCreate('dedupe-thread');
    await threads.getOrCreate('showtimes-thread');
    const resultSets = new ConversationResultSetRepository(db);
    const env = loadEnv({
      REQUIRE_API_KEY: 'false', AGORA_BASE_URL: 'http://agora:8092', AGORA_API_TOKEN: 'a'.repeat(32),
      CULTURE_HOME_LATITUDE: '48.85', CULTURE_HOME_LONGITUDE: '2.35',
    });

    const discovery = await executeCulture({
      action: 'discover', slots: {}, text: 'films ce soir', threadId: 'dedupe-thread', env, resultSets,
    });
    expect(discovery.text.match(/Film unique/gu)).toHaveLength(1);
    expect(resultSets.findActive('dedupe-thread')?.items).toMatchObject([
      { entityType: 'agora.item', entityId: sameMovie },
      { entityType: 'agora.item', entityId: 'item_bbbbbbbbbbbbbbbbbbbbbbbb' },
    ]);

    const showtimes = await executeCulture({
      action: 'find_occurrences', slots: { query: 'Film unique' }, text: 'séances de Film unique ce soir',
      threadId: 'showtimes-thread', env, resultSets,
    });
    expect(showtimes.text.match(/Film unique/gu)).toHaveLength(2);
    expect(resultSets.findActive('showtimes-thread')?.items.slice(0, 2)).toMatchObject([
      { entityType: 'agora.occurrence', entityId: 'occ_showtime_1' },
      { entityType: 'agora.occurrence', entityId: 'occ_showtime_2' },
    ]);
    expect(new URL(String(fetchMock.mock.calls[1]?.[0])).searchParams.get('limit')).toBe('20');
    db.close();
  });

  test('prefers explicit coordinates, then client location, before configured home', async () => {
    const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue(new Response(JSON.stringify(discoverResponse()), { status: 200 }));
    const db = createConversationDb(':memory:');
    await new SqliteThreadRepository(db).getOrCreate('location-thread');
    const env = loadEnv({
      REQUIRE_API_KEY: 'false', AGORA_BASE_URL: 'http://agora:8092', AGORA_API_TOKEN: 'a'.repeat(32),
      CULTURE_HOME_LATITUDE: '40', CULTURE_HOME_LONGITUDE: '4',
    });
    await executeCulture({
      action: 'discover', slots: { latitude: 48.1, longitude: 2.1 }, text: 'films', threadId: 'location-thread',
      clientContext: { location: { latitude: 47, longitude: 3 } }, env,
      resultSets: new ConversationResultSetRepository(db),
    });
    const calledUrl = new URL(String(fetchMock.mock.calls[0]?.[0]));
    expect(calledUrl.searchParams.get('lat')).toBe('48.1');
    expect(calledUrl.searchParams.get('lon')).toBe('2.1');
    fetchMock.mockRestore();
    db.close();
  });

  test('answers clearly when location is unavailable without calling Agora', async () => {
    const fetchMock = jest.spyOn(global, 'fetch');
    const db = createConversationDb(':memory:');
    await new SqliteThreadRepository(db).getOrCreate('no-location');
    const env = loadEnv({ REQUIRE_API_KEY: 'false', AGORA_BASE_URL: 'http://agora:8092', AGORA_API_TOKEN: 'a'.repeat(32) });
    const result = await executeCulture({
      action: 'discover', slots: {}, text: 'films ce soir', threadId: 'no-location', env,
      resultSets: new ConversationResultSetRepository(db),
    });
    expect(result.text).toContain('besoin de ta position');
    expect(fetchMock).not.toHaveBeenCalled();
    fetchMock.mockRestore();
    db.close();
  });

  test('returns a factual empty result without creating a ResultSet', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue(new Response(JSON.stringify(discoverResponse([])), { status: 200 }));
    const db = createConversationDb(':memory:');
    await new SqliteThreadRepository(db).getOrCreate('empty-thread');
    const resultSets = new ConversationResultSetRepository(db);
    const env = loadEnv({
      REQUIRE_API_KEY: 'false', AGORA_BASE_URL: 'http://agora:8092', AGORA_API_TOKEN: 'a'.repeat(32),
      CULTURE_HOME_LATITUDE: '48.85', CULTURE_HOME_LONGITUDE: '2.35',
    });
    const result = await executeCulture({ action: 'discover', slots: {}, text: 'films', threadId: 'empty-thread', env, resultSets });
    expect(result.text).toContain('aucune séance');
    expect(resultSets.findActive('empty-thread')).toBeNull();
    db.close();
  });

  test('bounds an Ollama pitch to the requested three candidates', async () => {
    const candidates = Array.from({ length: 5 }, (_, index) => candidate(`item_${String(index).padStart(24, 'a')}`, `Film ${index + 1}`));
    const fetchMock = jest.spyOn(global, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify(discoverResponse(candidates)), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ message: { content: 'Je choisirais le film 2.' } }), { status: 200 }));
    const db = createConversationDb(':memory:');
    await new SqliteThreadRepository(db).getOrCreate('pitch-thread');
    const env = loadEnv({
      REQUIRE_API_KEY: 'false', AGORA_BASE_URL: 'http://agora:8092', AGORA_API_TOKEN: 'a'.repeat(32),
      CULTURE_HOME_LATITUDE: '48.85', CULTURE_HOME_LONGITUDE: '2.35', OLLAMA_BASE_URL: 'http://ollama:11434/v1',
    });
    const result = await executeCulture({
      action: 'recommend_candidates', slots: { limit: 3 }, text: 'Pitche-moi les trois meilleurs films',
      threadId: 'pitch-thread', env, resultSets: new ConversationResultSetRepository(db),
    });
    expect(result.text).toBe('Je choisirais le film 2.');
    const ollamaBody = JSON.parse(String((fetchMock.mock.calls[1]?.[1] as RequestInit | undefined)?.body)) as {
      messages: Array<{ role: string; content: string }>;
    };
    const userPrompt = ollamaBody.messages.find((message) => message.role === 'user')?.content ?? '';
    expect(userPrompt).toContain('Film 3');
    expect(userPrompt).not.toContain('Film 4');
    db.close();
  });
});
