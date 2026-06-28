import { describe, expect, jest, test } from '@jest/globals';
import Fastify from 'fastify';

import { loadEnv } from '../src/env';
import { registerApiKeyHook } from '../src/routes/apiKeyHook';
import { registerOAuthRoutes } from '../src/routes/oauth';
import { registerSecurityHooks } from '../src/routes/securityHooks';
import type { AppDeps } from '../src/server';

function makeEnv(overrides: Record<string, string | undefined> = {}) {
  return loadEnv({
    REQUIRE_API_KEY: 'true',
    API_KEY: 'test-api-key',
    GOOGLE_CLIENT_ID: 'google-client',
    GOOGLE_CLIENT_SECRET: 'google-secret',
    ...overrides,
  });
}

function makeDeps(env: ReturnType<typeof makeEnv>): AppDeps {
  return {
    env,
    spotifyWebApi: {
      isConfigured: () => false,
    } as AppDeps['spotifyWebApi'],
  };
}

describe('security hooks', () => {
  test('OAuth authorize requires an API key and callback requires a one-time state', async () => {
    const env = makeEnv();
    const app = Fastify();
    registerSecurityHooks(app, env);
    registerApiKeyHook(app, env);
    registerOAuthRoutes(app, makeDeps(env));

    const unauthorized = await app.inject({
      method: 'GET',
      url: '/v1/oauth/google/authorize',
    });
    expect(unauthorized.statusCode).toBe(401);

    const authorized = await app.inject({
      method: 'GET',
      url: '/v1/oauth/google/authorize',
      headers: { 'x-api-key': 'test-api-key' },
    });
    expect(authorized.statusCode).toBe(200);
    const authorizationUrl = new URL(authorized.json().authorization_url as string);
    expect(authorizationUrl.searchParams.get('state')).toHaveLength(43);

    const callbackWithoutState = await app.inject({
      method: 'GET',
      url: '/v1/oauth/google/callback?code=fake',
      headers: { 'x-api-key': 'test-api-key' },
    });
    expect(callbackWithoutState.statusCode).toBe(400);

    const callbackWithInvalidState = await app.inject({
      method: 'GET',
      url: '/v1/oauth/google/callback?code=fake&state=invalid',
    });
    expect(callbackWithInvalidState.statusCode).toBe(403);

    await app.close();
  });

  test('OAuth callback consumes a valid state without requiring an API key on Google redirect', async () => {
    const env = makeEnv();
    const app = Fastify();
    registerSecurityHooks(app, env);
    registerApiKeyHook(app, env);
    registerOAuthRoutes(app, makeDeps(env));
    const fetchMock = jest.fn(async () => new Response(JSON.stringify({ access_token: 'access-token' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    (global as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;

    const authorized = await app.inject({
      method: 'GET',
      url: '/v1/oauth/google/authorize',
      headers: { 'x-api-key': 'test-api-key' },
    });
    const authorizationUrl = new URL(authorized.json().authorization_url as string);
    const state = authorizationUrl.searchParams.get('state');

    const callback = await app.inject({
      method: 'GET',
      url: `/v1/oauth/google/callback?code=fake&state=${state}`,
    });

    expect(callback.statusCode).toBe(401);
    expect(callback.json()).toMatchObject({ error: 'no_refresh_token' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    (global as { fetch?: unknown }).fetch = undefined;
    await app.close();
  });

  test('ingest allowlist ignores a spoofed X-Forwarded-For header', async () => {
    const env = makeEnv({ INGEST_ALLOWLIST_IPS: '203.0.113.10' });
    const app = Fastify();
    registerApiKeyHook(app, env);
    app.post('/v1/ingest', async () => ({ ok: true }));

    const response = await app.inject({
      method: 'POST',
      url: '/v1/ingest',
      remoteAddress: '127.0.0.1',
      headers: {
        'x-api-key': 'test-api-key',
        'x-forwarded-for': '203.0.113.10',
      },
      payload: {},
    });

    expect(response.statusCode).toBe(403);
    await app.close();
  });

  test('adds defensive response headers', async () => {
    const env = makeEnv();
    const app = Fastify();
    registerSecurityHooks(app, env);
    app.get('/health', async () => ({ status: 'ok' }));

    const response = await app.inject({ method: 'GET', url: '/health' });
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['x-frame-options']).toBe('DENY');
    expect(response.headers['cache-control']).toBe('no-store');
    await app.close();
  });

  test('rate limit uses env settings for v1 routes', async () => {
    const env = makeEnv({
      RATE_LIMIT_WINDOW_MS: '60000',
      RATE_LIMIT_MAX: '10',
      RATE_LIMIT_MAX_TRACKED_CLIENTS: '100',
      REQUIRE_API_KEY: 'false',
    });
    const app = Fastify();
    registerSecurityHooks(app, env);
    app.get('/v1/ping', async () => ({ ok: true }));

    const responses = [];
    for (let index = 0; index < 11; index += 1) {
      responses.push(await app.inject({ method: 'GET', url: '/v1/ping' }));
    }

    expect(responses[0]?.statusCode).toBe(200);
    expect(responses[9]?.statusCode).toBe(200);
    expect(responses[10]?.statusCode).toBe(429);
    expect(responses[10]?.json()).toEqual({ error: 'rate_limited' });
    await app.close();
  });
});
