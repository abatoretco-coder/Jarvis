import { afterEach, describe, expect, it, jest } from '@jest/globals';
import Fastify from 'fastify';

import { loadEnv } from '../src/env';
import type { UserPrincipal } from '../src/identity/IdentityService';
import { setRequestPrincipal } from '../src/identity/requestIdentity';
import type { IntegrationService } from '../src/integrations/IntegrationService';
import { buildMailSection, registerDashboardRoute } from '../src/routes/dashboard';
import type { AppDeps } from '../src/server';

const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
  jest.restoreAllMocks();
});

type TestAccount = { label: string; refreshToken: string };

function mailEnv(accounts: TestAccount[]) {
  return loadEnv({
    REQUIRE_API_KEY: 'false',
    LOG_LEVEL: 'silent',
    MAIL_ACCOUNTS_JSON: JSON.stringify(accounts.map((account) => ({
      ...account,
      provider: 'gmail',
      clientId: `client-${account.label}`,
      clientSecret: `secret-${account.label}`,
    }))),
  });
}

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function authHeader(init?: RequestInit): string {
  return (init?.headers as Record<string, string> | undefined)?.authorization ?? '';
}

function message(id: string, subject: string, internalDate?: string) {
  return {
    id,
    internalDate,
    snippet: `Contenu ${subject}`,
    payload: {
      headers: [
        { name: 'From', value: 'Camille <camille@example.test>' },
        { name: 'Subject', value: subject },
        { name: 'Date', value: internalDate ? new Date(Number(internalDate)).toUTCString() : 'date invalide' },
      ],
    },
  };
}

