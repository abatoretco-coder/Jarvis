import { afterEach, describe, expect, it, jest } from '@jest/globals';
import Fastify from 'fastify';

import { loadEnv } from '../src/env';
import type { UserPrincipal } from '../src/identity/IdentityService';
import { setRequestPrincipal } from '../src/identity/requestIdentity';
import type { IntegrationService } from '../src/integrations/IntegrationService';
import { registerDashboardRoute } from '../src/routes/dashboard';
import type { AppDeps } from '../src/server';

const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
  jest.restoreAllMocks();
});

function principal(userId: string): UserPrincipal {
  return {
    kind: 'user',
    userId,
    email: `${userId}@example.test`,
    displayName: userId,
    status: 'active',
    roles: ['resident'],
    permissions: ['mail'],
    sessionId: `session-${userId}`,
  };
}

describe('dashboard personal Gmail connection', () => {
  it('loads mail with the authenticated user token and never the global fallback', async () => {
    const env = loadEnv({
      REQUIRE_API_KEY: 'false',
      LOG_LEVEL: 'silent',
      GOOGLE_CLIENT_ID: 'client',
      GOOGLE_CLIENT_SECRET: 'secret',
      GOOGLE_REFRESH_TOKEN: 'must-never-be-used',
      OAUTH_REFRESH_TOKEN_STORE_PATH: 'must-never-be-read.json',
    });
    const resolveRefreshToken = jest.fn<(
      userId: string,
      provider: string,
      connectionId?: string,
    ) => string | undefined>((userId, provider) =>
      provider === 'gmail' ? `refresh-${userId}` : undefined,
    );
    const app = Fastify({ logger: false });
    app.addHook('preHandler', async (request) => {
      setRequestPrincipal(request, principal('alice'));
    });
    registerDashboardRoute(app, {
      env,
      integrations: { resolveRefreshToken } as unknown as IntegrationService,
      spotifyWebApi: { isConfigured: () => false } as AppDeps['spotifyWebApi'],
    });

    const refreshTokens: string[] = [];
    global.fetch = jest.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('oauth2.googleapis.com/token')) {
        const refreshToken = new URLSearchParams(String(init?.body)).get('refresh_token')!;
        refreshTokens.push(refreshToken);
        return new Response(JSON.stringify({ access_token: 'access-alice' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.includes('gmail.googleapis.com/gmail/v1/users/me/messages?')) {
        expect((init?.headers as Record<string, string>).authorization).toBe('Bearer access-alice');
        return new Response(JSON.stringify({ messages: [{ id: 'message-alice' }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.includes('gmail.googleapis.com/gmail/v1/users/me/messages/message-alice?')) {
        return new Response(JSON.stringify({
          id: 'message-alice',
          internalDate: '1791792000000',
          snippet: 'Le contenu utile du message',
          payload: {
            headers: [
              { name: 'From', value: 'Camille <camille@example.test>' },
              { name: 'Subject', value: 'Message personnel' },
              { name: 'Date', value: 'Mon, 12 Oct 2026 10:00:00 +0200' },
            ],
          },
        }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      throw new Error(`unavailable test dependency: ${url}`);
    }) as typeof fetch;

    const response = await app.inject({ method: 'GET', url: '/v1/dashboard' });

    expect(response.statusCode).toBe(200);
    expect(response.json().organization.mail).toMatchObject({
      source: 'jarvis-mail',
      status: 'ok',
      items: [{ id: 'message-alice', subject: 'Message personnel' }],
    });
    expect(resolveRefreshToken).toHaveBeenCalledWith('alice', 'gmail', undefined);
    expect(refreshTokens).toEqual(['refresh-alice']);
    expect(refreshTokens).not.toContain('must-never-be-used');

    await app.close();
  });
});
