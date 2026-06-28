import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, jest } from '@jest/globals';
import Fastify from 'fastify';

import type { Env } from '../src/env';
import { registerIngestRoute } from '../src/routes/ingest';
import type { AppDeps } from '../src/server';

function env(dbPath: string): Env {
  return {
    HA_BASE_URL: 'http://ha.test:8123',
    HA_TOKEN: 'ha-token',
    HA_TIMEOUT_MS: 100,
    HA_CONVERSATION_MIN_INTERVAL_MS: 0,
    HA_CONVERSATION_RETRY_COUNT: 0,
    HA_CONVERSATION_RETRY_DELAY_MS: 0,
    OPENAI_API_KEY: 'openai-key',
    OPENAI_BASE_URL: 'https://api.openai.com/v1',
    OPENAI_MODEL_ROUTER: 'gpt-4o-mini',
    OPENAI_MODEL_SUMMARY: 'gpt-4o-mini',
    OPENAI_TIMEOUT_MS: 1000,
    ROUTER_TIMEOUT_MS: 500,
    ROUTER_CONFIDENCE_THRESHOLD: 0.7,
    HA_AGENT_GENERAL: 'conversation.openai_conversation',
    HA_AGENT_MAP: 'calendar:calendar:Agenda',
    CONVERSATION_DB_PATH: dbPath,
    CONVERSATION_RECENT_MESSAGES: 10,
    GOOGLE_CLIENT_ID: 'google-client',
    GOOGLE_CLIENT_SECRET: 'google-secret',
    GOOGLE_REFRESH_TOKEN: 'refresh-token',
    GOOGLE_CALENDAR_CALENDAR_IDS: 'primary',
    GOOGLE_CALENDAR_DEFAULT_CREATE_CALENDAR_ID: 'primary',
    OAUTH_REFRESH_TOKEN_STORE_PATH: join(tmpdir(), 'jarvis-google-test.json'),
  } as unknown as Env;
}

describe('calendar ingest confirmation', () => {
  afterEach(() => {
    (global as { fetch?: unknown }).fetch = undefined;
  });

  it('returns a proposal for create_event without executing Google Calendar write', async () => {
    const fetchMock = jest.fn(async (url: string) => {
      expect(url).toContain('/chat/completions');
      return new Response(JSON.stringify({
        choices: [{ message: { content: JSON.stringify({
          action: 'create_event',
          summary: 'RDV dentiste',
          start: '2026-07-01T15:00:00',
          end: '2026-07-01T16:00:00',
        }) } }],
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    (global as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;

    const app = Fastify({ logger: false });
    registerIngestRoute(app, {
      env: env(join(mkdtempSync(join(tmpdir(), 'jarvis-calendar-ingest-')), 'conversation.sqlite')),
      spotifyWebApi: { isConfigured: () => false } as AppDeps['spotifyWebApi'],
    } as AppDeps);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/ingest',
      payload: {
        threadId: 'thread-calendar-create',
        text: 'Ajoute un RDV dentiste le 1er juillet à 15h',
        clientContext: { channel: 'desktop' },
      },
    });

    expect(res.statusCode).toBe(200);
    const payload = res.json() as { responseText: string; replyMeta?: Record<string, unknown> };
    expect(payload.responseText).toContain('Confirme dans ce fil');
    expect(payload.responseText).toContain('confirme agenda cal');
    expect(payload.replyMeta).toMatchObject({
      kind: 'calendar',
      routeKey: 'calendar.create_event',
      semanticDecision: 'confirmation_required',
    });
    const tokenCalls = fetchMock.mock.calls.filter(([url]) => String(url).includes('oauth2.googleapis.com'));
    expect(tokenCalls).toHaveLength(0);
    await app.close();
  });

  it('executes a pending create_event only after same-thread confirmation', async () => {
    const fetchMock = jest.fn(async (url: string, init?: RequestInit) => {
      const rawUrl = String(url);
      if (rawUrl.includes('/chat/completions')) {
        return new Response(JSON.stringify({
          choices: [{ message: { content: JSON.stringify({
            action: 'create_event',
            summary: 'RDV dentiste',
            start: '2026-07-01T15:00:00',
            end: '2026-07-01T16:00:00',
          }) } }],
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (rawUrl.includes('oauth2.googleapis.com/token')) {
        return new Response(JSON.stringify({ access_token: 'access-token', expires_in: 3600 }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (rawUrl.includes('/calendar/v3/calendars/primary/events')) {
        expect(init?.method).toBe('POST');
        return new Response(JSON.stringify({
          id: 'event-1',
          summary: 'RDV dentiste',
          start: { dateTime: '2026-07-01T15:00:00+02:00' },
          end: { dateTime: '2026-07-01T16:00:00+02:00' },
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      throw new Error(`unexpected fetch ${rawUrl}`);
    });
    (global as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;

    const app = Fastify({ logger: false });
    registerIngestRoute(app, {
      env: env(join(mkdtempSync(join(tmpdir(), 'jarvis-calendar-ingest-')), 'conversation.sqlite')),
      spotifyWebApi: { isConfigured: () => false } as AppDeps['spotifyWebApi'],
    } as AppDeps);

    const first = await app.inject({
      method: 'POST',
      url: '/v1/ingest',
      payload: {
        threadId: 'thread-calendar-confirm',
        text: 'Ajoute un RDV dentiste le 1er juillet a 15h',
        clientContext: { channel: 'desktop-confirm' },
      },
    });

    expect(first.statusCode).toBe(200);
    const firstPayload = first.json() as { replyMeta?: Record<string, unknown> };
    const proposalId = String(firstPayload.replyMeta?.proposalId);
    expect(proposalId).toMatch(/^cal/);
    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes('/calendar/v3/calendars/primary/events'))).toHaveLength(0);

    const second = await app.inject({
      method: 'POST',
      url: '/v1/ingest',
      payload: {
        threadId: 'thread-calendar-confirm',
        text: `confirme agenda ${proposalId}`,
        clientContext: { channel: 'desktop-confirm' },
      },
    });

    expect(second.statusCode).toBe(200);
    const payload = second.json() as { responseText: string; replyMeta?: Record<string, unknown> };
    expect(payload.responseText).toContain('C\'est ajoute');
    expect(payload.replyMeta).toMatchObject({
      kind: 'calendar',
      routeKey: 'calendar.create_event',
      semanticDecision: 'confirmed',
    });
    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes('/calendar/v3/calendars/primary/events'))).toHaveLength(1);
    await app.close();
  });
});