function userPrincipal(userId: string): UserPrincipal {
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

describe('dashboard mail reliability', () => {
  it('keeps identical Gmail ids separated by account and sorts results by date', async () => {
    const env = mailEnv([
      { label: 'perso', refreshToken: 'refresh-perso' },
      { label: 'travail', refreshToken: 'refresh-travail' },
    ]);
    global.fetch = jest.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('oauth2.googleapis.com/token')) {
        const refresh = new URLSearchParams(String(init?.body)).get('refresh_token');
        return json({ access_token: `access-${refresh}` });
      }
      if (url.includes('/messages?')) return json({ messages: [{ id: 'same-id' }] });
      if (url.includes('/messages/same-id?')) {
        return authHeader(init).includes('refresh-travail')
          ? json(message('same-id', 'Travail recent', '1791882000000'))
          : json(message('same-id', 'Personnel ancien', '1791792000000'));
      }
      throw new Error(`unexpected request: ${url}`);
    }) as typeof fetch;

    const section = await buildMailSection(env, Fastify({ logger: false }).log);

    expect(section.status).toBe('ok');
    expect(section.items).toMatchObject([
      { id: 'same-id', accountLabel: 'travail', subject: 'Travail recent' },
      { id: 'same-id', accountLabel: 'perso', subject: 'Personnel ancien' },
    ]);
  });

  it('reports partial when one account fails even if the other inbox is empty', async () => {
    const env = mailEnv([
      { label: 'disponible', refreshToken: 'refresh-ok' },
      { label: 'indisponible', refreshToken: 'refresh-fail' },
    ]);
    global.fetch = jest.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('oauth2.googleapis.com/token')) {
        const refresh = new URLSearchParams(String(init?.body)).get('refresh_token');
        if (refresh === 'refresh-fail') return json({ error: 'invalid_grant', error_description: 'sensitive detail' }, 400);
        return json({ access_token: 'access-ok' });
      }
      if (url.includes('/messages?')) return json({ messages: [] });
      throw new Error(`unexpected request: ${url}`);
    }) as typeof fetch;

    const section = await buildMailSection(env, Fastify({ logger: false }).log);

    expect(section.status).toBe('partial');
    expect(section.items).toEqual([]);
    expect(section.summary).toContain('1 boite indisponible');
  });

  it('reports error when every account fails and empty only after a successful empty search', async () => {
    const failedEnv = mailEnv([{ label: 'ko', refreshToken: 'refresh-ko' }]);
    global.fetch = jest.fn(async () => json({ error: 'invalid_grant' }, 400)) as typeof fetch;
    const failed = await buildMailSection(failedEnv, Fastify({ logger: false }).log);
    expect(failed.status).toBe('error');

    const emptyEnv = mailEnv([{ label: 'vide', refreshToken: 'refresh-vide' }]);
    global.fetch = jest.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('oauth2.googleapis.com/token')) return json({ access_token: 'access-vide' });
      if (url.includes('/messages?')) return json({ messages: [] });
      throw new Error(`unexpected request: ${url}`);
    }) as typeof fetch;
    const empty = await buildMailSection(emptyEnv, Fastify({ logger: false }).log);
    expect(empty.status).toBe('empty');
  });

  it('retries once with a fresh access token when Gmail rejects metadata with 401', async () => {
    const env = mailEnv([{ label: 'perso', refreshToken: 'refresh-perso' }]);
    let refreshCount = 0;
    const usedRefreshTokens: Array<string | null> = [];
    global.fetch = jest.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('oauth2.googleapis.com/token')) {
        refreshCount += 1;
        usedRefreshTokens.push(new URLSearchParams(String(init?.body)).get('refresh_token'));
        return json({
          access_token: `access-${refreshCount}`,
          ...(refreshCount === 1 ? { refresh_token: 'refresh-rotated' } : {}),
        });
      }
      if (url.includes('/messages?')) return json({ messages: [{ id: 'mail-1' }] });
      if (url.includes('/messages/mail-1?')) {
        return authHeader(init) === 'Bearer access-1'
          ? json({ error: 'expired token' }, 401)
          : json(message('mail-1', 'Recupere apres expiration', '1791792000000'));
      }
      throw new Error(`unexpected request: ${url}`);
    }) as typeof fetch;

    const section = await buildMailSection(env, Fastify({ logger: false }).log);

    expect(refreshCount).toBe(2);
    expect(usedRefreshTokens).toEqual(['refresh-perso', 'refresh-rotated']);
    expect(section.status).toBe('ok');
    expect(section.items).toMatchObject([{ id: 'mail-1', subject: 'Recupere apres expiration' }]);
  });

  it('keeps valid messages and reports partial for malformed metadata and timeouts', async () => {
    const env = mailEnv([{ label: 'perso', refreshToken: 'refresh-perso' }]);
    global.fetch = jest.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('oauth2.googleapis.com/token')) return json({ access_token: 'access' });
      if (url.includes('/messages?')) {
        return json({ messages: [{ id: 'valid' }, { id: 'malformed' }, { id: 'timeout' }, { nope: true }] });
      }
      if (url.includes('/messages/valid?')) return json(message('valid', 'Valide', '1791792000000'));
      if (url.includes('/messages/malformed?')) return json('not-an-object');
      if (url.includes('/messages/timeout?')) throw new DOMException('timed out', 'TimeoutError');
      throw new Error(`unexpected request: ${url}`);
    }) as typeof fetch;

    const section = await buildMailSection(env, Fastify({ logger: false }).log);

    expect(section.status).toBe('partial');
    expect(section.items).toMatchObject([{ id: 'valid', subject: 'Valide' }]);
    expect(section.summary).toContain('3 messages indisponibles');
  });

  it('reports error when every listed message is unusable and no reliable empty account remains', async () => {
    const env = mailEnv([{ label: 'perso', refreshToken: 'refresh-perso' }]);
    global.fetch = jest.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('oauth2.googleapis.com/token')) return json({ access_token: 'access' });
      if (url.includes('/messages?')) return json({ messages: [{ id: 'broken' }] });
      if (url.includes('/messages/broken?')) throw new DOMException('timed out', 'TimeoutError');
      throw new Error(`unexpected request: ${url}`);
    }) as typeof fetch;

    const section = await buildMailSection(env, Fastify({ logger: false }).log);

    expect(section.status).toBe('error');
    expect(section.items).toBeUndefined();
  });

  it('deduplicates a Gmail page and bounds concurrent metadata downloads', async () => {
    const ids = Array.from({ length: 12 }, (_, index) => `mail-${index}`);
    const env = mailEnv([{ label: 'perso', refreshToken: 'refresh-perso' }]);
    let active = 0;
    let maxActive = 0;
    global.fetch = jest.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('oauth2.googleapis.com/token')) return json({ access_token: 'access' });
      if (url.includes('/messages?')) return json({ messages: [{ id: ids[0] }, ...ids.map((id) => ({ id }))] });
      const id = ids.find((candidate) => url.includes(`/messages/${candidate}?`));
      if (id) {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active -= 1;
        return json(message(id, id));
      }
      throw new Error(`unexpected request: ${url}`);
    }) as typeof fetch;

    const section = await buildMailSection(env, Fastify({ logger: false }).log);

    expect(section.items).toHaveLength(12);
    expect(new Set((section.items ?? []).map((item) => item.id)).size).toBe(12);
    expect(maxActive).toBeLessThanOrEqual(6);
  });

  it('bounds deep pagination and deduplicates references on the selected page', async () => {
    const env = loadEnv({
      REQUIRE_API_KEY: 'false',
      LOG_LEVEL: 'silent',
      GOOGLE_CLIENT_ID: 'client',
      GOOGLE_CLIENT_SECRET: 'secret',
    });
    const app = Fastify({ logger: false });
    app.addHook('preHandler', async (request) => setRequestPrincipal(request, userPrincipal('alice')));
    registerDashboardRoute(app, {
      env,
      integrations: { resolveRefreshToken: () => 'refresh-alice' } as unknown as IntegrationService,
      spotifyWebApi: { isConfigured: () => false } as AppDeps['spotifyWebApi'],
    });
    let listCalls = 0;
    let metadataCalls = 0;
    global.fetch = jest.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('oauth2.googleapis.com/token')) return json({ access_token: 'access' });
      if (url.includes('/messages?')) {
        listCalls += 1;
        return listCalls === 21
          ? json({ messages: [{ id: 'last-page' }, { id: 'last-page' }], nextPageToken: 'page-21' })
          : json({ messages: [], nextPageToken: `page-${listCalls}` });
      }
      if (url.includes('/messages/last-page?')) {
        metadataCalls += 1;
        return json(message('last-page', 'Derniere page', '1791792000000'));
      }
      throw new Error(`unexpected request: ${url}`);
    }) as typeof fetch;

    const response = await app.inject({
      method: 'GET',
      url: '/v1/mail/messages?page=999&pageSize=100&accountLabel=gmail',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      page: 20,
      pageSize: 100,
      hasMore: true,
      items: [{ id: 'last-page', accountLabel: 'gmail' }],
    });
    expect(listCalls).toBe(21);
    expect(metadataCalls).toBe(1);
    await app.close();
  });

  it('orders invalid dates deterministically after dated messages', async () => {
    const env = mailEnv([{ label: 'perso', refreshToken: 'refresh-perso' }]);
    global.fetch = jest.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('oauth2.googleapis.com/token')) return json({ access_token: 'access' });
      if (url.includes('/messages?')) return json({ messages: [{ id: 'z-no-date' }, { id: 'dated' }, { id: 'a-no-date' }] });
      if (url.includes('/messages/dated?')) return json(message('dated', 'Date connue', '1791792000000'));
      if (url.includes('/messages/z-no-date?')) return json(message('z-no-date', 'Sans date Z'));
      if (url.includes('/messages/a-no-date?')) return json(message('a-no-date', 'Sans date A'));
      throw new Error(`unexpected request: ${url}`);
    }) as typeof fetch;

    const section = await buildMailSection(env, Fastify({ logger: false }).log);

    expect((section.items ?? []).map((item) => item.id)).toEqual(['dated', 'a-no-date', 'z-no-date']);
  });

  it('rejects an unknown account label instead of falling back to another authorized account', async () => {
    const env = loadEnv({
      REQUIRE_API_KEY: 'false',
      LOG_LEVEL: 'silent',
      GOOGLE_CLIENT_ID: 'client',
      GOOGLE_CLIENT_SECRET: 'secret',
    });
    const app = Fastify({ logger: false });
    app.addHook('preHandler', async (request) => setRequestPrincipal(request, userPrincipal('alice')));
    registerDashboardRoute(app, {
      env,
      integrations: {
        resolveRefreshToken: (userId: string) => userId === 'alice' ? 'refresh-alice' : undefined,
      } as unknown as IntegrationService,
      spotifyWebApi: { isConfigured: () => false } as AppDeps['spotifyWebApi'],
    });
    const fetchSpy = jest.fn<typeof fetch>();
    global.fetch = fetchSpy;

    const detail = await app.inject({
      method: 'GET',
      url: '/v1/mail/message?messageId=shared-id&accountLabel=bob',
    });
    const trash = await app.inject({
      method: 'POST',
      url: '/v1/mail/trash',
      payload: { messageId: 'shared-id', accountLabel: 'bob' },
    });

    expect(detail.statusCode).toBe(404);
    expect(detail.json()).toEqual({ error: 'mail_account_not_found' });
    expect(trash.statusCode).toBe(404);
    expect(trash.json()).toEqual({ error: 'mail_account_not_found' });
    expect(fetchSpy).not.toHaveBeenCalled();
    await app.close();
  });

  it('loads every active Gmail connection visible to the authenticated user and preserves provenance', async () => {
    const env = loadEnv({
      REQUIRE_API_KEY: 'false',
      LOG_LEVEL: 'silent',
      GOOGLE_CLIENT_ID: 'client',
      GOOGLE_CLIENT_SECRET: 'secret',
    });
    const listForUser = jest.fn((userId: string) => {
      expect(userId).toBe('alice');
      return [
        { connectionId: 'alice-perso', provider: 'gmail', status: 'active', displayName: 'Perso', providerEmail: 'alice@example.test' },
        { connectionId: 'household', provider: 'gmail', status: 'active', displayName: 'Foyer', providerEmail: 'home@example.test' },
        { connectionId: 'alice-suspended', provider: 'gmail', status: 'error', displayName: 'Suspendu', providerEmail: 'old@example.test' },
        { connectionId: 'calendar', provider: 'google-calendar', status: 'active', displayName: 'Agenda', providerEmail: 'alice@example.test' },
      ];
    });
    const resolveRefreshToken = jest.fn((userId: string, provider: string, connectionId?: string) => {
      expect(userId).toBe('alice');
      if (provider !== 'gmail') return undefined;
      return connectionId === 'alice-perso' || connectionId === 'household'
        ? `refresh-${connectionId}`
        : undefined;
    });
    const app = Fastify({ logger: false });
    app.addHook('preHandler', async (request) => setRequestPrincipal(request, userPrincipal('alice')));
    registerDashboardRoute(app, {
      env,
      integrations: {
        repository: { listForUser },
        resolveRefreshToken,
        rotateRefreshToken: jest.fn(),
      } as unknown as IntegrationService,
      spotifyWebApi: { isConfigured: () => false } as AppDeps['spotifyWebApi'],
    });
    global.fetch = jest.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('oauth2.googleapis.com/token')) {
        const refresh = new URLSearchParams(String(init?.body)).get('refresh_token');
        return json({ access_token: `access-${refresh}` });
      }
      if (url.includes('/messages?')) return json({ messages: [{ id: 'same-provider-id' }] });
      if (url.includes('/messages/same-provider-id?')) {
        const subject = authHeader(init).includes('alice-perso') ? 'Personnel' : 'Partage';
        return json(message('same-provider-id', subject, '1791792000000'));
      }
      if (url.includes('open-meteo.com') || url.includes('nominatim.openstreetmap.org')) {
        throw new Error('weather unavailable in mail test');
      }
      throw new Error(`unexpected request: ${url}`);
    }) as typeof fetch;

    const response = await app.inject({ method: 'GET', url: '/v1/dashboard' });

    expect(response.statusCode).toBe(200);
    expect(response.json().organization.mail).toMatchObject({
      status: 'ok',
      items: [
        { id: 'same-provider-id', accountLabel: 'Foyer', subject: 'Partage' },
        { id: 'same-provider-id', accountLabel: 'Perso', subject: 'Personnel' },
      ],
    });
    expect(resolveRefreshToken.mock.calls.filter((call) => call[1] === 'gmail').map((call) => call[2]))
      .toEqual(['alice-perso', 'household']);
    expect(resolveRefreshToken).not.toHaveBeenCalledWith('alice', 'gmail', 'alice-suspended');
    await app.close();
  });

  it('requires an account label for account-scoped operations when multiple accounts are visible', async () => {
    const env = loadEnv({
      REQUIRE_API_KEY: 'false',
      LOG_LEVEL: 'silent',
      GOOGLE_CLIENT_ID: 'client',
      GOOGLE_CLIENT_SECRET: 'secret',
    });
    const app = Fastify({ logger: false });
    app.addHook('preHandler', async (request) => setRequestPrincipal(request, userPrincipal('alice')));
    registerDashboardRoute(app, {
      env,
      integrations: {
        repository: {
          listForUser: () => [
            { connectionId: 'one', provider: 'gmail', status: 'active', displayName: 'One' },
            { connectionId: 'two', provider: 'gmail', status: 'active', displayName: 'Two' },
          ],
        },
        resolveRefreshToken: (_userId: string, _provider: string, connectionId?: string) => `refresh-${connectionId}`,
      } as unknown as IntegrationService,
      spotifyWebApi: { isConfigured: () => false } as AppDeps['spotifyWebApi'],
    });
    const fetchSpy = jest.fn<typeof fetch>();
    global.fetch = fetchSpy;

    const detail = await app.inject({ method: 'GET', url: '/v1/mail/message?messageId=shared-id' });
    const trash = await app.inject({ method: 'POST', url: '/v1/mail/trash', payload: { messageId: 'shared-id' } });

    expect(detail.statusCode).toBe(400);
    expect(detail.json()).toEqual({ error: 'mail_account_required' });
    expect(trash.statusCode).toBe(400);
    expect(trash.json()).toEqual({ error: 'mail_account_required' });
    expect(fetchSpy).not.toHaveBeenCalled();
    await app.close();
  });
});
