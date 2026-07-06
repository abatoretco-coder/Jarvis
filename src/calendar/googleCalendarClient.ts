/**
 * Shared Google Calendar API client.
 *
 * Provides token refresh (with in-memory cache + keepalive), a generic API
 * request helper, and a multi-calendar parallel fetch utility used by both
 * the dashboard agenda section and the calendar conversation agent.
 */

import { resolveGoogleCredentials } from '../google/googleCredentialService';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface CalendarTokenEnv {
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  GOOGLE_REFRESH_TOKEN?: string;
  OAUTH_REFRESH_TOKEN_STORE_PATH?: string;
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
  reminders?: {
    useDefault?: boolean;
    overrides?: Array<{ method?: 'email' | 'popup'; minutes?: number }>;
  };
}

export type GoogleConfigState = 'missing_client' | 'missing_refresh_token' | 'ready';

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
const KEEPALIVE_DAYS = 30;
const KEEPALIVE_TICK_MS = 24 * 3_600_000; // 1 day — safe for Node.js 32-bit timer range

const GOOGLE_CAL_BASE = 'https://www.googleapis.com/calendar/v3';
const RFC3339_ZONE_SUFFIX_RE = /(?:Z|[+-]\d{2}:\d{2})$/u;
const LOCAL_TEMPORAL_RE = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2}))?)?$/u;

// ─── Token refresh ────────────────────────────────────────────────────────────

export async function refreshCalendarToken(env: CalendarTokenEnv): Promise<string> {
  const credentials = await resolveGoogleCredentials(env);
  if (!credentials) throw new Error('calendar_credentials_missing');
  const cacheKey = `gcal:${credentials.clientId}`;
  const cached = _tokenCache.get(cacheKey);
  if (cached && Date.now() < cached.expiresAt) return cached.accessToken;

  const resp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id:     credentials.clientId,
      client_secret: credentials.clientSecret,
      refresh_token: credentials.refreshToken,
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
    let dayCount = 0;
    const timer = setInterval(() => {
      dayCount += 1;
      if (dayCount >= KEEPALIVE_DAYS) {
        dayCount = 0;
        _tokenCache.delete(cacheKey);
        refreshCalendarToken(env).catch(() => {});
      }
    }, KEEPALIVE_TICK_MS);
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

function getParisDateTimeParts(date: Date): { year: number; month: number; day: number; hour: number; minute: number; second: number } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Paris',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const value = (type: string): number => {
    const raw = parts.find((part) => part.type === type)?.value;
    const parsed = raw ? Number.parseInt(raw, 10) : NaN;
    if (!Number.isFinite(parsed)) throw new Error(`invalid_paris_datetime_part:${type}`);
    return parsed;
  };
  return {
    year: value('year'),
    month: value('month'),
    day: value('day'),
    hour: value('hour'),
    minute: value('minute'),
    second: value('second'),
  };
}

function utcDateFromParisLocalDateTime(year: number, month: number, day: number, hour: number, minute: number, second: number): Date {
  let utcMs = Date.UTC(year, month - 1, day, hour, minute, second);
  for (let index = 0; index < 3; index += 1) {
    const paris = getParisDateTimeParts(new Date(utcMs));
    const desiredAsUtc = Date.UTC(year, month - 1, day, hour, minute, second);
    const actualAsUtc = Date.UTC(paris.year, paris.month - 1, paris.day, paris.hour, paris.minute, paris.second);
    const delta = desiredAsUtc - actualAsUtc;
    if (delta === 0) break;
    utcMs += delta;
  }
  return new Date(utcMs);
}

export function toGoogleCalendarTimeBoundary(value: string): string {
  const trimmed = value.trim();
  if (!trimmed || RFC3339_ZONE_SUFFIX_RE.test(trimmed)) return trimmed;
  const match = trimmed.match(LOCAL_TEMPORAL_RE);
  if (!match) return trimmed;
  const year = Number.parseInt(match[1]!, 10);
  const month = Number.parseInt(match[2]!, 10);
  const day = Number.parseInt(match[3]!, 10);
  const hour = Number.parseInt(match[4] ?? '0', 10);
  const minute = Number.parseInt(match[5] ?? '0', 10);
  const second = Number.parseInt(match[6] ?? '0', 10);
  return utcDateFromParisLocalDateTime(year, month, day, hour, minute, second).toISOString();
}

/** Returns true when the minimum Google OAuth credentials are present. */
export function hasCalendarConfig(env: Partial<CalendarTokenEnv>): env is CalendarTokenEnv {
  return Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET && (env.GOOGLE_REFRESH_TOKEN || env.OAUTH_REFRESH_TOKEN_STORE_PATH));
}

export async function getGoogleCalendarConfigState(env: Partial<CalendarTokenEnv>): Promise<GoogleConfigState> {
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) return 'missing_client';
  const credentials = await resolveGoogleCredentials({
    GOOGLE_CLIENT_ID: env.GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET: env.GOOGLE_CLIENT_SECRET,
    GOOGLE_REFRESH_TOKEN: env.GOOGLE_REFRESH_TOKEN,
    OAUTH_REFRESH_TOKEN_STORE_PATH: env.OAUTH_REFRESH_TOKEN_STORE_PATH,
  });
  return credentials ? 'ready' : 'missing_refresh_token';
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
    return date.toLocaleDateString('fr-FR', { weekday: 'long', day: '2-digit', month: '2-digit' });
  }
  return date.toLocaleString('fr-FR', {
    weekday: 'long',
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

// ─── Multi-calendar fetch ─────────────────────────────────────────────────────

export type CalendarEventWithMeta = GoogleCalendarEvent & { calendarId: string };
export type CalendarMultiFetchResult = {
  events: CalendarEventWithMeta[];
  failedCalendarIds: string[];
};

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
export async function fetchUpcomingEventsMultiCalendarDetailed(
  env: CalendarTokenEnv,
  calendarIds: string[],
  timeMin: string,
  timeMax: string,
  maxPerCalendar = 50,
): Promise<CalendarMultiFetchResult> {
  const token = await refreshCalendarToken(env);

  const results = await Promise.allSettled(
    calendarIds.map((id) => {
      const params = new URLSearchParams({
        singleEvents:  'true',
        orderBy:       'startTime',
        maxResults:    String(maxPerCalendar),
        timeMin:       toGoogleCalendarTimeBoundary(timeMin),
        timeMax:       toGoogleCalendarTimeBoundary(timeMax),
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
  const failedCalendarIds: string[] = [];
  results.forEach((result, index) => {
    if (result.status === 'fulfilled') all.push(...result.value);
    else failedCalendarIds.push(calendarIds[index] ?? 'unknown');
  });

  // Merge & sort by start time across all calendars
  all.sort((a, b) => {
    const aStart = a.start?.dateTime ?? a.start?.date ?? '';
    const bStart = b.start?.dateTime ?? b.start?.date ?? '';
    return aStart.localeCompare(bStart);
  });

  return { events: all, failedCalendarIds };
}

export async function fetchUpcomingEventsMultiCalendar(
  env: CalendarTokenEnv,
  calendarIds: string[],
  timeMin: string,
  timeMax: string,
  maxPerCalendar = 50,
): Promise<CalendarEventWithMeta[]> {
  return (await fetchUpcomingEventsMultiCalendarDetailed(env, calendarIds, timeMin, timeMax, maxPerCalendar)).events;
}
