/**
 * Shared Google Calendar API client.
 *
 * Provides token refresh (with in-memory cache + keepalive), a generic API
 * request helper, and a multi-calendar parallel fetch utility used by both
 * the dashboard agenda section and the calendar conversation agent.
 */

import { createHash } from 'node:crypto';

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
  iCalUID?: string;
  /** 'confirmed' | 'tentative' | 'cancelled' */
  status?: string;
  summary?: string;
  description?: string;
  location?: string;
  transparency?: 'opaque' | 'transparent';
  visibility?: 'default' | 'public' | 'private' | 'confidential';
  start?: GoogleCalendarEventDateTime;
  end?: GoogleCalendarEventDateTime;
  recurrence?: string[];
  recurringEventId?: string;
  originalStartTime?: GoogleCalendarEventDateTime;
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
const _tokenRefreshInFlight = new Map<string, Promise<string>>();
const _keepaliveTimers = new Map<string, ReturnType<typeof setInterval>>();
const _keepaliveWork = new Set<Promise<unknown>>();
const TOKEN_EXPIRY_BUFFER_MS = 60_000;           // refresh 60 s before expiry
const KEEPALIVE_DAYS = 30;
const KEEPALIVE_TICK_MS = 24 * 3_600_000; // 1 day — safe for Node.js 32-bit timer range
const TOKEN_REFRESH_MAX_ATTEMPTS = 2;
const TOKEN_REFRESH_RETRY_DELAY_MS = 250;
const CALENDAR_READ_RETRIES = 1;
const CALENDAR_RETRY_FALLBACK_MS = 250;
const CALENDAR_RETRY_MAX_MS = 2_000;
const CALENDAR_MAX_PAGES = 20;
const CALENDAR_MAX_ITEMS = 2_000;
const CALENDAR_MAX_IDS = 25;
const CALENDAR_FETCH_CONCURRENCY = 4;

const GOOGLE_CAL_BASE = 'https://www.googleapis.com/calendar/v3';
const RFC3339_ZONE_SUFFIX_RE = /(?:Z|[+-]\d{2}:\d{2})$/u;
const LOCAL_TEMPORAL_RE = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2}))?)?$/u;

type CalendarApiMethod = 'GET' | 'POST' | 'PATCH' | 'DELETE';
type CalendarApiOutcome = 'rejected' | 'uncertain';

export class CalendarApiError extends Error {
  constructor(
    readonly method: CalendarApiMethod,
    readonly outcome: CalendarApiOutcome,
    readonly status?: number,
  ) {
    super(outcome === 'uncertain'
      ? `calendar_api_${method.toLowerCase()}_uncertain${status ? `:${status}` : ''}`
      : `calendar_api_${method.toLowerCase()}_failed:${status ?? 'network'}`);
    this.name = 'CalendarApiError';
  }
}

// ─── Token refresh ────────────────────────────────────────────────────────────

async function calendarTokenContext(env: CalendarTokenEnv): Promise<{
  credentials: { clientId: string; clientSecret: string; refreshToken: string };
  cacheKey: string;
}> {
  const credentials = await resolveGoogleCredentials(env);
  if (!credentials) throw new Error('calendar_credentials_missing');
  const tokenFingerprint = createHash('sha256')
    .update(credentials.refreshToken, 'utf8')
    .digest('base64url')
    .slice(0, 16);
  const cacheKey = `gcal:${credentials.clientId}:${tokenFingerprint}`;
  return { credentials, cacheKey };
}

function retryAfterMs(response: Response, fallback = CALENDAR_RETRY_FALLBACK_MS): number | undefined {
  const raw = response.headers.get('retry-after')?.trim();
  if (!raw) return fallback;
  const seconds = Number(raw);
  const delayMs = Number.isFinite(seconds) && seconds >= 0
    ? Math.floor(seconds * 1_000)
    : Math.max(0, Date.parse(raw) - Date.now());
  if (!Number.isFinite(delayMs)) return fallback;
  return delayMs <= CALENDAR_RETRY_MAX_MS ? delayMs : undefined;
}

function wait(ms: number): Promise<void> {
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
}

