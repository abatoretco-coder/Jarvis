import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from '@jest/globals';
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
