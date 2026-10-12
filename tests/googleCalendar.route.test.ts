import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, jest } from '@jest/globals';
import Fastify from 'fastify';

import type { Env } from '../src/env';
import { registerGoogleCalendarRoute } from '../src/routes/googleCalendar';
import type { AppDeps } from '../src/server';

function env(): Env {
  return {
    GOOGLE_CLIENT_ID: 'google-client',
    GOOGLE_CLIENT_SECRET: 'google-secret',
    GOOGLE_REFRESH_TOKEN: 'refresh-token',
    GOOGLE_CALENDAR_CALENDAR_IDS: 'primary,work',
    GOOGLE_CALENDAR_DEFAULT_CREATE_CALENDAR_ID: 'primary',
    OAUTH_REFRESH_TOKEN_STORE_PATH: join(mkdtempSync(join(tmpdir(), 'jarvis-google-route-')), 'tokens.json'),
  } as unknown as Env;
}

function app() {
  const fastify = Fastify({ logger: false });
  registerGoogleCalendarRoute(fastify, { env: env() } as AppDeps);
  return fastify;
}

describe('google calendar route validation', () => {
  afterEach(() => {
    (global as { fetch?: unknown }).fetch = undefined;
  });

  it('rejects disallowed calendarId before calling Google', async () => {
    const fastify = app();
    const res = await fastify.inject({
      method: 'GET',
      url: '/v1/calendar/google/events?calendarId=private',
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'calendar_id_not_allowed' });
    await fastify.close();
  });

  it('aggregates the personal and writable shared calendars for the expanded agenda', async () => {
    const fetchMock = jest.fn(async (url: string) => {
      const rawUrl = String(url);
      if (rawUrl.includes('oauth2.googleapis.com/token')) {
        return new Response(JSON.stringify({ access_token: 'access-token' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (rawUrl.includes('/users/me/calendarList')) {
        return new Response(JSON.stringify({
          items: [
            { id: 'owner@example.test', primary: true, accessRole: 'owner' },
            { id: 'family', accessRole: 'writer' },
            { id: 'week-numbers', accessRole: 'reader' },
          ],
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (rawUrl.includes('/calendars/owner%40example.test/events')) {
        return new Response(JSON.stringify({
          items: [{
            id: 'personal',
            summary: 'Personnel',
            start: { dateTime: '2026-10-13T09:00:00+02:00' },
            end: { dateTime: '2026-10-13T10:00:00+02:00' },
          }],
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (rawUrl.includes('/calendars/family/events')) {
        return new Response(JSON.stringify({
          items: [{
            id: 'shared',
            summary: 'Partage',
            start: { dateTime: '2026-10-14T19:00:00+02:00' },
            end: { dateTime: '2026-10-14T20:00:00+02:00' },
          }],
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      throw new Error(`unexpected fetch ${rawUrl}`);
    });
    (global as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;
    const fastify = app();

    const res = await fastify.inject({
      method: 'GET',
      url: '/v1/calendar/google/events?calendarId=all&timeMin=2026-10-13T00%3A00%3A00.000Z&timeMax=2026-10-20T00%3A00%3A00.000Z',
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      status: 'ok',
      items: [
        { id: 'personal', summary: 'Personnel', calendarId: 'owner@example.test' },
        { id: 'shared', summary: 'Partage', calendarId: 'family' },
      ],
    });
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/calendars/week-numbers/events'))).toBe(false);
    await fastify.close();
  });

  it('rejects invalid sendUpdates values', async () => {
    const fastify = app();
    const res = await fastify.inject({
      method: 'DELETE',
      url: '/v1/calendar/google/events/event-1?calendarId=primary&sendUpdates=everyone',
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'invalid_send_updates' });
    await fastify.close();
  });

  it('rejects non-allowlisted writable event fields', async () => {
    const fastify = app();
    const res = await fastify.inject({
      method: 'PATCH',
      url: '/v1/calendar/google/events/event-1?calendarId=primary',
      payload: {
        summary: 'OK',
        conferenceData: { createRequest: {} },
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'invalid_body' });
    await fastify.close();
  });
});
