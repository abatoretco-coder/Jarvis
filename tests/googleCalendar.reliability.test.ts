import { afterEach, describe, expect, it, jest } from '@jest/globals';

jest.mock('../src/google/googleCredentialService', () => ({
  resolveGoogleCredentials: jest.fn(async (env: { GOOGLE_REFRESH_TOKEN?: string }) => ({
    clientId: 'client-id',
    clientSecret: 'client-secret',
    refreshToken: env.GOOGLE_REFRESH_TOKEN ?? 'refresh-token',
  })),
}));

import {
  type CalendarAgentEnv,
  executeCalendarAgentAction,
  parseCalendarAction,
  prepareCalendarMutationAction,
} from '../src/calendar/calendarAgent';
import {
  type CalendarTokenEnv,
  discoverOwnedCalendarIds,
  fetchUpcomingEventsMultiCalendarDetailed,
  stopGoogleCalendarTokenKeepalives,
  toGoogleCalendarTimeBoundary,
} from '../src/calendar/googleCalendarClient';

const originalFetch = global.fetch;

function env(name: string): CalendarAgentEnv & CalendarTokenEnv {
  return {
    GOOGLE_CLIENT_ID: 'client-id',
    GOOGLE_CLIENT_SECRET: 'client-secret',
    GOOGLE_REFRESH_TOKEN: `refresh-${name}`,
    GOOGLE_CALENDAR_CALENDAR_IDS: 'primary,family',
    GOOGLE_CALENDAR_DEFAULT_CREATE_CALENDAR_ID: 'primary',
    OPENAI_BASE_URL: 'https://api.openai.com/v1',
    OPENAI_TIMEOUT_MS: 1_000,
  };
}

function json(payload: unknown, status = 200, headers?: HeadersInit): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function token(value = 'access'): Response {
  return json({ access_token: value, expires_in: 3_600 });
}

afterEach(async () => {
  await stopGoogleCalendarTokenKeepalives();
  global.fetch = originalFetch;
  jest.restoreAllMocks();
});

