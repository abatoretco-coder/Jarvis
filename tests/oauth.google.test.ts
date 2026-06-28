import { describe, expect, it } from '@jest/globals';
import Fastify from 'fastify';

import type { Env } from '../src/env';
import { GOOGLE_OAUTH_SCOPES, googleRefreshTokenStoreKey } from '../src/google/googleCredentialService';
import { registerOAuthRoutes } from '../src/routes/oauth';
import type { AppDeps } from '../src/server';

function deps(overrides: Partial<Env> = {}): AppDeps {
  return {
    env: {
      REQUIRE_API_KEY: true,
      API_KEY: 'secret',
      API_KEYS: undefined,
      GOOGLE_CLIENT_ID: 'google-client',
      GOOGLE_CLIENT_SECRET: 'google-secret',
      OAUTH_REDIRECT_URI: 'http://127.0.0.1:8090/v1/oauth/google/callback',
      OAUTH_SETUP_ENABLED: false,
      ...overrides,
    } as Env,
  } as AppDeps;
}

describe('Google OAuth setup', () => {
  it('is disabled without API key or explicit setup flag', async () => {
    const app = Fastify({ logger: false });
    registerOAuthRoutes(app, deps());

    const res = await app.inject({ method: 'GET', url: '/v1/oauth/google/authorize' });

    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: 'oauth_setup_disabled' });
    await app.close();
  });

  it('requests Gmail and Calendar scopes', async () => {
    const app = Fastify({ logger: false });
    registerOAuthRoutes(app, deps({ OAUTH_SETUP_ENABLED: true }));

    const res = await app.inject({ method: 'GET', url: '/v1/oauth/google/authorize' });

    expect(res.statusCode).toBe(200);
    const payload = res.json() as { authorization_url: string };
    const url = new URL(payload.authorization_url);
    expect(url.searchParams.get('scope')?.split(' ')).toEqual([...GOOGLE_OAUTH_SCOPES]);
    expect(googleRefreshTokenStoreKey('google-client')).toBe('google:primary:google-client');
    await app.close();
  });
});
