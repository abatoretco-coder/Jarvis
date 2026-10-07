import { afterEach, describe, expect, it, jest } from '@jest/globals';
import Fastify from 'fastify';

import { createConversationDb } from '../src/conversation/repositories/SqliteRepositories';
import type { Env } from '../src/env';
import type { UserPrincipal } from '../src/identity/IdentityService';
import { setRequestPrincipal } from '../src/identity/requestIdentity';
import { CredentialVault } from '../src/integrations/credentialVault';
import { IntegrationRepository } from '../src/integrations/IntegrationRepository';
import { IntegrationService } from '../src/integrations/IntegrationService';
import { registerGoogleCalendarRoute } from '../src/routes/googleCalendar';
import type { AppDeps } from '../src/server';

const originalFetch = global.fetch;
const encryptionKey = Buffer.alloc(32, 9).toString('base64');

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
    permissions: ['calendar'],
    sessionId: `session-${userId}`,
  };
}

describe('Google Calendar personal connection selection', () => {
  it('uses the authenticated user token and never the global fallback', async () => {
    const db = createConversationDb(':memory:');
    const repository = new IntegrationRepository(db);
    const vault = new CredentialVault(encryptionKey);
    for (const userId of ['alice', 'bob']) {
      db.prepare(
        `INSERT INTO users(user_id,email_normalized,status,created_at_ms,updated_at_ms)
         VALUES (?,?, 'active',1,1)`
      ).run(userId, `${userId}@example.test`);
      const connectionId = repository.beginOAuth({
        ownerUserId: userId,
        provider: 'google-calendar',
        kind: 'personal',
        scopes: ['https://www.googleapis.com/auth/calendar'],
        state: `state-${userId}`,
        codeVerifier: `verifier-${userId}`,
        redirectUri: 'https://jarvis.example.test/callback',
        expiresAtMs: Date.now() + 60_000,
      });
      const credentialId = `credential-${userId}`;
      repository.activate({
        connectionId,
        credentialId,
        encrypted: vault.encrypt(`refresh-${userId}`, credentialId),
        providerEmail: `${userId}@gmail.test`,
        scopes: ['https://www.googleapis.com/auth/calendar'],
      });
    }
    const env = {
      GOOGLE_CLIENT_ID: 'client',
      GOOGLE_CLIENT_SECRET: 'secret',
      GOOGLE_REFRESH_TOKEN: 'must-never-be-used',
      GOOGLE_CALENDAR_CALENDAR_IDS: 'primary',
      OAUTH_TOKEN_ENCRYPTION_KEY: encryptionKey,
      OAUTH_TOKEN_KEY_VERSION: 1,
    } as Env;
    const integrations = new IntegrationService(repository, env);
    const app = Fastify({ logger: false });
    app.addHook('preHandler', async (request) => {
      const userId = String(request.headers['x-test-user']);
      setRequestPrincipal(request, principal(userId));
    });
    registerGoogleCalendarRoute(app, {
      env,
      integrations,
      spotifyWebApi: { isConfigured: () => false } as AppDeps['spotifyWebApi'],
    });

    const refreshTokens: string[] = [];
    global.fetch = jest.fn(async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).includes('oauth2.googleapis.com/token')) {
        const refreshToken = new URLSearchParams(String(init?.body)).get('refresh_token')!;
        refreshTokens.push(refreshToken);
        return new Response(JSON.stringify({ access_token: refreshToken.replace('refresh-', 'access-') }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      const authorization = (init?.headers as Record<string, string>).authorization;
      const owner = authorization.replace('Bearer access-', '');
      return new Response(JSON.stringify({ items: [{ id: `event-${owner}`, summary: owner }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;

    const alice = await app.inject({
      method: 'GET',
      url: '/v1/calendar/google/events',
      headers: { 'x-test-user': 'alice' },
    });
    const bob = await app.inject({
      method: 'GET',
      url: '/v1/calendar/google/events',
      headers: { 'x-test-user': 'bob' },
    });
    expect(alice.json().items[0].id).toBe('event-alice');
    expect(bob.json().items[0].id).toBe('event-bob');
    expect(refreshTokens).toEqual(['refresh-alice', 'refresh-bob']);
    expect(refreshTokens).not.toContain('must-never-be-used');

    db.prepare("UPDATE users SET status='suspended' WHERE user_id='alice'").run();
    const suspended = await app.inject({
      method: 'GET',
      url: '/v1/calendar/google/events',
      headers: { 'x-test-user': 'alice' },
    });
    expect(suspended.statusCode).toBe(503);
    expect(refreshTokens).toHaveLength(2);
    await app.close();
    db.close();
  });
});
