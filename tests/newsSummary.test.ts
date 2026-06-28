import { afterEach, describe, expect, it, jest } from '@jest/globals';
import Fastify from 'fastify';

import type { Env } from '../src/env';
import { registerNewsSummaryRoute } from '../src/routes/newsSummary';
import type { AppDeps } from '../src/server';

function deps(overrides: Partial<Env> = {}): AppDeps {
  return {
    env: {
      HELIX_NEWS_BASE_URL: 'http://helix.test',
      HELIX_NEWS_API_TOKEN: 'helix-token',
      HELIX_NEWS_TIMEOUT_MS: 1000,
      ...overrides,
    } as Env,
  } as AppDeps;
}

async function makeApp(appDeps = deps()) {
  const app = Fastify({ logger: false });
  registerNewsSummaryRoute(app, appDeps);
  return app;
}

describe('Helix news proxy', () => {
  afterEach(() => {
    (global as { fetch?: unknown }).fetch = undefined;
  });

  it('returns 503 when Helix is not configured', async () => {
    const app = await makeApp(deps({ HELIX_NEWS_BASE_URL: undefined }));
    const res = await app.inject({ method: 'GET', url: '/v1/news/items' });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ error: 'helix_news_not_configured' });
    await app.close();
  });

  it('proxies valid item queries with request correlation headers', async () => {
    const fetchMock = jest.fn(async (_url: string, _init?: RequestInit) => (
      new Response(JSON.stringify({ items: [{ title: 'A' }] }), { status: 200, headers: { 'content-type': 'application/json' } })
    ));
    (global as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;
    const app = await makeApp();

    const res = await app.inject({
      method: 'GET',
      url: '/v1/news/items?geoFilter=France&tab=top&sectors=tech,energie&limit=12',
      headers: { 'x-request-id': 'req-1', 'x-correlation-id': 'corr-1' },
    });

    expect(res.statusCode).toBe(200);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('limit=12');
    expect((init.headers as Record<string, string>)['x-request-id']).toBe('req-1');
    expect((init.headers as Record<string, string>)['x-correlation-id']).toBe('corr-1');
    await app.close();
  });

  it('rejects invalid query params', async () => {
    const app = await makeApp();
    const res = await app.inject({ method: 'GET', url: '/v1/news/items?limit=999&tab='.replace('tab=', 'tab=<script>') });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'invalid_query' });
    await app.close();
  });

  it('does not leak Helix error details', async () => {
    (global as { fetch: typeof fetch }).fetch = (async () => (
      new Response(JSON.stringify({ secret: 'internal detail' }), { status: 500, headers: { 'content-type': 'application/json' } })
    )) as unknown as typeof fetch;
    const app = await makeApp();

    const res = await app.inject({ method: 'GET', url: '/v1/news/items' });

    expect(res.statusCode).toBe(502);
    expect(JSON.stringify(res.json())).not.toContain('internal detail');
    await app.close();
  });

  it('returns a stable error for empty summaries', async () => {
    (global as { fetch: typeof fetch }).fetch = (async () => (
      new Response(JSON.stringify({ text: '' }), { status: 200, headers: { 'content-type': 'application/json' } })
    )) as unknown as typeof fetch;
    const app = await makeApp();

    const res = await app.inject({
      method: 'POST',
      url: '/v1/news/summary',
      payload: {
        scopeLabel: 'France',
        items: [
          { title: 'A' },
          { title: 'B' },
          { title: 'C' },
        ],
      },
    });

    expect(res.statusCode).toBe(502);
    expect(res.json()).toEqual({ error: 'helix_news_summary_empty' });
    await app.close();
  });
});