describe('Google Calendar reliability', () => {
  it('paginates calendar discovery instead of silently omitting writable calendars', async () => {
    const requested: string[] = [];
    global.fetch = jest.fn(async (input) => {
      const url = String(input);
      requested.push(url);
      if (url.includes('oauth2.googleapis.com/token')) return token();
      if (!url.includes('pageToken=')) {
        return json({
          items: [{ id: 'primary-id', summary: 'Personnel', primary: true, accessRole: 'owner' }],
          nextPageToken: 'page-2',
        });
      }
      return json({ items: [{ id: 'family', summary: 'Famille', accessRole: 'writer' }] });
    }) as typeof fetch;

    await expect(discoverOwnedCalendarIds(env('calendar-pagination')))
      .resolves.toEqual(['primary-id', 'family']);
    expect(requested.some((url) => url.includes('pageToken=page-2'))).toBe(true);
  });

  it('paginates events and preserves every page in a multi-calendar read', async () => {
    global.fetch = jest.fn(async (input) => {
      const url = String(input);
      if (url.includes('oauth2.googleapis.com/token')) return token();
      if (url.includes('pageToken=next-events')) {
        return json({ items: [{ id: 'two', summary: 'Deux', start: { dateTime: '2026-10-25T11:00:00+01:00' } }] });
      }
      return json({
        items: [{ id: 'one', summary: 'Un', start: { dateTime: '2026-10-25T09:00:00+01:00' } }],
        nextPageToken: 'next-events',
      });
    }) as typeof fetch;

    const result = await fetchUpcomingEventsMultiCalendarDetailed(
      env('event-pagination'),
      ['primary'],
      '2026-10-25T00:00:00',
      '2026-10-26T00:00:00',
      20,
    );

    expect(result.events.map((event) => event.id)).toEqual(['one', 'two']);
    expect(result.failedCalendarIds).toEqual([]);
  });

  it('refreshes an expired access token once after a refused read', async () => {
    let refreshes = 0;
    let eventReads = 0;
    global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('oauth2.googleapis.com/token')) {
        refreshes += 1;
        return token(`access-${refreshes}`);
      }
      eventReads += 1;
      const authorization = (init?.headers as Record<string, string> | undefined)?.authorization;
      return authorization === 'Bearer access-1'
        ? json({ error: { code: 401, message: 'Invalid Credentials' } }, 401)
        : json({ items: [{ id: 'ok', summary: 'Récupéré', start: { dateTime: '2026-10-25T09:00:00+01:00' } }] });
    }) as typeof fetch;

    const result = await executeCalendarAgentAction({
      action: 'list_upcoming',
      calendarId: 'primary',
      timeMin: '2026-10-25T00:00:00',
      timeMax: '2026-10-26T00:00:00',
    }, env('expired-access'));

    expect(result).toContain('Récupéré');
    expect(refreshes).toBe(2);
    expect(eventReads).toBe(2);
  });

  it('does not retry a permission failure as if it were token expiry', async () => {
    let refreshes = 0;
    let eventReads = 0;
    global.fetch = jest.fn(async (input) => {
      const url = String(input);
      if (url.includes('oauth2.googleapis.com/token')) {
        refreshes += 1;
        return token();
      }
      eventReads += 1;
      return json({ error: { code: 403, message: 'Forbidden' } }, 403);
    }) as typeof fetch;

    await expect(executeCalendarAgentAction({
      action: 'list_upcoming',
      calendarId: 'primary',
      timeMin: '2026-10-25T00:00:00',
      timeMax: '2026-10-26T00:00:00',
    }, env('permission'))).rejects.toThrow(/403/);
    expect(refreshes).toBe(1);
    expect(eventReads).toBe(1);
  });

  it('retries one quota-limited read and respects Retry-After', async () => {
    let eventReads = 0;
    global.fetch = jest.fn(async (input) => {
      const url = String(input);
      if (url.includes('oauth2.googleapis.com/token')) return token();
      eventReads += 1;
      return eventReads === 1
        ? json({ error: { errors: [{ reason: 'rateLimitExceeded' }], code: 429 } }, 429, { 'retry-after': '0' })
        : json({ items: [{ id: 'ok', summary: 'Après quota', start: { dateTime: '2026-10-25T09:00:00+01:00' } }] });
    }) as typeof fetch;

    const result = await executeCalendarAgentAction({
      action: 'list_upcoming',
      calendarId: 'primary',
      timeMin: '2026-10-25T00:00:00',
      timeMax: '2026-10-26T00:00:00',
    }, env('quota-read'));

    expect(result).toContain('Après quota');
    expect(eventReads).toBe(2);
  });

  it('creates an all-day event with a client id and preserves the exclusive end date', async () => {
    let sentBody: Record<string, unknown> | undefined;
    global.fetch = jest.fn(async (input, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('oauth2.googleapis.com/token')) return token();
      if (init?.method === 'POST') {
        sentBody = JSON.parse(String(init.body)) as Record<string, unknown>;
        return json({ ...sentBody, summary: 'Congés' }, 200);
      }
      throw new Error(`unexpected_fetch:${url}`);
    }) as typeof fetch;

    await expect(executeCalendarAgentAction({
      action: 'create_event',
      summary: 'Congés',
      start: '2026-10-25',
      end: '2026-10-28',
      isAllDay: true,
      calendarId: 'primary',
    }, env('all-day-create'))).resolves.toContain('toute la journée');

    expect(sentBody).toMatchObject({
      id: expect.stringMatching(/^[0-9a-v]{5,1024}$/u),
      start: { date: '2026-10-25' },
      end: { date: '2026-10-28' },
    });
  });

  it('does not replay a POST after a network outcome that may have created the event', async () => {
    let posts = 0;
    global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('oauth2.googleapis.com/token')) return token();
      if (init?.method === 'POST') {
        posts += 1;
        throw new DOMException('connection lost after upload', 'NetworkError');
      }
      throw new Error(`unexpected_fetch:${url}`);
    }) as typeof fetch;

    await expect(executeCalendarAgentAction({
      action: 'create_event',
      summary: 'Dentiste',
      start: '2026-10-26T09:00:00',
      end: '2026-10-26T10:00:00',
      calendarId: 'primary',
    }, env('uncertain-create'))).rejects.toThrow('calendar_api_post_uncertain');
    expect(posts).toBe(1);
  });

  it('creates two intentionally identical events for two independent requests', async () => {
    const postedIds: string[] = [];
    global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('oauth2.googleapis.com/token')) return token();
      if (init?.method === 'POST') {
        const body = JSON.parse(String(init.body)) as { id?: string; summary?: string; start?: unknown; end?: unknown };
        postedIds.push(body.id ?? '');
        return json(body);
      }
      throw new Error(`unexpected_fetch:${url}`);
    }) as typeof fetch;

    const action = {
      action: 'create_event' as const,
      summary: 'Dentiste',
      start: '2026-10-26T09:00:00',
      end: '2026-10-26T10:00:00',
      calendarId: 'primary',
    };
    await expect(executeCalendarAgentAction(action, env('independent-create')))
      .resolves.toContain("C'est ajouté");
    await expect(executeCalendarAgentAction(action, env('independent-create')))
      .resolves.toContain("C'est ajouté");

    expect(postedIds).toHaveLength(2);
    expect(postedIds[0]).toMatch(/^[0-9a-v]{5,1024}$/u);
    expect(postedIds[1]).toMatch(/^[0-9a-v]{5,1024}$/u);
    expect(postedIds[1]).not.toBe(postedIds[0]);
  });

  it('reconciles a provider duplicate for the client id of the current create attempt', async () => {
    let postedId = '';
    global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('oauth2.googleapis.com/token')) return token();
      if (init?.method === 'POST') {
        postedId = (JSON.parse(String(init.body)) as { id?: string }).id ?? '';
        return json({ error: { code: 409, message: 'The requested identifier already exists.' } }, 409);
      }
      if (url.endsWith(`/events/${postedId}`)) {
        return json({
          id: postedId,
          summary: 'Dentiste',
          start: { dateTime: '2026-10-26T09:00:00', timeZone: 'Europe/Paris' },
          end: { dateTime: '2026-10-26T10:00:00', timeZone: 'Europe/Paris' },
        });
      }
      throw new Error(`unexpected_fetch:${url}`);
    }) as typeof fetch;

    await expect(executeCalendarAgentAction({
      action: 'create_event',
      summary: 'Dentiste',
      start: '2026-10-26T09:00:00',
      end: '2026-10-26T10:00:00',
      calendarId: 'primary',
    }, env('provider-duplicate'))).resolves.toContain("C'est ajouté");
    expect(postedId).toMatch(/^[0-9a-v]{5,1024}$/u);
  });

  it('does not replay an uncertain PATCH mutation', async () => {
    let patches = 0;
    global.fetch = jest.fn(async (input, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('oauth2.googleapis.com/token')) return token();
      if (init?.method === 'PATCH') {
        patches += 1;
        throw new DOMException('response lost', 'NetworkError');
      }
      throw new Error(`unexpected_fetch:${url}`);
    }) as typeof fetch;

    await expect(executeCalendarAgentAction({
      action: 'update_event',
      q: 'Réunion',
      eventId: 'event-1',
      calendarId: 'primary',
      summary: 'Réunion renommée',
    }, env('uncertain-patch'))).rejects.toThrow('calendar_api_patch_uncertain');
    expect(patches).toBe(1);
  });

  it('treats deletion of an already absent event as an idempotent success', async () => {
    let deletes = 0;
    global.fetch = jest.fn(async (input, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('oauth2.googleapis.com/token')) return token();
      if (init?.method === 'DELETE') {
        deletes += 1;
        return json({ error: { code: 404 } }, 404);
      }
      throw new Error(`unexpected_fetch:${url}`);
    }) as typeof fetch;

    await expect(executeCalendarAgentAction({
      action: 'delete_event',
      q: 'Déjà supprimé',
      eventId: 'event-gone',
      calendarId: 'primary',
    }, env('delete-absent'))).resolves.toContain('supprimé');
    expect(deletes).toBe(1);
  });

  it('requires clarification for similar events on two calendars', async () => {
    global.fetch = jest.fn(async (input) => {
      const url = String(input);
      if (url.includes('oauth2.googleapis.com/token')) return token();
      if (url.includes('/calendars/primary/')) {
        return json({ items: [{ id: 'personal', summary: 'Dentiste', start: { dateTime: '2026-10-26T09:00:00+01:00' } }] });
      }
      if (url.includes('/calendars/family/')) {
        return json({ items: [{ id: 'family-event', summary: 'Dentiste', start: { dateTime: '2026-10-27T09:00:00+01:00' } }] });
      }
      throw new Error(`unexpected_fetch:${url}`);
    }) as typeof fetch;

    const prepared = await prepareCalendarMutationAction({
      action: 'delete_event',
      q: 'Dentiste',
      timeMin: '2026-10-25T00:00:00',
      timeMax: '2026-10-28T00:00:00',
    }, env('ambiguous-calendars'));

    expect(prepared.status).toBe('ambiguous');
    if (prepared.status !== 'ambiguous') throw new Error('expected_ambiguous');
    expect(prepared.candidates).toHaveLength(2);
  });

  it('rejects nonexistent Paris local times and preserves DST boundaries', () => {
    expect(() => toGoogleCalendarTimeBoundary('2026-03-29T02:30:00'))
      .toThrow('calendar_invalid_local_time');
    expect(toGoogleCalendarTimeBoundary('2026-03-29T00:00:00')).toBe('2026-03-28T23:00:00.000Z');
    expect(toGoogleCalendarTimeBoundary('2026-10-25T00:00:00')).toBe('2026-10-24T22:00:00.000Z');
    expect(toGoogleCalendarTimeBoundary('2026-10-25T02:30:00')).toBe('2026-10-25T01:30:00.000Z');
  });

  it('rejects impossible all-day dates and non-exclusive end dates', () => {
    expect(() => parseCalendarAction({
      action: 'create_event',
      summary: 'Impossible',
      start: '2026-02-30',
      end: '2026-03-01',
      isAllDay: true,
    }, env('invalid-date'))).toThrow();
    expect(() => parseCalendarAction({
      action: 'create_event',
      summary: 'Sans durée',
      start: '2026-10-25',
      end: '2026-10-25',
      isAllDay: true,
    }, env('invalid-all-day'))).toThrow(/end/);
  });

  it('targets a recurring occurrence id instead of the parent series', async () => {
    const patched: string[] = [];
    global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('oauth2.googleapis.com/token')) return token();
      if (url.includes('/events?')) {
        return json({ items: [{
          id: 'instance-id',
          recurringEventId: 'series-id',
          originalStartTime: { dateTime: '2026-10-25T09:00:00+01:00' },
          summary: 'Sport',
          start: { dateTime: '2026-10-25T09:00:00+01:00' },
          end: { dateTime: '2026-10-25T10:00:00+01:00' },
        }] });
      }
      if (init?.method === 'PATCH') {
        patched.push(url);
        return json({ id: 'instance-id', summary: 'Sport décalé' });
      }
      throw new Error(`unexpected_fetch:${url}`);
    }) as typeof fetch;

    const prepared = await prepareCalendarMutationAction({
      action: 'update_event',
      q: 'Sport',
      calendarId: 'primary',
      timeMin: '2026-10-25T00:00:00',
      timeMax: '2026-10-26T00:00:00',
      summary: 'Sport décalé',
    }, env('recurring-instance'));
    expect(prepared.status).toBe('ready');
    if (prepared.status !== 'ready') throw new Error('expected_ready');
    await executeCalendarAgentAction(prepared.action, env('recurring-instance'));

    expect(patched).toHaveLength(1);
    expect(patched[0]).toContain('/events/instance-id');
    expect(patched[0]).not.toContain('/events/series-id');
  });
});
