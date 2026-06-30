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

function calendarApp() {
  const app = Fastify({ logger: false });
  registerIngestRoute(app, {
    env: env(join(mkdtempSync(join(tmpdir(), 'jarvis-calendar-ingest-')), 'conversation.sqlite')),
    spotifyWebApi: { isConfigured: () => false } as AppDeps['spotifyWebApi'],
  } as AppDeps);
  return app;
}

function openAiPlan(plan: Record<string, unknown>): Response {
  return new Response(JSON.stringify({
    choices: [{ message: { content: JSON.stringify(plan) } }],
  }), { status: 200, headers: { 'content-type': 'application/json' } });
}

function googleToken(): Response {
  return new Response(JSON.stringify({ access_token: 'access-token', expires_in: 3600 }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function googleEvents(items: Array<Record<string, unknown>>): Response {
  return new Response(JSON.stringify({ items }), { status: 200, headers: { 'content-type': 'application/json' } });
}

const dentistEvent = {
  id: 'event-dentist',
  summary: 'RDV dentiste',
  start: { dateTime: '2026-07-01T15:00:00+02:00' },
  end: { dateTime: '2026-07-01T16:00:00+02:00' },
};

describe('calendar ingest confirmation', () => {
  afterEach(() => {
    (global as { fetch?: unknown }).fetch = undefined;
  });

  it('returns a proposal for create_event without executing Google Calendar write', async () => {
    const fetchMock = jest.fn(async (url: string, _init?: RequestInit) => {
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
        text: 'Ajoute un RDV dentiste le 1er juillet a 15h',
        clientContext: { channel: 'desktop' },
      },
    });

    expect(res.statusCode).toBe(200);
    const payload = res.json() as { responseText: string; replyMeta?: Record<string, unknown> };
    expect(payload.responseText).toContain('Tu confirmes');
    expect(payload.responseText).not.toContain('confirme agenda cal');
    expect(payload.replyMeta?.proposalId).toMatch(/^cal/);
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

  it('confirms a pending mutation through REST idempotently', async () => {
    const fetchMock = jest.fn(async (url: string, init?: RequestInit) => {
      const rawUrl = String(url);
      if (rawUrl.includes('/chat/completions')) {
        return openAiPlan({
          action: 'create_event',
          summary: 'RDV garage',
          start: '2026-07-03T10:00:00',
          end: '2026-07-03T11:00:00',
        });
      }
      if (rawUrl.includes('oauth2.googleapis.com/token')) return googleToken();
      if (rawUrl.includes('/calendar/v3/calendars/primary/events')) {
        expect(init?.method).toBe('POST');
        return new Response(JSON.stringify({
          id: 'event-garage',
          summary: 'RDV garage',
          start: { dateTime: '2026-07-03T10:00:00+02:00' },
          end: { dateTime: '2026-07-03T11:00:00+02:00' },
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      throw new Error(`unexpected fetch ${rawUrl}`);
    });
    (global as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;

    const app = calendarApp();
    const first = await app.inject({
      method: 'POST',
      url: '/v1/ingest',
      payload: {
        threadId: 'thread-calendar-rest-confirm',
        text: 'Ajoute un RDV garage le 3 juillet a 10h',
        clientContext: { channel: 'desktop-rest' },
      },
    });
    const proposalId = String((first.json() as { replyMeta?: Record<string, unknown> }).replyMeta?.proposalId);

    const listed = await app.inject({ method: 'GET', url: '/v1/pending-mutations?threadId=thread-calendar-rest-confirm' });
    expect(listed.statusCode).toBe(200);
    expect((listed.json() as { items: unknown[] }).items).toHaveLength(1);

    const confirmPayload = { threadId: 'thread-calendar-rest-confirm', clientChannel: 'desktop-rest' };
    const confirmed = await app.inject({
      method: 'POST',
      url: `/v1/pending-mutations/${proposalId}/confirm`,
      payload: confirmPayload,
    });
    expect(confirmed.statusCode).toBe(200);
    expect((confirmed.json() as { status: string }).status).toBe('executed');

    const retry = await app.inject({
      method: 'POST',
      url: `/v1/pending-mutations/${proposalId}/confirm`,
      payload: confirmPayload,
    });
    expect(retry.statusCode).toBe(200);
    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes('/calendar/v3/calendars/primary/events'))).toHaveLength(1);
    await app.close();
  });

  it('refuses confirmation with a mismatched proposalId', async () => {
    const fetchMock = jest.fn(async (url: string, _init?: RequestInit) => {
      expect(String(url)).toContain('/chat/completions');
      return new Response(JSON.stringify({
        choices: [{ message: { content: JSON.stringify({
          action: 'create_event',
          summary: 'Garage',
          start: '2026-07-02T09:00:00',
          end: '2026-07-02T10:00:00',
        }) } }],
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    (global as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;

    const app = Fastify({ logger: false });
    registerIngestRoute(app, {
      env: env(join(mkdtempSync(join(tmpdir(), 'jarvis-calendar-ingest-')), 'conversation.sqlite')),
      spotifyWebApi: { isConfigured: () => false } as AppDeps['spotifyWebApi'],
    } as AppDeps);

    await app.inject({
      method: 'POST',
      url: '/v1/ingest',
      payload: {
        threadId: 'thread-calendar-wrong-proposal',
        text: 'Ajoute un rdv garage demain matin',
        clientContext: { channel: 'desktop-wrong-proposal' },
      },
    });

    const wrong = await app.inject({
      method: 'POST',
      url: '/v1/ingest',
      payload: {
        threadId: 'thread-calendar-wrong-proposal',
        text: 'confirme agenda caldeadbeef',
        clientContext: { channel: 'desktop-wrong-proposal' },
      },
    });

    expect(wrong.statusCode).toBe(409);
    expect(wrong.json()).toMatchObject({ error: 'proposal_id_mismatch' });
    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes('/calendar/v3/calendars/primary/events'))).toHaveLength(0);
    await app.close();
  });

  it('returns a delete_event proposal instead of OUT_OF_SCOPE for a nearby Calendar delete request', async () => {
    let searchUrl = '';
    const fetchMock = jest.fn(async (url: string, _init?: RequestInit) => {
      const rawUrl = String(url);
      if (rawUrl.includes('/chat/completions')) return openAiPlan({ action: 'delete_event', q: 'dentiste' });
      if (rawUrl.includes('oauth2.googleapis.com/token')) return googleToken();
      if (rawUrl.includes('/calendar/v3/calendars/primary/events')) {
        searchUrl = rawUrl;
        return googleEvents([dentistEvent]);
      }
      throw new Error(`unexpected fetch ${rawUrl}`);
    });
    (global as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;

    const app = calendarApp();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/ingest',
      payload: {
        threadId: 'thread-calendar-delete-proposal',
        text: 'supprime mon rendez-vous dentiste demain',
        clientContext: { channel: 'desktop-delete' },
      },
    });

    expect(res.statusCode).toBe(200);
    const payload = res.json() as { responseText: string; replyMeta?: Record<string, unknown> };
    expect(payload.responseText).toContain('Tu confirmes');
    expect(payload.responseText).not.toContain('Calendrier:');
    expect(payload.replyMeta?.proposalId).toMatch(/^cal/);
    expect(payload.responseText).not.toContain('OUT_OF_SCOPE');
    expect(payload.replyMeta).toMatchObject({
      kind: 'calendar',
      routeKey: 'calendar.delete_event',
      semanticDecision: 'confirmation_required',
    });
    expect(fetchMock.mock.calls.some(([url, init]) => String(url).includes('event-dentist') && init?.method === 'DELETE')).toBe(false);
    expect(searchUrl).toContain('timeMin=');
    expect(searchUrl).toContain('timeMax=');
    await app.close();
  });

  it('routes a typoed "evenment du jour" delete request with a symbolic event name to Calendar', async () => {
    const todayEvent = {
      id: 'event-em',
      summary: 'E&M',
      start: { dateTime: '2026-06-29T14:00:00+02:00' },
      end: { dateTime: '2026-06-29T15:00:00+02:00' },
    };
    let searchUrl = '';
    const fetchMock = jest.fn(async (url: string, _init?: RequestInit) => {
      const rawUrl = String(url);
      if (rawUrl.includes('/chat/completions')) return openAiPlan({ action: 'delete_event', q: 'mail' });
      if (rawUrl.includes('oauth2.googleapis.com/token')) return googleToken();
      if (rawUrl.includes('/calendar/v3/calendars/primary/events')) {
        searchUrl = rawUrl;
        return googleEvents([todayEvent]);
      }
      throw new Error(`unexpected fetch ${rawUrl}`);
    });
    (global as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;

    const app = calendarApp();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/ingest',
      payload: {
        threadId: 'thread-calendar-delete-today-symbol',
        text: "supprime mon evenment du jour E&M s'il te plait je peux plus y aller",
        clientContext: { channel: 'desktop-delete-today-symbol' },
      },
    });

    expect(res.statusCode).toBe(200);
    const payload = res.json() as { responseText: string; replyMeta?: Record<string, unknown> };
    expect(payload.responseText).toContain('Tu confirmes');
    expect(payload.responseText).not.toContain('confirme agenda cal');
    expect(payload.replyMeta?.proposalId).toMatch(/^cal/);
    expect(payload.responseText).not.toContain('OUT_OF_SCOPE');
    expect(payload.replyMeta).toMatchObject({
      kind: 'calendar',
      routeKey: 'calendar.delete_event',
      semanticDecision: 'confirmation_required',
    });
    expect(decodeURIComponent(searchUrl)).toContain('q=E&M');
    expect(searchUrl).toContain('timeMin=');
    expect(searchUrl).toContain('timeMax=');
    expect(decodeURIComponent(searchUrl)).toMatch(/timeMin=\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.000Z/);
    await app.close();
  });

  it('executes a pending delete_event from a short affirmative answer', async () => {
    const fetchMock = jest.fn(async (url: string, init?: RequestInit) => {
      const rawUrl = String(url);
      if (rawUrl.includes('/chat/completions')) return openAiPlan({ action: 'delete_event', q: 'dentiste' });
      if (rawUrl.includes('oauth2.googleapis.com/token')) return googleToken();
      if (rawUrl.includes('/calendar/v3/calendars/primary/events?')) return googleEvents([dentistEvent]);
      if (rawUrl.includes('/calendar/v3/calendars/primary/events/event-dentist')) {
        expect(init?.method).toBe('DELETE');
        return new Response(null, { status: 204 });
      }
      throw new Error(`unexpected fetch ${rawUrl}`);
    });
    (global as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;

    const app = calendarApp();
    const first = await app.inject({
      method: 'POST',
      url: '/v1/ingest',
      payload: {
        threadId: 'thread-calendar-delete-confirm',
        text: 'annule l evenement dentiste',
        clientContext: { channel: 'desktop-delete-confirm' },
      },
    });
    const proposalId = String((first.json() as { replyMeta?: Record<string, unknown> }).replyMeta?.proposalId);
    expect(proposalId).toMatch(/^cal/);

    const second = await app.inject({
      method: 'POST',
      url: '/v1/ingest',
      payload: {
        threadId: 'thread-calendar-delete-confirm',
        text: 'oui',
        clientContext: { channel: 'desktop-delete-confirm' },
      },
    });

    expect(second.statusCode).toBe(200);
    expect((second.json() as { replyMeta?: Record<string, unknown> }).replyMeta).toMatchObject({
      routeKey: 'calendar.delete_event',
      semanticDecision: 'confirmed',
    });
    expect(fetchMock.mock.calls.filter(([url, init]) => String(url).includes('event-dentist') && init?.method === 'DELETE')).toHaveLength(1);
    await app.close();
  });

  it('cancels a pending delete_event from a short negative answer', async () => {
    const fetchMock = jest.fn(async (url: string, _init?: RequestInit) => {
      const rawUrl = String(url);
      if (rawUrl.includes('/chat/completions')) return openAiPlan({ action: 'delete_event', q: 'dentiste' });
      if (rawUrl.includes('oauth2.googleapis.com/token')) return googleToken();
      if (rawUrl.includes('/calendar/v3/calendars/primary/events?')) return googleEvents([dentistEvent]);
      throw new Error(`unexpected fetch ${rawUrl}`);
    });
    (global as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;

    const app = calendarApp();
    await app.inject({
      method: 'POST',
      url: '/v1/ingest',
      payload: {
        threadId: 'thread-calendar-delete-cancel',
        text: 'annule l evenement dentiste',
        clientContext: { channel: 'desktop-delete-cancel' },
      },
    });

    const second = await app.inject({
      method: 'POST',
      url: '/v1/ingest',
      payload: {
        threadId: 'thread-calendar-delete-cancel',
        text: 'non',
        clientContext: { channel: 'desktop-delete-cancel' },
      },
    });

    expect(second.statusCode).toBe(200);
    expect((second.json() as { replyMeta?: Record<string, unknown> }).replyMeta).toMatchObject({
      routeKey: 'calendar.delete_event',
      semanticDecision: 'cancelled',
    });
    expect(fetchMock.mock.calls.some(([url, init]) => String(url).includes('event-dentist') && init?.method === 'DELETE')).toBe(false);
    await app.close();
  });

  it('returns an update_event proposal for changing an event time', async () => {
    const fetchMock = jest.fn(async (url: string, _init?: RequestInit) => {
      const rawUrl = String(url);
      if (rawUrl.includes('/chat/completions')) return openAiPlan({
        action: 'update_event',
        q: 'reunion',
        start: '2026-07-01T16:00:00',
        end: '2026-07-01T17:00:00',
      });
      if (rawUrl.includes('oauth2.googleapis.com/token')) return googleToken();
      if (rawUrl.includes('/calendar/v3/calendars/primary/events')) return googleEvents([{
        id: 'event-meeting',
        summary: 'Reunion equipe',
        start: { dateTime: '2026-07-01T14:00:00+02:00' },
        end: { dateTime: '2026-07-01T15:00:00+02:00' },
      }]);
      throw new Error(`unexpected fetch ${rawUrl}`);
    });
    (global as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;

    const app = calendarApp();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/ingest',
      payload: {
        threadId: 'thread-calendar-update-proposal',
        text: 'deplace la reunion a 16h',
        clientContext: { channel: 'desktop-update' },
      },
    });

    expect(res.statusCode).toBe(200);
    expect((res.json() as { replyMeta?: Record<string, unknown> }).replyMeta).toMatchObject({
      routeKey: 'calendar.update_event',
      semanticDecision: 'confirmation_required',
    });
    await app.close();
  });

  it('preserves event duration for start-only update_event confirmation', async () => {
    let patchBody = '';
    const fetchMock = jest.fn(async (url: string, init?: RequestInit) => {
      const rawUrl = String(url);
      if (rawUrl.includes('/chat/completions')) return openAiPlan({
        action: 'update_event',
        q: 'reunion',
        start: '2026-07-01T16:00:00',
      });
      if (rawUrl.includes('oauth2.googleapis.com/token')) return googleToken();
      if (rawUrl.includes('/calendar/v3/calendars/primary/events?')) return googleEvents([{
        id: 'event-meeting-start-only',
        summary: 'Reunion equipe',
        start: { dateTime: '2026-07-01T14:00:00+02:00' },
        end: { dateTime: '2026-07-01T15:00:00+02:00' },
      }]);
      if (rawUrl.includes('/calendar/v3/calendars/primary/events/event-meeting-start-only') && init?.method !== 'PATCH') {
        return new Response(JSON.stringify({
          id: 'event-meeting-start-only',
          summary: 'Reunion equipe',
          start: { dateTime: '2026-07-01T14:00:00+02:00' },
          end: { dateTime: '2026-07-01T15:00:00+02:00' },
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (rawUrl.includes('/calendar/v3/calendars/primary/events/event-meeting-start-only') && init?.method === 'PATCH') {
        patchBody = String(init.body);
        return new Response(JSON.stringify({ id: 'event-meeting-start-only' }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      throw new Error(`unexpected fetch ${rawUrl}`);
    });
    (global as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;

    const app = calendarApp();
    const first = await app.inject({
      method: 'POST',
      url: '/v1/ingest',
      payload: {
        threadId: 'thread-calendar-start-only',
        text: 'deplace la reunion a 16h',
        clientContext: { channel: 'desktop-start-only' },
      },
    });
    const proposalId = String((first.json() as { replyMeta?: Record<string, unknown> }).replyMeta?.proposalId);
    await app.inject({
      method: 'POST',
      url: '/v1/ingest',
      payload: {
        threadId: 'thread-calendar-start-only',
        text: `confirme agenda ${proposalId}`,
        clientContext: { channel: 'desktop-start-only' },
      },
    });
    expect(patchBody).toContain('"end"');
    expect(patchBody).toContain('17:00:00');
    await app.close();
  });

  it('returns a remove_from_event proposal for removing a reminder', async () => {
    const fetchMock = jest.fn(async (url: string, _init?: RequestInit) => {
      const rawUrl = String(url);
      if (rawUrl.includes('/chat/completions')) return openAiPlan({ action: 'remove_from_event', q: 'garage', field: 'reminders' });
      if (rawUrl.includes('oauth2.googleapis.com/token')) return googleToken();
      if (rawUrl.includes('/calendar/v3/calendars/primary/events')) return googleEvents([{
        id: 'event-garage',
        summary: 'Garage',
        start: { dateTime: '2026-07-02T09:00:00+02:00' },
        end: { dateTime: '2026-07-02T10:00:00+02:00' },
        reminders: { useDefault: true },
      }]);
      throw new Error(`unexpected fetch ${rawUrl}`);
    });
    (global as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;

    const app = calendarApp();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/ingest',
      payload: {
        threadId: 'thread-calendar-remove-reminder',
        text: 'retire le rappel de l evenement garage',
        clientContext: { channel: 'desktop-remove' },
      },
    });

    expect(res.statusCode).toBe(200);
    const payload = res.json() as { responseText: string; replyMeta?: Record<string, unknown> };
    expect(payload.responseText).toContain('Tu confirmes');
    expect(payload.responseText).not.toContain('confirme agenda cal');
    expect(payload.replyMeta?.proposalId).toMatch(/^cal/);
    expect(payload.replyMeta).toMatchObject({
      routeKey: 'calendar.remove_from_event',
      semanticDecision: 'confirmation_required',
    });
    await app.close();
  });

  it('does not patch when removing an absent attendee', async () => {
    const fetchMock = jest.fn(async (url: string, init?: RequestInit) => {
      const rawUrl = String(url);
      if (rawUrl.includes('/chat/completions')) return openAiPlan({
        action: 'remove_from_event',
        q: 'garage',
        field: 'attendee',
        attendeeEmail: 'absent@example.com',
      });
      if (rawUrl.includes('oauth2.googleapis.com/token')) return googleToken();
      if (rawUrl.includes('/calendar/v3/calendars/primary/events?')) return googleEvents([{
        id: 'event-attendee',
        summary: 'Garage',
        start: { dateTime: '2026-07-02T09:00:00+02:00' },
        end: { dateTime: '2026-07-02T10:00:00+02:00' },
      }]);
      if (rawUrl.includes('/calendar/v3/calendars/primary/events/event-attendee') && init?.method !== 'PATCH') {
        return new Response(JSON.stringify({
          id: 'event-attendee',
          attendees: [{ email: 'present@example.com' }],
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (rawUrl.includes('/calendar/v3/calendars/primary/events/event-attendee') && init?.method === 'PATCH') {
        throw new Error('PATCH should not be called');
      }
      throw new Error(`unexpected fetch ${rawUrl}`);
    });
    (global as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;

    const app = calendarApp();
    const first = await app.inject({
      method: 'POST',
      url: '/v1/ingest',
      payload: {
        threadId: 'thread-calendar-attendee-absent',
        text: 'retire absent@example.com de l evenement garage',
        clientContext: { channel: 'desktop-attendee' },
      },
    });
    const proposalId = String((first.json() as { replyMeta?: Record<string, unknown> }).replyMeta?.proposalId);
    const second = await app.inject({
      method: 'POST',
      url: '/v1/ingest',
      payload: {
        threadId: 'thread-calendar-attendee-absent',
        text: `confirme agenda ${proposalId}`,
        clientContext: { channel: 'desktop-attendee' },
      },
    });
    expect(second.statusCode).toBe(200);
    expect((second.json() as { responseText: string }).responseText).toContain('pas trouve');
    await app.close();
  });

  it('asks which event to use when multiple Calendar candidates match', async () => {
    const fetchMock = jest.fn(async (url: string, _init?: RequestInit) => {
      const rawUrl = String(url);
      if (rawUrl.includes('/chat/completions')) return openAiPlan({ action: 'update_event', q: 'garage', location: 'Atelier' });
      if (rawUrl.includes('oauth2.googleapis.com/token')) return googleToken();
      if (rawUrl.includes('/calendar/v3/calendars/primary/events')) return googleEvents([
        {
          id: 'event-garage-1',
          summary: 'Garage matin',
          start: { dateTime: '2026-07-02T09:00:00+02:00' },
          end: { dateTime: '2026-07-02T10:00:00+02:00' },
        },
        {
          id: 'event-garage-2',
          summary: 'Garage soir',
          start: { dateTime: '2026-07-02T18:00:00+02:00' },
          end: { dateTime: '2026-07-02T19:00:00+02:00' },
        },
      ]);
      throw new Error(`unexpected fetch ${rawUrl}`);
    });
    (global as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;

    const app = calendarApp();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/ingest',
      payload: {
        threadId: 'thread-calendar-ambiguous',
        text: 'change le lieu de l evenement garage',
        clientContext: { channel: 'desktop-ambiguous' },
      },
    });

    expect(res.statusCode).toBe(200);
    const payload = res.json() as { responseText: string; replyMeta?: Record<string, unknown> };
    expect(payload.responseText).toContain('Lequel dois-je modifier');
    expect(payload.replyMeta).toMatchObject({
      routeKey: 'calendar.update_event',
      semanticDecision: 'clarification_required',
    });
    expect(payload.replyMeta?.proposalId).toMatch(/^cal/);

    const second = await app.inject({
      method: 'POST',
      url: '/v1/ingest',
      payload: {
        threadId: 'thread-calendar-ambiguous',
        text: 'le deuxieme',
        clientContext: { channel: 'desktop-ambiguous' },
      },
    });
    expect(second.statusCode).toBe(200);
    expect((second.json() as { replyMeta?: Record<string, unknown> }).replyMeta).toMatchObject({
      routeKey: 'calendar.update_event',
      semanticDecision: 'confirmation_required',
    });
    await app.close();
  });
});

