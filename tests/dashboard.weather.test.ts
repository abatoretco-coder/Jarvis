import { afterEach, describe, expect, it, jest } from '@jest/globals';
import Fastify from 'fastify';

import { loadEnv } from '../src/env';
import { registerDashboardRoute } from '../src/routes/dashboard';
import type { AppDeps } from '../src/server';

function makeEnv(overrides: Record<string, string | undefined> = {}) {
  return loadEnv({
    REQUIRE_API_KEY: 'false',
    LOG_LEVEL: 'silent',
    ...overrides,
  });
}

function makeDeps(overrides: Partial<AppDeps> = {}): AppDeps {
  return {
    env: makeEnv(),
    spotifyWebApi: {
      isConfigured: () => false,
    } as AppDeps['spotifyWebApi'],
    ...overrides,
  };
}

describe('dashboard weather route', () => {
  afterEach(() => {
    (global as { fetch?: unknown }).fetch = undefined;
  });

  it('prefers desktop geolocation weather when coordinates are provided', async () => {
    const fetchMock = jest.fn(async (url: string) => {
      const rawUrl = String(url);
      if (rawUrl.includes('api.open-meteo.com')) {
        return new Response(JSON.stringify({
          current: {
            time: '2026-06-30T08:15',
            temperature_2m: 17.2,
            apparent_temperature: 16.0,
            weather_code: 3,
            relative_humidity_2m: 62,
            wind_speed_10m: 8.6,
            wind_direction_10m: 345,
            precipitation: 0,
          },
          daily: {
            time: ['2026-06-30'],
            weather_code: [3],
            temperature_2m_max: [27.6],
            temperature_2m_min: [16.7],
            precipitation_sum: [0],
            wind_speed_10m_max: [15.9],
          },
          hourly: {
            time: ['2026-06-30T08:00', '2026-06-30T09:00'],
            temperature_2m: [17.1, 17.8],
            precipitation_probability: [0, 0],
            weather_code: [3, 3],
          },
        }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (rawUrl.includes('nominatim.openstreetmap.org/reverse')) {
        return new Response(JSON.stringify({
          address: {
            house_number: '1',
            road: 'Square Auguste Renoir',
            suburb: 'Plaisance',
            city: 'Paris',
          },
        }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      throw new Error(`unexpected fetch ${rawUrl}`);
    });
    (global as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;

    const app = Fastify({ logger: false });
    registerDashboardRoute(app, makeDeps());

    const response = await app.inject({
      method: 'GET',
      url: '/v1/dashboard?latitude=48.8282838&longitude=2.3079543&accuracyM=25',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      weather: {
        location: '1 Square Auguste Renoir, Plaisance',
        temp: 17.2,
        tempMax: 27.6,
        tempMin: 16.7,
      },
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await app.close();
  });

  it('returns weather null if no device coordinates are provided', async () => {
    const app = Fastify({ logger: false });
    registerDashboardRoute(app, makeDeps());

    const response = await app.inject({
      method: 'GET',
      url: '/v1/dashboard',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      weather: null,
    });
    await app.close();
  });

  it('fails the request if geo weather fetch fails', async () => {
    const fetchMock = jest.fn(async () => new Response('upstream failure', { status: 500 }));
    (global as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;

    const app = Fastify({ logger: false });
    registerDashboardRoute(app, makeDeps());

    const response = await app.inject({
      method: 'GET',
      url: '/v1/dashboard?latitude=48.8282838&longitude=2.3079543',
    });

    expect(response.statusCode).toBe(500);
    await app.close();
  });
});
