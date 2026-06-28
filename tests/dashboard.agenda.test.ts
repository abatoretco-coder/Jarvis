import { afterEach, describe, expect, it, jest } from '@jest/globals';

import type { Env } from '../src/env';
import { buildAgendaFromGoogle } from '../src/routes/dashboard';

function env(overrides: Partial<Env> = {}): Env {
  return {
    GOOGLE_CLIENT_ID: 'google-client',
    GOOGLE_CLIENT_SECRET: 'google-secret',
    GOOGLE_REFRESH_TOKEN: 'refresh-token',
    GOOGLE_CALENDAR_CALENDAR_IDS: 'primary,work',
    ...overrides,
  } as unknown as Env;
}

describe('dashboard Google agenda', () => {
  afterEach(() => {
    (global as { fetch?: unknown }).fetch = undefined;
  });

  it('reports Google Calendar as not configured instead of pretending the agenda is empty', async () => {
    const fetchMock = jest.fn();
    (global as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;

    const section = await buildAgendaFromGoogle(env({
      GOOGLE_CLIENT_ID: undefined,
      GOOGLE_CLIENT_SECRET: undefined,
      GOOGLE_REFRESH_TOKEN: undefined,
    }));

    expect(section.status).toBe('error');
    expect(section.summary).toContain('Google Calendar n est pas configure');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns partial status when one configured calendar fails', async () => {
    const fetchMock = jest.fn(async (url: string) => {
      const rawUrl = String(url);
      if (rawUrl.includes('oauth2.googleapis.com/token')) {
        return new Response(JSON.stringify({ access_token: 'access-token', expires_in: 3600 }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (rawUrl.includes('/calendars/primary/events')) {
        return new Response(JSON.stringify({
          items: [{
            id: 'event-1',
            summary: 'Controle chantier',
            start: { dateTime: '2026-07-01T09:00:00+02:00' },
            end: { dateTime: '2026-07-01T10:00:00+02:00' },
          }],
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (rawUrl.includes('/calendars/work/events')) {
        return new Response('calendar unavailable', { status: 500 });
      }
      throw new Error(`unexpected fetch ${rawUrl}`);
    });
    (global as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;

    const section = await buildAgendaFromGoogle(env(), new Date('2026-07-01T06:00:00+02:00'));

    expect(section.status).toBe('partial');
    expect(section.summary).toContain('1 calendrier indisponible');
    expect(section.items).toHaveLength(1);
  });

  it('returns error status when every configured calendar fails', async () => {
    const fetchMock = jest.fn(async (url: string) => {
      const rawUrl = String(url);
      if (rawUrl.includes('oauth2.googleapis.com/token')) {
        return new Response(JSON.stringify({ access_token: 'access-token', expires_in: 3600 }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (rawUrl.includes('/calendar/v3/calendars/')) {
        return new Response('calendar unavailable', { status: 500 });
      }
      throw new Error(`unexpected fetch ${rawUrl}`);
    });
    (global as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;

    const section = await buildAgendaFromGoogle(env(), new Date('2026-07-01T06:00:00+02:00'));

    expect(section.status).toBe('error');
    expect(section.summary).toContain('Je n ai pas pu lire Google Calendar');
  });
});
