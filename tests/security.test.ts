import { describe, expect, test } from '@jest/globals';
import Fastify from 'fastify';

import { loadEnv } from '../src/env';
import { registerApiKeyHook } from '../src/routes/apiKeyHook';
import { registerPrincipalRateLimitHook, registerSecurityHooks } from '../src/routes/securityHooks';

function makeEnv(overrides: Record<string, string | undefined> = {}) {
  return loadEnv({
    REQUIRE_API_KEY: 'true',
    API_KEY: 'test-api-key',
    GOOGLE_CLIENT_ID: 'google-client',
    GOOGLE_CLIENT_SECRET: 'google-secret',
    ...overrides,
  });
}

describe('security hooks', () => {
  test('personal authorization rejects service credentials while the provider callback is public', async () => {
    const env = makeEnv();
    const app = Fastify();
    registerSecurityHooks(app, env);
    registerApiKeyHook(app, env);
    app.post('/v1/integrations/google-calendar/authorize', async () => ({ ok: true }));
    app.get('/v1/integrations/oauth/google/callback', async () => ({ ok: true }));
    app.get('/v1/integrations/oauth/callback', async () => ({ ok: true }));

    const unauthorized = await app.inject({
      method: 'POST',
      url: '/v1/integrations/google-calendar/authorize',
    });
    expect(unauthorized.statusCode).toBe(401);

    const authorized = await app.inject({
      method: 'POST',
      url: '/v1/integrations/google-calendar/authorize',
      headers: { 'x-api-key': 'test-api-key' },
    });
    expect(authorized.statusCode).toBe(403);
    expect(authorized.json()).toEqual({ error: 'human_account_required' });
    const callback = await app.inject({
      method: 'GET',
      url: '/v1/integrations/oauth/google/callback?code=fake&state=provider-state',
    });
    expect(callback.statusCode).toBe(200);
    const genericCallback = await app.inject({
      method: 'GET',
      url: '/v1/integrations/oauth/callback?code=fake&state=provider-state',
    });
    expect(genericCallback.statusCode).toBe(200);

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
    expect(response.headers['content-security-policy']).toContain("default-src 'none'");
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['strict-transport-security']).toBeUndefined();
    await app.close();
  });

  test('rejects an oversized body before the route handler runs', async () => {
    const env = makeEnv({ BODY_LIMIT_BYTES: '128', REQUIRE_API_KEY: 'false' });
    const app = Fastify({ bodyLimit: env.BODY_LIMIT_BYTES });
    let handled = false;
    registerSecurityHooks(app, env);
    app.post('/v1/ingest', async () => {
      handled = true;
      return { ok: true };
    });

    const response = await app.inject({
      method: 'POST',
      url: '/v1/ingest',
      payload: { text: 'x'.repeat(256) },
    });

    expect(response.statusCode).toBe(413);
    expect(handled).toBe(false);
    await app.close();
  });

  test('allows only exact configured browser origins and handles preflight locally', async () => {
    const env = makeEnv({
      REQUIRE_API_KEY: 'false',
      ALLOWED_ORIGINS: 'https://app.example.test',
    });
    const app = Fastify();
    registerSecurityHooks(app, env);
    app.get('/v1/ping', async () => ({ ok: true }));
    app.options('/v1/ping', async () => ({ ok: true }));

    const denied = await app.inject({
      method: 'GET',
      url: '/v1/ping',
      headers: { origin: 'https://evil.example.test' },
    });
    expect(denied.statusCode).toBe(403);
    expect(denied.headers['access-control-allow-origin']).toBeUndefined();

    const allowed = await app.inject({
      method: 'GET',
      url: '/v1/ping',
      headers: { origin: 'https://app.example.test' },
    });
    expect(allowed.statusCode).toBe(200);
    expect(allowed.headers['access-control-allow-origin']).toBe('https://app.example.test');

    const preflight = await app.inject({
      method: 'OPTIONS',
      url: '/v1/ping',
      headers: { origin: 'https://app.example.test' },
    });
    expect(preflight.statusCode).toBe(204);
    expect(preflight.headers['access-control-allow-headers']).toContain('Authorization');
    await app.close();
  });

  test('requires the trusted edge, HTTPS and the single public host in public mode', async () => {
    const secret = 'edge-secret-with-at-least-32-characters';
    const env = makeEnv({
      ALLOW_LEGACY_API_KEYS: 'false',
      OIDC_ENABLED: 'true',
      OIDC_ISSUER_URL: 'https://identity.example.test/realms/jarvis',
      OIDC_AUDIENCE: 'jarvis-api',
      PUBLIC_EDGE_ENABLED: 'true',
      PUBLIC_BASE_URL: 'https://jarvis.example.test',
      TRUSTED_PROXY_CIDRS: '127.0.0.1/32',
      EDGE_PROXY_SECRET: secret,
    });
    const app = Fastify({ trustProxy: ['127.0.0.1/32'] });
    registerSecurityHooks(app, env);
    app.get('/health', async () => ({ ok: true }));

    const missingEdge = await app.inject({ method: 'GET', url: '/health' });
    expect(missingEdge.statusCode).toBe(403);

    const insecure = await app.inject({
      method: 'GET',
      url: '/health',
      headers: { 'x-jarvis-edge-secret': secret, 'x-forwarded-host': 'jarvis.example.test' },
    });
    expect(insecure.statusCode).toBe(426);

    const wrongHost = await app.inject({
      method: 'GET',
      url: '/health',
      headers: {
        'x-jarvis-edge-secret': secret,
        'x-forwarded-proto': 'https',
        'x-forwarded-host': 'other.example.test',
      },
    });
    expect(wrongHost.statusCode).toBe(421);

    const allowed = await app.inject({
      method: 'GET',
      url: '/health',
      headers: {
        'x-jarvis-edge-secret': secret,
        'x-forwarded-proto': 'https',
        'x-forwarded-host': 'jarvis.example.test',
      },
    });
    expect(allowed.statusCode).toBe(200);
    expect(allowed.headers['strict-transport-security']).toBe('max-age=31536000');
    await app.close();
  });

  test('rate limits non-API probes when public mode is enabled', async () => {
    const env = makeEnv({
      ALLOW_LEGACY_API_KEYS: 'false',
      OIDC_ENABLED: 'true',
      OIDC_ISSUER_URL: 'https://identity.example.test/realms/jarvis',
      OIDC_AUDIENCE: 'jarvis-api',
      PUBLIC_EDGE_ENABLED: 'true',
      PUBLIC_BASE_URL: 'https://jarvis.example.test',
      TRUSTED_PROXY_CIDRS: '127.0.0.1/32',
      EDGE_PROXY_SECRET: 'edge-secret-with-at-least-32-characters',
      RATE_LIMIT_MAX: '10',
    });
    const app = Fastify({ trustProxy: ['127.0.0.1/32'] });
    registerSecurityHooks(app, env);
    app.get('/health', async () => ({ ok: true }));

    const responses = [];
    for (let index = 0; index < 11; index += 1) {
      responses.push(await app.inject({ method: 'GET', url: '/health' }));
    }

    expect(responses[0]?.statusCode).toBe(403);
    expect(responses[9]?.statusCode).toBe(403);
    const limited = responses[10];
    expect(limited?.statusCode).toBe(429);
    expect(limited?.headers['x-ratelimit-scope']).toBe('ip');
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

  test('scopes named service credentials to their declared permissions', async () => {
    const token = 'service-token-with-at-least-32-characters';
    const env = makeEnv({
      ALLOW_LEGACY_API_KEYS: 'false',
      SERVICE_API_KEYS_JSON: JSON.stringify([{ id: 'chat-client', token, permissions: ['chat'] }]),
    });
    const app = Fastify();
    registerApiKeyHook(app, env);
    app.get('/v1/ping', async () => ({ ok: true }));
    app.get('/v1/admin/users', async () => ({ ok: true }));
    app.get('/v1/mail/messages', async () => ({ ok: true }));

    const allowed = await app.inject({
      method: 'GET',
      url: '/v1/ping',
      headers: { 'x-api-key': token },
    });
    const denied = await app.inject({
      method: 'GET',
      url: '/v1/admin/users',
      headers: { 'x-api-key': token },
    });
    const mailDenied = await app.inject({
      method: 'GET',
      url: '/v1/mail/messages',
      headers: { 'x-api-key': token },
    });
    const legacyDenied = await app.inject({
      method: 'GET',
      url: '/v1/ping',
      headers: { 'x-api-key': 'test-api-key' },
    });
    expect(allowed.statusCode).toBe(200);
    expect(denied.statusCode).toBe(403);
    expect(mailDenied.statusCode).toBe(403);
    expect(legacyDenied.statusCode).toBe(401);
    await app.close();
  });

  test('defers ingest authorization until the selected capability is known', async () => {
    const token = 'music-service-token-with-at-least-32-characters';
    const env = makeEnv({
      ALLOW_LEGACY_API_KEYS: 'false',
      SERVICE_API_KEYS_JSON: JSON.stringify([
        { id: 'music-client', token, permissions: ['music'] },
      ]),
    });
    const app = Fastify();
    registerApiKeyHook(app, env);
    app.post('/v1/ingest', async () => ({ ok: true }));

    const response = await app.inject({
      method: 'POST',
      url: '/v1/ingest',
      headers: { 'x-api-key': token },
      payload: {},
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true });
    await app.close();
  });

  test('applies a stricter independent limiter to authentication routes', async () => {
    const env = makeEnv({
      RATE_LIMIT_AUTH_MAX: '5',
      RATE_LIMIT_MAX: '100',
      REQUIRE_API_KEY: 'false',
    });
    const app = Fastify();
    registerSecurityHooks(app, env);
    app.get('/v1/auth/me', async () => ({ ok: true }));
    const responses = [];
    for (let index = 0; index < 6; index += 1)
      responses.push(await app.inject({ method: 'GET', url: '/v1/auth/me' }));
    expect(responses[4]?.statusCode).toBe(200);
    expect(responses[5]?.statusCode).toBe(429);
    await app.close();
  });

  test('limits a credential across different client IPs', async () => {
    const token = 'home-service-token-with-at-least-32-characters';
    const env = makeEnv({
      ALLOW_LEGACY_API_KEYS: 'false',
      SERVICE_API_KEYS_JSON: JSON.stringify([{ id: 'home-client', token, permissions: ['home'] }]),
      RATE_LIMIT_SENSITIVE_MAX: '5',
      RATE_LIMIT_MAX: '100',
    });
    const app = Fastify();
    registerSecurityHooks(app, env);
    registerApiKeyHook(app, env);
    registerPrincipalRateLimitHook(app, env);
    app.post('/v1/home/actions', async () => ({ ok: true }));

    const responses = [];
    for (let index = 0; index < 6; index += 1) {
      responses.push(
        await app.inject({
          method: 'POST',
          url: '/v1/home/actions',
          remoteAddress: index % 2 ? '192.0.2.10' : '192.0.2.11',
          headers: { 'x-api-key': token },
        })
      );
    }
    expect(responses[4]?.statusCode).toBe(200);
    expect(responses[5]?.statusCode).toBe(429);
    expect(responses[5]?.headers['x-ratelimit-scope']).toBe('account');
    await app.close();
  });
});
