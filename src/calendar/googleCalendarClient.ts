/**
 * Shared Google Calendar API client.
 *
 * Provides token refresh (with in-memory cache + keepalive), a generic API
 * request helper, and a multi-calendar parallel fetch utility used by both
 * the dashboard agenda section and the calendar conversation agent.
 */

// ─── Types ────────────────────────────────────────────────────────────────────

export interface CalendarTokenEnv {
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  GOOGLE_REFRESH_TOKEN: string;
}

export interface GoogleCalendarEventDateTime {
  /** All-day event date — YYYY-MM-DD format */
  date?: string;
  /** Timed event — RFC3339 timestamp */
  dateTime?: string;
  timeZone?: string;
}

export interface GoogleCalendarEvent {
  id: string;
  /** 'confirmed' | 'tentative' | 'cancelled' */
  status?: string;
  summary?: string;
  description?: string;
  location?: string;
  start?: GoogleCalendarEventDateTime;
  end?: GoogleCalendarEventDateTime;
  recurrence?: string[];
  attendees?: Array<{
    email?: string;
    displayName?: string;
    responseStatus?: 'needsAction' | 'declined' | 'tentative' | 'accepted';
  }>;
  eventType?: string;
  htmlLink?: string;
}

// ─── Token cache (in-memory, per process) ────────────────────────────────────
//
// Access tokens are cached until TOKEN_EXPIRY_BUFFER_MS before their expiry.
// A setInterval fires every KEEPALIVE_INTERVAL_MS to proactively refresh,
// preventing 6-month Google inactivity expiry.

interface CachedToken {
  accessToken: string;
  expiresAt: number;
}

const _tokenCache = new Map<string, CachedToken>();
const _keepaliveScheduled = new Set<string>();
const TOKEN_EXPIRY_BUFFER_MS = 60_000;           // refresh 60 s before expiry
const KEEPALIVE_INTERVAL_MS  = 30 * 24 * 3_600_000; // 30 days

const GOOGLE_CAL_BASE = 'https://www.googleapis.com/calendar/v3';

// ─── Token refresh ────────────────────────────────────────────────────────────

export async function refreshCalendarToken(env: CalendarTokenEnv): Promise<string> {
  const cacheKey = `gcal:${env.GOOGLE_CLIENT_ID}`;
  const cached = _tokenCache.get(cacheKey);
  if (cached && Date.now() < cached.expiresAt) return cached.accessToken;

  const resp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id:     env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      refresh_token: env.GOOGLE_REFRESH_TOKEN,
      grant_type:    'refresh_token',
    }),
    signal: AbortSignal.timeout(8_000),
  });

  if (!resp.ok) {
    _tokenCache.delete(cacheKey);
    const body = await resp.text().catch(() => '');
    throw new Error(`calendar_token_refresh_failed:${resp.status}:${body.slice(0, 200)}`);
  }

  const data = await resp.json() as { access_token?: string; expires_in?: number };
  if (!data.access_token) throw new Error('calendar_token_refresh_no_token');

  const expiresIn = typeof data.expires_in === 'number' ? data.expires_in : 3600;
  _tokenCache.set(cacheKey, {
    accessToken: data.access_token,
    expiresAt:   Date.now() + expiresIn * 1_000 - TOKEN_EXPIRY_BUFFER_MS,
  });

  if (!_keepaliveScheduled.has(cacheKey)) {
    _keepaliveScheduled.add(cacheKey);
    const timer = setInterval(() => {
      _tokenCache.delete(cacheKey);
      refreshCalendarToken(env).catch(() => {});
    }, KEEPALIVE_INTERVAL_MS);
    if (timer.unref) timer.unref();
  }

  return data.access_token;
}

// ─── Generic API request ──────────────────────────────────────────────────────

export async function calendarApiRequest<T>(
  path: string,
  token: string,
  opts?: { method?: 'GET' | 'POST' | 'PATCH' | 'DELETE'; body?: unknown },
): Promise<T> {
  const resp = await fetch(`${GOOGLE_CAL_BASE}${path}`, {
    method: opts?.method ?? 'GET',
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/json',
      ...(opts?.body ? { 'content-type': 'application/json' } : {}),
    },
    body: opts?.body ? JSON.stringify(opts.body) : undefined,
    signal: AbortSignal.timeout(10_000),
  });

  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    throw new Error(`calendar_api_request_failed:${resp.status}:${body.slice(0, 300)}`);
  }

  if (resp.status === 204) return undefined as T;
  return resp.json() as Promise<T>;
}

