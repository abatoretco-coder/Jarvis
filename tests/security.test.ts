import { describe, expect, test } from '@jest/globals';
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
    registerSecurityHooks(app);
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
    });
    expect(callbackWithoutState.statusCode).toBe(400);

    const callbackWithInvalidState = await app.inject({
      method: 'GET',
      url: '/v1/oauth/google/callback?code=fake&state=invalid',
    });
    expect(callbackWithInvalidState.statusCode).toBe(403);

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
    const app = Fastify();
    registerSecurityHooks(app);
    app.get('/health', async () => ({ status: 'ok' }));

    const response = await app.inject({ method: 'GET', url: '/health' });
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['x-frame-options']).toBe('DENY');
    expect(response.headers['cache-control']).toBe('no-store');
    await app.close();
  });
});
