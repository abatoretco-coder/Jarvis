import { describe, expect, it } from '@jest/globals';

import { formatCalendarProposal, parseCalendarAction } from '../src/calendar/calendarAgent';
import { toGoogleCalendarTimeBoundary } from '../src/calendar/googleCalendarClient';

const env = {
  GOOGLE_CALENDAR_CALENDAR_IDS: 'primary,famille@example.com',
  GOOGLE_CALENDAR_DEFAULT_CREATE_CALENDAR_ID: 'primary',
  OPENAI_BASE_URL: 'https://api.openai.com/v1',
  OPENAI_TIMEOUT_MS: 1000,
};

describe('calendar action validation', () => {
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
});