// ─── Utilities ────────────────────────────────────────────────────────────────

/** Returns true when the minimum Google OAuth credentials are present. */
export function hasCalendarConfig(env: Partial<CalendarTokenEnv>): env is CalendarTokenEnv {
  return Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET && env.GOOGLE_REFRESH_TOKEN);
}

/**
 * Parse GOOGLE_CALENDAR_CALENDAR_IDS (comma-separated).
 * Defaults to ["primary"] when not set.
 */
export function parseCalendarIds(raw: string | undefined): string[] {
  if (!raw?.trim()) return ['primary'];
  return raw
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean);
}

/**
 * Resolve the start date of a Google Calendar event.
 * All-day events use `date` (treated as local midnight); timed events use `dateTime`.
 */
export function resolveEventStart(ev: GoogleCalendarEvent): Date {
  const raw = ev.start?.dateTime ?? (ev.start?.date ? `${ev.start.date}T00:00:00` : null);
  if (!raw) return new Date(0);
  const d = new Date(raw);
  return isNaN(d.getTime()) ? new Date(0) : d;
}

/** Resolve the end date of a Google Calendar event. */
export function resolveEventEnd(ev: GoogleCalendarEvent): Date {
  const raw = ev.end?.dateTime ?? (ev.end?.date ? `${ev.end.date}T00:00:00` : null);
  if (!raw) return new Date(0);
  const d = new Date(raw);
  return isNaN(d.getTime()) ? new Date(0) : d;
}

/** Format a Date for display (fr-FR short). */
export function formatEventDate(date: Date, isAllDay: boolean): string {
  if (isAllDay) {
    return date.toLocaleDateString('fr-FR', { weekday: 'short', day: '2-digit', month: '2-digit' });
  }
  return date.toLocaleString('fr-FR', {
    weekday: 'short',
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

// ─── Multi-calendar fetch ─────────────────────────────────────────────────────

export type CalendarEventWithMeta = GoogleCalendarEvent & { calendarId: string };

/**
 * Fetch upcoming events from multiple calendars in parallel.
 *
 * API contract (from docs):
 *  - timeMin: lower bound (exclusive) on event **end** time (RFC3339)
 *  - timeMax: upper bound (exclusive) on event **start** time (RFC3339)
 *  - singleEvents=true + orderBy=startTime: expand recurring events, ordered by start
 *
 * Failed per-calendar fetches are silently skipped so one broken calendar
 * does not prevent the rest from loading.
 */
export async function fetchUpcomingEventsMultiCalendar(
  env: CalendarTokenEnv,
  calendarIds: string[],
  timeMin: string,
  timeMax: string,
  maxPerCalendar = 50,
): Promise<CalendarEventWithMeta[]> {
  const token = await refreshCalendarToken(env);

  const results = await Promise.allSettled(
    calendarIds.map((id) => {
      const params = new URLSearchParams({
        singleEvents:  'true',
        orderBy:       'startTime',
        maxResults:    String(maxPerCalendar),
        timeMin,
        timeMax,
        showDeleted:   'false',
      });
      return calendarApiRequest<{ items?: GoogleCalendarEvent[] }>(
        `/calendars/${encodeURIComponent(id)}/events?${params.toString()}`,
        token,
      ).then((payload) =>
        (payload.items ?? []).map((ev): CalendarEventWithMeta => ({ ...ev, calendarId: id })),
      );
    }),
  );

  const all: CalendarEventWithMeta[] = [];
  for (const result of results) {
    if (result.status === 'fulfilled') all.push(...result.value);
  }

  // Merge & sort by start time across all calendars
  all.sort((a, b) => {
    const aStart = a.start?.dateTime ?? a.start?.date ?? '';
    const bStart = b.start?.dateTime ?? b.start?.date ?? '';
    return aStart.localeCompare(bStart);
  });

  return all;
}
