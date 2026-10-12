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

  it('reports missing OAuth refresh token before calling Google Calendar', async () => {
    const fetchMock = jest.fn();
    (global as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;

    const section = await buildAgendaFromGoogle(env({
      GOOGLE_REFRESH_TOKEN: undefined,
      OAUTH_REFRESH_TOKEN_STORE_PATH: '/tmp/jarvis-missing-google-token.json',
    }));

    expect(section.status).toBe('error');
    expect(section.summary).toContain('Connecte Google via OAuth');
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

  it('discovers the connected member personal and writable shared calendars when none are configured', async () => {
    const fetchMock = jest.fn(async (url: string) => {
      const rawUrl = String(url);
      if (rawUrl.includes('oauth2.googleapis.com/token')) {
        return new Response(JSON.stringify({ access_token: 'access-token', expires_in: 3600 }), {
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
          items: [
            {
              id: 'personal-event',
              iCalUID: 'recurring-personal-event',
              summary: 'Rendez-vous personnel',
              start: { dateTime: '2026-07-01T09:00:00+02:00' },
              end: { dateTime: '2026-07-01T10:00:00+02:00' },
            },
            {
              id: 'personal-event-next',
              iCalUID: 'recurring-personal-event',
              summary: 'Rendez-vous personnel suivant',
              start: { dateTime: '2026-07-03T09:00:00+02:00' },
              end: { dateTime: '2026-07-03T10:00:00+02:00' },
            },
          ],
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (rawUrl.includes('/calendars/family/events')) {
        return new Response(JSON.stringify({
          items: [
            {
              id: 'same-invitation-from-shared-calendar',
              iCalUID: 'recurring-personal-event',
              summary: 'Rendez-vous personnel',
              start: { dateTime: '2026-07-01T09:00:00+02:00' },
              end: { dateTime: '2026-07-01T10:00:00+02:00' },
            },
            {
              id: 'family-event',
              summary: 'Diner famille',
              start: { dateTime: '2026-07-02T19:00:00+02:00' },
              end: { dateTime: '2026-07-02T21:00:00+02:00' },
            },
          ],
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      throw new Error(`unexpected fetch ${rawUrl}`);
    });
    (global as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;

    const section = await buildAgendaFromGoogle(env({ GOOGLE_CALENDAR_CALENDAR_IDS: undefined }), new Date('2026-07-01T06:00:00+02:00'));

    expect(section.status).toBe('ok');
    expect(section.items?.map((item) => 'title' in item ? item.title : '')).toEqual([
      'Rendez-vous personnel',
      'Diner famille',
      'Rendez-vous personnel suivant',
    ]);
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/calendars/week-numbers/events'))).toBe(false);
  });

  it('keeps every event in the expanded weekly dashboard instead of truncating after six', async () => {
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
          items: Array.from({ length: 8 }, (_, index) => ({
            id: `event-${index}`,
            summary: `Evenement ${index}`,
            start: { dateTime: `2026-07-0${index + 1}T09:00:00+02:00` },
            end: { dateTime: `2026-07-0${index + 1}T10:00:00+02:00` },
          })),
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      throw new Error(`unexpected fetch ${rawUrl}`);
    });
    (global as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;

    const section = await buildAgendaFromGoogle(env({ GOOGLE_CALENDAR_CALENDAR_IDS: 'primary' }), new Date('2026-07-01T06:00:00+02:00'));

    expect(section.items).toHaveLength(8);
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