export async function refreshCalendarToken(env: CalendarTokenEnv, forceRefresh = false): Promise<string> {
  const { credentials, cacheKey } = await calendarTokenContext(env);
  if (forceRefresh) _tokenCache.delete(cacheKey);
  const cached = _tokenCache.get(cacheKey);
  if (cached && Date.now() < cached.expiresAt) return cached.accessToken;

  const inFlight = _tokenRefreshInFlight.get(cacheKey);
  if (inFlight) return inFlight;
  const refresh = refreshCalendarTokenUncached(env, credentials, cacheKey)
    .finally(() => {
      if (_tokenRefreshInFlight.get(cacheKey) === refresh) _tokenRefreshInFlight.delete(cacheKey);
    });
  _tokenRefreshInFlight.set(cacheKey, refresh);
  return refresh;
}

async function refreshCalendarTokenUncached(
  env: CalendarTokenEnv,
  credentials: { clientId: string; clientSecret: string; refreshToken: string },
  cacheKey: string,
): Promise<string> {
  let resp: Response | undefined;
  for (let attempt = 1; attempt <= TOKEN_REFRESH_MAX_ATTEMPTS; attempt += 1) {
    try {
      resp = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id:     credentials.clientId,
          client_secret: credentials.clientSecret,
          refresh_token: credentials.refreshToken,
          grant_type:    'refresh_token',
        }),
        redirect: 'error',
        signal: AbortSignal.timeout(8_000),
      });
    } catch (error) {
      if (attempt === TOKEN_REFRESH_MAX_ATTEMPTS) throw error;
      await wait(TOKEN_REFRESH_RETRY_DELAY_MS);
      continue;
    }

    if (resp.ok) break;
    const transient = resp.status === 429 || resp.status >= 500;
    if (!transient || attempt === TOKEN_REFRESH_MAX_ATTEMPTS) break;
    await resp.arrayBuffer().catch(() => undefined);
    const retryDelay = retryAfterMs(resp, TOKEN_REFRESH_RETRY_DELAY_MS);
    if (retryDelay === undefined) break;
    await wait(retryDelay);
  }

  if (!resp) throw new Error('calendar_token_refresh_no_response');

  if (!resp.ok) {
    _tokenCache.delete(cacheKey);
    throw new Error(`calendar_token_refresh_failed:${resp.status}`);
  }

  let data: { access_token?: string; expires_in?: number };
  try {
    const payload = await resp.json() as unknown;
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('invalid');
    data = payload as { access_token?: string; expires_in?: number };
  } catch {
    throw new Error('calendar_token_refresh_malformed_json');
  }
  if (typeof data.access_token !== 'string' || !data.access_token.trim()) throw new Error('calendar_token_refresh_no_token');

  const expiresIn = typeof data.expires_in === 'number' ? data.expires_in : 3600;
  _tokenCache.set(cacheKey, {
    accessToken: data.access_token,
    expiresAt:   Date.now() + expiresIn * 1_000 - TOKEN_EXPIRY_BUFFER_MS,
  });

  if (!_keepaliveTimers.has(cacheKey)) {
    let dayCount = 0;
    const timer = setInterval(() => {
      dayCount += 1;
      if (dayCount >= KEEPALIVE_DAYS) {
        dayCount = 0;
        _tokenCache.delete(cacheKey);
        const work = refreshCalendarToken(env)
          .catch(() => undefined)
          .finally(() => _keepaliveWork.delete(work));
        _keepaliveWork.add(work);
      }
    }, KEEPALIVE_TICK_MS);
    _keepaliveTimers.set(cacheKey, timer);
    if (timer.unref) timer.unref();
  }

  return data.access_token;
}

export async function withCalendarAccessToken<T>(
  env: CalendarTokenEnv,
  operation: (token: string) => Promise<T>,
): Promise<T> {
  const token = await refreshCalendarToken(env);
  try {
    return await operation(token);
  } catch (error) {
    if (!(error instanceof CalendarApiError) || error.status !== 401 || error.outcome !== 'rejected') throw error;
    const refreshed = await refreshCalendarToken(env, true);
    return operation(refreshed);
  }
}

export async function stopGoogleCalendarTokenKeepalives(): Promise<void> {
  for (const timer of _keepaliveTimers.values()) clearInterval(timer);
  _keepaliveTimers.clear();
  await Promise.allSettled([..._keepaliveWork]);
  for (const timer of _keepaliveTimers.values()) clearInterval(timer);
  _keepaliveTimers.clear();
  await Promise.allSettled([..._tokenRefreshInFlight.values()]);
  _tokenRefreshInFlight.clear();
  for (const timer of _keepaliveTimers.values()) clearInterval(timer);
  _keepaliveTimers.clear();
  _tokenCache.clear();
}

