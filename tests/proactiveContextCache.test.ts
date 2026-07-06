import { afterEach, describe, expect, it, jest } from '@jest/globals';
import Fastify from 'fastify';

import { ProactiveContextCache } from '../src/context/ProactiveContextCache';
import { type Env,loadEnv } from '../src/env';
import { registerContextCacheRoute } from '../src/routes/contextCache';
import type { AppDeps } from '../src/server';

function makeEnv(overrides: Record<string, string | undefined> = {}): Env {
  return loadEnv({
    REQUIRE_API_KEY: 'false',
    LOG_LEVEL: 'silent',
    PROACTIVE_CONTEXT_CACHE_ENABLED: 'true',
    PROACTIVE_CONTEXT_CACHE_AGENTS: 'weather,home,nas,spotify',
    ...overrides,
  });
}

function makeSpotifyStub(): AppDeps['spotifyWebApi'] {
  return {
    isConfigured: () => false,
    getNowPlaying: async () => ({ ok: false, error: 'not_configured' }),
    listDevicesPublic: async () => ({ ok: true, devices: [] }),
    startSituationPrefetch: () => undefined,
  } as unknown as AppDeps['spotifyWebApi'];
}

describe('ProactiveContextCache', () => {
  afterEach(() => {
    (global as { fetch?: unknown }).fetch = undefined;
    jest.useRealTimers();
  });

  it('builds prepared local weather answers from Home Assistant states', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-07-04T06:00:00+02:00'));
    const env = makeEnv({ PROACTIVE_CONTEXT_CACHE_AGENTS: 'weather' });
    const contextCache = new ProactiveContextCache({
      env,
      spotifyWebApi: makeSpotifyStub(),
      ha: {
        getStates: async () => [
          {
            entity_id: 'weather.maison',
            state: 'nuageux',
            attributes: {
              friendly_name: 'Maison',
              temperature: 18.4,
              humidity: 61,
              precipitation_probability: 20,
              forecast: [
                { datetime: '2026-07-04T08:00:00', condition: 'cloudy', temperature: 19, templow: 14, precipitation: 10 },
                { datetime: '2026-07-04T14:00:00', condition: 'sunny', temperature: 27, templow: 14, precipitation: 0 },
                { datetime: '2026-07-05T00:00:00', condition: 'rainy', temperature: 22, templow: 15, precipitation: 65 },
                { datetime: '2026-07-06T00:00:00', condition: 'partlycloudy', temperature: 24, templow: 16 },
              ],
            },
          },
        ],
      } as AppDeps['ha'],
    });

    const result = await contextCache.get('weather');

    expect(result?.domain).toBe('weather');
    expect(result?.snapshot.preparedAnswers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          questionKey: 'weather.temperature',
          answerText: expect.stringContaining('18'),
        }),
        expect.objectContaining({
          questionKey: 'weather.humidity',
          answerText: expect.stringContaining('61'),
        }),
        expect.objectContaining({
          questionKey: 'weather.today_high',
          answerText: expect.stringContaining('27°C'),
        }),
        expect.objectContaining({
          questionKey: 'weather.tomorrow',
          answerText: expect.stringContaining('65% pluie'),
        }),
        expect.objectContaining({
          questionKey: 'weather.weekly_trend',
          answerText: expect.stringContaining('Tendance semaine'),
        }),
        expect.objectContaining({
          questionKey: 'weather.today_by_hour',
          answerText: expect.stringContaining('14h'),
        }),
      ]),
    );
  });

  it('hydrates weather forecast from Home Assistant service when state forecast is empty', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-07-04T06:00:00+02:00'));
    const env = makeEnv({ PROACTIVE_CONTEXT_CACHE_AGENTS: 'weather' });
    const callService = jest.fn<NonNullable<AppDeps['ha']>['callService']>(async () => ({
      status: 200,
      data: {
        service_response: {
          'weather.maison': {
            forecast: [
              {
                datetime: '2026-07-04T05:00:00Z',
                condition: 'partlycloudy',
                temperature: 28.5,
                templow: 14.9,
                precipitation_probability: 10,
              },
            ],
          },
        },
      },
    }));
    const contextCache = new ProactiveContextCache({
      env,
      spotifyWebApi: makeSpotifyStub(),
      ha: {
        getStates: async () => [
          {
            entity_id: 'weather.maison',
            state: 'partlycloudy',
            attributes: {
              friendly_name: 'Maison',
              temperature: 22.5,
              forecast: [],
            },
          },
        ],
        callService,
      } as unknown as AppDeps['ha'],
    });

    const result = await contextCache.get('weather');

    expect(callService).toHaveBeenCalledWith({
      domain: 'weather',
      service: 'get_forecasts',
      serviceData: {
        entity_id: 'weather.maison',
        type: 'daily',
      },
      returnResponse: true,
    });
    expect(result?.snapshot.preparedAnswers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          questionKey: 'weather.today_high',
          answerText: expect.stringContaining('29°C'),
        }),
        expect.objectContaining({
          questionKey: 'weather.today_by_hour',
          answerText: expect.stringContaining('10%'),
        }),
      ]),
    );
  });

  it('assembles a daily brief from warm context domains', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-07-04T06:00:00+02:00'));
    const env = makeEnv({ PROACTIVE_CONTEXT_CACHE_AGENTS: 'weather,mail,todo,calendar,daily_brief' });
    const contextCache = new ProactiveContextCache({
      env,
      spotifyWebApi: makeSpotifyStub(),
      ha: {
        getStates: async () => [
          {
            entity_id: 'weather.maison',
            state: 'cloudy',
            attributes: {
              friendly_name: 'Maison',
              temperature: 18,
              forecast: [
                { datetime: '2026-07-04T00:00:00', condition: 'cloudy', temperature: 24, templow: 13 },
                { datetime: '2026-07-05T00:00:00', condition: 'rainy', temperature: 21, templow: 14 },
              ],
            },
          },
        ],
      } as AppDeps['ha'],
    });

    const result = await contextCache.get('daily_brief');

    expect(result?.snapshot.preparedAnswers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          questionKey: 'daily_brief.today',
          answerText: expect.stringContaining('Brief du jour'),
        }),
      ]),
    );
    expect(result?.snapshot.preparedAnswers[0]?.answerText).toContain('Meteo:');
  });

  it('uses OpenAI to prepare an oral daily brief without news', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-07-04T06:00:00+02:00'));
    const fetchMock = jest.fn(async (_url: unknown, init?: RequestInit) => {
      const body = String(init?.body ?? '');
      const parsedBody = JSON.parse(body) as { messages: Array<{ role: string; content: string }> };
      const systemPrompt = parsedBody.messages.find((message) => message.role === 'system')?.content ?? '';
      expect(body).toContain('currentTemperature');
      expect(body).toContain('rainRiskPercent');
      expect(systemPrompt).toContain('ignore newsletters');
      expect(systemPrompt).toContain('ne dis "urgent"');
      expect(body).not.toContain('Actu');
      expect(body).not.toContain('news.headlines');
      return new Response(JSON.stringify({
        choices: [{
          message: {
            content: 'Brief du jour: dehors il fait 18 degres, avec 24 au maximum. Agenda calme, surveille surtout les deux taches en retard.',
          },
        }],
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    (global as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;

    const env = makeEnv({
      PROACTIVE_CONTEXT_CACHE_AGENTS: 'weather,mail,todo,calendar,daily_brief,news',
      OPENAI_API_KEY: 'test-openai-key',
      OPENAI_BASE_URL: 'https://openai.test/v1',
      OPENAI_MODEL_SUMMARY: 'gpt-test',
      HELIX_NEWS_BASE_URL: 'http://helix.test',
    });
    const contextCache = new ProactiveContextCache({
      env,
      spotifyWebApi: makeSpotifyStub(),
      ha: {
        getStates: async () => [
          {
            entity_id: 'weather.maison',
            state: 'cloudy',
            attributes: {
              friendly_name: 'Maison',
              temperature: 18,
              precipitation_probability: 0,
              forecast: [
                { datetime: '2026-07-04T00:00:00', condition: 'cloudy', temperature: 24, templow: 13, precipitation: 0 },
              ],
            },
          },
        ],
      } as AppDeps['ha'],
    });

    const result = await contextCache.get('daily_brief');

    expect(result?.snapshot.preparedAnswers[0]?.answerText).toContain('dehors il fait 18 degres');
    expect(result?.snapshot.value).toMatchObject({
      sources: {
        weather: true,
        calendar: true,
        mail: true,
        todo: true,
      },
    });
    expect(JSON.stringify(result?.snapshot.value)).not.toContain('news');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://openai.test/v1/chat/completions');
  });

  it('exposes provider status and domain snapshots through the route', async () => {
    const env = makeEnv({ PROACTIVE_CONTEXT_CACHE_AGENTS: 'nas' });
    const contextCache = new ProactiveContextCache({
      env,
      spotifyWebApi: makeSpotifyStub(),
      nasStatus: {
        isConfigured: () => true,
        getStatus: async () => ({
          hostname: 'nas-test',
          generatedAt: '2026-07-04T08:00:00.000Z',
          uptimeSeconds: 123,
          load: { one: 0.2, five: 0.3, fifteen: 0.4 },
          memory: { totalBytes: 100, availableBytes: 40, usedPercent: 60 },
          swap: { totalBytes: 0, freeBytes: 0, usedPercent: 0 },
          filesystems: [{ mount: '/', totalBytes: 100, availableBytes: 55, usedPercent: 45 }],
          temperatures: [{ label: 'CPU', celsius: 41 }],
          protocols: [],
        }),
      } as unknown as AppDeps['nasStatus'],
    });
    const app = Fastify({ logger: false });
    registerContextCacheRoute(app, {
      env,
      spotifyWebApi: makeSpotifyStub(),
      contextCache,
    } as AppDeps);

    const statusResponse = await app.inject({ method: 'GET', url: '/v1/context-cache' });
    expect(statusResponse.statusCode).toBe(200);
    expect(statusResponse.json()).toMatchObject({
      status: 'ok',
      enabled: true,
      providers: expect.arrayContaining([
        expect.objectContaining({
          domain: 'nas',
          enabled: true,
          configured: true,
          metrics: expect.objectContaining({ hits: expect.any(Number), refreshes: expect.any(Number) }),
        }),
      ]),
    });

    const domainResponse = await app.inject({ method: 'GET', url: '/v1/context-cache?domain=nas&refresh=true' });
    expect(domainResponse.statusCode).toBe(200);
    expect(domainResponse.json()).toMatchObject({
      status: 'ok',
      domain: 'nas',
      snapshot: {
        preparedAnswers: expect.arrayContaining([
          expect.objectContaining({ questionKey: 'nas.health' }),
        ]),
      },
    });
    expect(domainResponse.json().snapshot.value).toBeUndefined();

    const detailResponse = await app.inject({ method: 'GET', url: '/v1/context-cache?domain=nas&detail=true' });
    expect(detailResponse.statusCode).toBe(200);
    expect(detailResponse.json()).toMatchObject({
      status: 'ok',
      domain: 'nas',
      snapshot: {
        value: expect.objectContaining({
          filesystems: expect.arrayContaining([
            expect.objectContaining({ mount: '/' }),
          ]),
        }),
      },
    });

    await app.close();
  });

  it('builds a news headline prepared answer from Helix items', async () => {
    const fetchMock = jest.fn(async (..._args: unknown[]) => new Response(JSON.stringify({
      items: [
        { title: 'Titre A', source: 'Source A', link: 'https://example.test/a' },
        { title: 'Titre B', source: 'Source B' },
      ],
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    (global as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;

    const env = makeEnv({
      PROACTIVE_CONTEXT_CACHE_AGENTS: 'news',
      HELIX_NEWS_BASE_URL: 'http://helix.test',
      HELIX_NEWS_API_TOKEN: 'news-token',
    });
    const contextCache = new ProactiveContextCache({
      env,
      spotifyWebApi: makeSpotifyStub(),
    });

    const result = await contextCache.get('news');

    expect(result?.snapshot.preparedAnswers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          questionKey: 'news.headlines',
          answerText: expect.stringContaining('Titre A'),
        }),
      ]),
    );
    expect(fetchMock.mock.calls[0]?.[0]).toBe('http://helix.test/v1/news/items?limit=8');
    expect(fetchMock.mock.calls[0]?.[1]).toEqual(expect.objectContaining({
      headers: expect.objectContaining({
        'x-api-token': 'news-token',
      }),
    }));
  });
});
