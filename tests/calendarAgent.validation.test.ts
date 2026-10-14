import { afterEach, describe, expect, it, jest } from '@jest/globals';

import {
  formatCalendarProposal,
  parseCalendarAction,
  planCalendarAgentAction,
} from '../src/calendar/calendarAgent';
import { toGoogleCalendarTimeBoundary } from '../src/calendar/googleCalendarClient';

const env = {
  GOOGLE_CALENDAR_CALENDAR_IDS: 'primary,famille@example.com',
  GOOGLE_CALENDAR_DEFAULT_CREATE_CALENDAR_ID: 'primary',
  OPENAI_BASE_URL: 'https://api.openai.com/v1',
  OPENAI_TIMEOUT_MS: 1000,
};

describe('calendar action validation', () => {
  afterEach(() => {
    (global as { fetch?: unknown }).fetch = undefined;
  });
  it('accepts valid all-day create actions and formats a proposal', () => {
    const action = parseCalendarAction({
      action: 'create_event',
      summary: 'Télétravail',
      start: '2026-07-01',
      end: '2026-07-02',
      isAllDay: true,
    }, env);

    expect(action.action).toBe('create_event');
    expect(action.calendarId).toBe('primary');
    expect(formatCalendarProposal(action)).toContain('Je peux ajouter');
    expect(formatCalendarProposal(action)).not.toContain('confirme agenda');
  });

  it('rejects non-allowlisted calendar ids', () => {
    expect(() => parseCalendarAction({
      action: 'search_events',
      q: 'dentiste',
      calendarId: 'unknown@example.com',
    }, env)).toThrow(/allowlisted/);
  });

  it('rejects create actions where end is not after start', () => {
    expect(() => parseCalendarAction({
      action: 'create_event',
      summary: 'RDV',
      start: '2026-07-01T15:00:00',
      end: '2026-07-01T14:00:00',
    }, env)).toThrow(/end/);
  });

  it('converts Paris local boundaries to RFC3339 UTC for Google Calendar queries', () => {
    expect(toGoogleCalendarTimeBoundary('2026-06-29T00:00:00')).toBe('2026-06-28T22:00:00.000Z');
    expect(toGoogleCalendarTimeBoundary('2026-12-29T00:00:00')).toBe('2026-12-28T23:00:00.000Z');
    expect(toGoogleCalendarTimeBoundary('2026-06-29T00:00:00Z')).toBe('2026-06-29T00:00:00Z');
  });

  it('passes prior calendar turns to the planner for implicit continuations', async () => {
    const fetchMock = jest.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as {
        input?: Array<{ role: string; content: Array<{ text?: string }> }>;
      };
      const serialized = JSON.stringify(body.input ?? []);
      expect(serialized).toContain("C'est ajouté dans ton agenda");
      expect(serialized).toContain('Bloque aussi le samedi d’avant');
      return new Response(
        JSON.stringify({
          status: 'completed',
          output_text: JSON.stringify({
            action: 'create_event',
            summary: 'Crémaillère',
            start: '2026-11-14',
            end: '2026-11-15',
            isAllDay: true,
          }),
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    });
    (global as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;

    const plan = await planCalendarAgentAction(
      'Bloque aussi le samedi d’avant pour la crémaillère',
      {
        ...env,
        GOOGLE_CLIENT_ID: 'client',
        GOOGLE_CLIENT_SECRET: 'secret',
        GOOGLE_REFRESH_TOKEN: 'refresh',
        OPENAI_API_KEY: 'openai',
      },
      [
        { role: 'user', content: 'Bloque le 21 novembre dans mon agenda.' },
        {
          role: 'assistant',
          content: "C'est ajouté dans ton agenda : soirée, le 21 novembre 2026.",
        },
      ]
    );

    expect(plan).toMatchObject({
      action: 'create_event',
      summary: 'Crémaillère',
      start: '2026-11-14',
    });
  });
});
