import { afterEach, describe, expect, jest, test } from '@jest/globals';

import { executeCalendarAgentAction } from '../src/calendar/calendarAgent';

describe('calendar partial failures', () => {
  afterEach(() => {
    (global as { fetch?: unknown }).fetch = undefined;
  });

  test('announces a failed calendar instead of presenting partial events as complete', async () => {
    (global as { fetch: typeof fetch }).fetch = jest.fn(async (input: string | URL) => {
      const url = String(input);
      if (url.includes('oauth2.googleapis.com/token')) {
        return new Response(JSON.stringify({ access_token: 'token', expires_in: 3600 }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.includes('/calendars/primary/events')) {
        return new Response(JSON.stringify({
          items: [{
            id: 'event-1',
            summary: 'Réunion',
            start: { dateTime: '2026-10-08T09:00:00+02:00' },
            end: { dateTime: '2026-10-08T10:00:00+02:00' },
          }],
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (url.includes('/calendars/family/events')) {
        return new Response('unavailable', { status: 503 });
      }
      throw new Error(`unexpected_fetch:${url}`);
    }) as unknown as typeof fetch;

    const response = await executeCalendarAgentAction({
      action: 'list_upcoming',
      timeMin: '2026-10-08T00:00:00',
      timeMax: '2026-10-09T00:00:00',
    }, {
      GOOGLE_CLIENT_ID: 'client',
      GOOGLE_CLIENT_SECRET: 'secret',
      GOOGLE_REFRESH_TOKEN: 'refresh',
      GOOGLE_CALENDAR_CALENDAR_IDS: 'primary,family',
      OPENAI_BASE_URL: 'https://api.openai.com/v1',
      OPENAI_TIMEOUT_MS: 1_000,
    });

    expect(response).toContain('Résultats partiels');
    expect(response).toContain('family');
    expect(response).toContain('Réunion');
  });
});