// ─── Generic API request ──────────────────────────────────────────────────────

export async function calendarApiRequest<T>(
  path: string,
  token: string,
  opts?: { method?: 'GET' | 'POST' | 'PATCH' | 'DELETE'; body?: unknown },
): Promise<T> {
  if (!path.startsWith('/') || path.startsWith('//') || path.includes('://') || path.length > 8_192) {
    throw new Error('calendar_api_invalid_path');
  }
  const method = opts?.method ?? 'GET';
  const isRead = method === 'GET';
  for (let attempt = 0; ; attempt += 1) {
    let resp: Response;
    try {
      resp = await fetch(`${GOOGLE_CAL_BASE}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          accept: 'application/json',
          ...(opts?.body !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        body: opts?.body !== undefined ? JSON.stringify(opts.body) : undefined,
        redirect: 'error',
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      if (isRead && attempt < CALENDAR_READ_RETRIES) {
        await wait(CALENDAR_RETRY_FALLBACK_MS);
        continue;
      }
      throw new CalendarApiError(method, isRead ? 'rejected' : 'uncertain');
    }

    if (resp.ok) {
      if (resp.status === 204) return undefined as T;
      try {
        const payload = await resp.json() as unknown;
        if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('invalid');
        return payload as T;
      } catch {
        throw new Error('calendar_api_malformed_json');
      }
    }

    const quotaLimited = resp.status === 429 || (resp.status === 403 && await isQuotaError(resp));
    const retryableRead = isRead && attempt < CALENDAR_READ_RETRIES && (quotaLimited || resp.status >= 500);
    if (retryableRead) {
      const retryDelay = retryAfterMs(resp);
      if (retryDelay !== undefined) {
        await wait(retryDelay);
        continue;
      }
    }
    const uncertainMutation = !isRead && (resp.status === 408 || resp.status >= 500);
    throw new CalendarApiError(method, uncertainMutation ? 'uncertain' : 'rejected', resp.status);
  }
}

async function isQuotaError(response: Response): Promise<boolean> {
  try {
    const payload = await response.clone().json() as {
      error?: { errors?: Array<{ reason?: string }>; status?: string };
    };
    const reasons = payload.error?.errors?.map((item) => item.reason) ?? [];
    return reasons.some((reason) => reason === 'rateLimitExceeded' || reason === 'userRateLimitExceeded')
      || payload.error?.status === 'RESOURCE_EXHAUSTED';
  } catch {
    return false;
  }
}

function pathWithPageToken(path: string, pageToken: string): string {
  const separator = path.includes('?') ? '&' : '?';
  return `${path}${separator}pageToken=${encodeURIComponent(pageToken)}`;
}

export async function calendarApiListItems<T>(
  path: string,
  token: string,
  maxItems = CALENDAR_MAX_ITEMS,
): Promise<T[]> {
  if (!Number.isInteger(maxItems) || maxItems < 1 || maxItems > CALENDAR_MAX_ITEMS) {
    throw new Error('calendar_api_invalid_item_limit');
  }
  const items: T[] = [];
  let pageToken: string | undefined;
  for (let page = 0; page < CALENDAR_MAX_PAGES; page += 1) {
    const payload = await calendarApiRequest<{ items?: unknown; nextPageToken?: unknown }>(
      pageToken ? pathWithPageToken(path, pageToken) : path,
      token,
    );
    const pageItems = payload.items === undefined ? [] : payload.items;
    if (!Array.isArray(pageItems)) throw new Error('calendar_api_malformed_collection');
    items.push(...pageItems.slice(0, Math.max(0, maxItems - items.length)) as T[]);
    if (items.length >= maxItems) return items;
    if (payload.nextPageToken === undefined || payload.nextPageToken === null || payload.nextPageToken === '') return items;
    if (typeof payload.nextPageToken !== 'string' || payload.nextPageToken.length > 2_048) {
      throw new Error('calendar_api_invalid_page_token');
    }
    pageToken = payload.nextPageToken;
  }
  throw new Error('calendar_api_pagination_limit');
}

async function mapWithConcurrency<T, R>(
  values: T[],
  concurrency: number,
  mapper: (value: T, index: number) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
  const results = new Array<PromiseSettledResult<R>>(values.length);
  let nextIndex = 0;
  const worker = async (): Promise<void> => {
    while (nextIndex < values.length) {
      const index = nextIndex++;
      try {
        results[index] = { status: 'fulfilled', value: await mapper(values[index]!, index) };
      } catch (reason) {
        results[index] = { status: 'rejected', reason };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, () => worker()));
  return results;
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
  const result = new Date(utcMs);
  const verified = getParisDateTimeParts(result);
  if (
    verified.year !== year || verified.month !== month || verified.day !== day
    || verified.hour !== hour || verified.minute !== minute || verified.second !== second
  ) {
    throw new Error('calendar_invalid_local_time');
  }
  return result;
}

function validateLocalTemporalParts(year: number, month: number, day: number, hour: number, minute: number, second: number): void {
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59 || second < 0 || second > 59) {
    throw new Error('calendar_invalid_local_time');
  }
  const normalized = new Date(Date.UTC(year, month - 1, day));
  if (
    normalized.getUTCFullYear() !== year
    || normalized.getUTCMonth() + 1 !== month
    || normalized.getUTCDate() !== day
  ) {
    throw new Error('calendar_invalid_local_time');
  }
}

export function toGoogleCalendarTimeBoundary(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error('calendar_invalid_time_boundary');
  if (RFC3339_ZONE_SUFFIX_RE.test(trimmed)) {
    if (!Number.isFinite(Date.parse(trimmed))) throw new Error('calendar_invalid_time_boundary');
    return trimmed;
  }
  const match = trimmed.match(LOCAL_TEMPORAL_RE);
  if (!match) throw new Error('calendar_invalid_time_boundary');
  const year = Number.parseInt(match[1]!, 10);
  const month = Number.parseInt(match[2]!, 10);
  const day = Number.parseInt(match[3]!, 10);
  const hour = Number.parseInt(match[4] ?? '0', 10);
  const minute = Number.parseInt(match[5] ?? '0', 10);
  const second = Number.parseInt(match[6] ?? '0', 10);
  validateLocalTemporalParts(year, month, day, hour, minute, second);
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
  const ids = [...new Set(raw
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean))];
  if (ids.length > CALENDAR_MAX_IDS) throw new Error('calendar_too_many_ids');
  return ids;
}

/**
 * Resolve the start date of a Google Calendar event.
 * All-day events use `date` (represented as UTC midnight to preserve the calendar date); timed events use `dateTime`.
 */
export function resolveEventStart(ev: GoogleCalendarEvent): Date {
  const raw = ev.start?.dateTime ?? (ev.start?.date ? `${ev.start.date}T00:00:00Z` : null);
  if (!raw) return new Date(0);
  const d = new Date(raw);
  return isNaN(d.getTime()) ? new Date(0) : d;
}

/** Resolve the end date of a Google Calendar event. */
export function resolveEventEnd(ev: GoogleCalendarEvent): Date {
  const raw = ev.end?.dateTime ?? (ev.end?.date ? `${ev.end.date}T00:00:00Z` : null);
  if (!raw) return new Date(0);
  const d = new Date(raw);
  return isNaN(d.getTime()) ? new Date(0) : d;
}

/** Format a Date for display (fr-FR short). */
export function formatEventDate(date: Date, isAllDay: boolean): string {
  if (isAllDay) {
    return date.toLocaleDateString('fr-FR', { weekday: 'long', day: '2-digit', month: '2-digit', timeZone: 'UTC' });
  }
  return date.toLocaleString('fr-FR', {
    weekday: 'long',
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Europe/Paris',
  });
}

// ─── Multi-calendar fetch ─────────────────────────────────────────────────────

export type CalendarEventWithMeta = GoogleCalendarEvent & { calendarId: string };
export type CalendarMultiFetchResult = {
  events: CalendarEventWithMeta[];
  failedCalendarIds: string[];
  failures: Array<{ calendarId: string; error: unknown }>;
};

export type GoogleCalendarListEntry = {
  id?: string;
  summary?: string;
  accessRole?: string;
  deleted?: boolean;
  primary?: boolean;
};

export function selectOwnedCalendarIds(items: GoogleCalendarListEntry[]): string[] {
  const ids = items
    .filter((item) => {
      const label = item.summary?.trim().toLocaleLowerCase('fr-FR') ?? '';
      const isFormulaOneCalendar = /^(?:f1|formula 1|formule 1|grand prix)$/u.test(label);
      return !item.deleted && !isFormulaOneCalendar &&
        (item.primary || item.accessRole === 'owner' || item.accessRole === 'writer');
    })
    .map((item) => item.id?.trim() ?? '')
    .filter(Boolean);
  return [...new Set(ids.length > 0 ? ids : ['primary'])];
}

/**
 * Discover calendars that belong to the connected Google account.
 *
 * Read-only subscriptions (week numbers, public holidays, sports feeds, etc.)
 * are deliberately excluded from the dashboard. Shared calendars remain
 * included when the connected member can write to them.
 */
export async function discoverOwnedCalendarIds(env: CalendarTokenEnv): Promise<string[]> {
  return withCalendarAccessToken(env, async (token) => selectOwnedCalendarIds(
    await calendarApiListItems<GoogleCalendarListEntry>(
      '/users/me/calendarList?showDeleted=false&showHidden=false&maxResults=250',
      token,
      1_000,
    ),
  ));
}

/**
 * Fetch upcoming events from multiple calendars in parallel.
 *
 * API contract (from docs):
 *  - timeMin: lower bound (exclusive) on event **end** time (RFC3339)
 *  - timeMax: upper bound (exclusive) on event **start** time (RFC3339)
 *  - singleEvents=true + orderBy=startTime: expand recurring events, ordered by start
 *
 * Per-calendar failures are returned to the caller so partial data can never
 * be presented as a complete calendar result.
 */
export async function fetchUpcomingEventsMultiCalendarDetailed(
  env: CalendarTokenEnv,
  calendarIds: string[],
  timeMin: string,
  timeMax: string,
  maxPerCalendar = 50,
): Promise<CalendarMultiFetchResult> {
  if (calendarIds.length === 0) return { events: [], failedCalendarIds: [], failures: [] };
  if (calendarIds.length > CALENDAR_MAX_IDS) throw new Error('calendar_too_many_ids');
  return withCalendarAccessToken(env, async (token) => {
    const results = await mapWithConcurrency(
      calendarIds,
      CALENDAR_FETCH_CONCURRENCY,
      async (id) => {
      const params = new URLSearchParams({
        singleEvents:  'true',
        orderBy:       'startTime',
        maxResults:    String(maxPerCalendar),
        timeMin:       toGoogleCalendarTimeBoundary(timeMin),
        timeMax:       toGoogleCalendarTimeBoundary(timeMax),
        showDeleted:   'false',
      });
      return (await calendarApiListItems<GoogleCalendarEvent>(
        `/calendars/${encodeURIComponent(id)}/events?${params.toString()}`,
        token,
        maxPerCalendar,
      )).map((ev): CalendarEventWithMeta => ({ ...ev, calendarId: id }));
      },
    );

    const rejected = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
    const authFailure = rejected.find((result) => result.reason instanceof CalendarApiError && result.reason.status === 401);
    if (authFailure) throw authFailure.reason;

    const all: CalendarEventWithMeta[] = [];
    const failedCalendarIds: string[] = [];
    const failures: Array<{ calendarId: string; error: unknown }> = [];
    results.forEach((result, index) => {
      if (result.status === 'fulfilled') all.push(...result.value);
      else {
        const calendarId = calendarIds[index] ?? 'unknown';
        failedCalendarIds.push(calendarId);
        failures.push({ calendarId, error: result.reason });
      }
    });

  // The same event can be exposed through the primary alias and a concrete
  // calendar id, or through two calendars participating in one invitation.
    const unique = [...new Map(all.map((event) => [
      `${event.iCalUID?.trim() || event.id}|${event.start?.dateTime ?? event.start?.date ?? ''}`,
      event,
    ])).values()];

  // Merge & sort by start time across all calendars
    unique.sort((a, b) => {
      const aStart = a.start?.dateTime ?? a.start?.date ?? '';
      const bStart = b.start?.dateTime ?? b.start?.date ?? '';
      return aStart.localeCompare(bStart);
    });

    return { events: unique, failedCalendarIds, failures };
  });
}
