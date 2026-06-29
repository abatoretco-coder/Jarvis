import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { getGoogleCalendarConfigState } from '../calendar/googleCalendarClient';
import { resolveGoogleCredentials } from '../google/googleCredentialService';
import type { AppDeps } from '../server';

type GoogleCalendarListItem = {
  id: string;
  summary?: string;
  description?: string;
  timeZone?: string;
  backgroundColor?: string;
  foregroundColor?: string;
  accessRole?: string;
  primary?: boolean;
};

type GoogleCalendarEventDateTime = {
  date?: string;
  dateTime?: string;
  timeZone?: string;
};

type GoogleCalendarEvent = {
  id: string;
  status?: string;
  htmlLink?: string;
  created?: string;
  updated?: string;
  summary?: string;
  description?: string;
  location?: string;
  colorId?: string;
  start?: GoogleCalendarEventDateTime;
  end?: GoogleCalendarEventDateTime;
  recurrence?: string[];
  attendees?: Array<{
    email?: string;
    displayName?: string;
    optional?: boolean;
    responseStatus?: 'needsAction' | 'declined' | 'tentative' | 'accepted';
  }>;
  reminders?: {
    useDefault?: boolean;
    overrides?: Array<{ method?: 'email' | 'popup'; minutes?: number }>;
  };
  transparency?: 'opaque' | 'transparent';
  visibility?: 'default' | 'public' | 'private' | 'confidential';
  conferenceData?: unknown;
  attendeesOmitted?: boolean;
  guestsCanInviteOthers?: boolean;
  guestsCanModify?: boolean;
  guestsCanSeeOtherGuests?: boolean;
  source?: { title?: string; url?: string };
  extendedProperties?: { private?: Record<string, string>; shared?: Record<string, string> };
  eventType?: string;
};

type GoogleTokenPayload = {
  access_token?: string;
};

const GOOGLE_CALENDAR_BASE = 'https://www.googleapis.com/calendar/v3';

const sendUpdatesSchema = z.enum(['none', 'all', 'externalOnly']).default('none');
const calendarEventDateTimeSchema = z.object({
  date: z.string().trim().min(1).optional(),
  dateTime: z.string().trim().min(1).optional(),
  timeZone: z.string().trim().min(1).optional(),
}).strict();
const writableEventSchema = z.object({
  summary: z.string().trim().min(1).max(300).optional(),
  description: z.string().max(2_000).nullable().optional(),
  location: z.string().max(500).nullable().optional(),
  start: calendarEventDateTimeSchema.optional(),
  end: calendarEventDateTimeSchema.optional(),
  attendees: z.array(z.object({
    email: z.string().trim().email().optional(),
    displayName: z.string().trim().max(200).optional(),
    optional: z.boolean().optional(),
    responseStatus: z.enum(['needsAction', 'declined', 'tentative', 'accepted']).optional(),
  }).strict()).max(100).optional(),
  reminders: z.object({
    useDefault: z.boolean().optional(),
    overrides: z.array(z.object({
      method: z.enum(['email', 'popup']).optional(),
      minutes: z.coerce.number().int().min(0).max(40320).optional(),
    }).strict()).max(10).optional(),
  }).strict().optional(),
}).strict();

async function ensureCalendarReady(env: AppDeps['env']): Promise<{ ok: true } | { ok: false; error: string }> {
  const state = await getGoogleCalendarConfigState(env);
  if (state === 'ready') return { ok: true };
  return { ok: false, error: state };
}

function allowedCalendarIds(env: AppDeps['env']): Set<string> {
  const ids = new Set(
    String(env.GOOGLE_CALENDAR_CALENDAR_IDS ?? '')
      .split(',')
      .map((id) => id.trim())
      .filter(Boolean),
  );
  if (env.GOOGLE_CALENDAR_DEFAULT_CREATE_CALENDAR_ID) ids.add(env.GOOGLE_CALENDAR_DEFAULT_CREATE_CALENDAR_ID.trim());
  ids.add('primary');
  return ids;
}

function resolveAllowedCalendarId(value: unknown, env: AppDeps['env'], fallback = 'primary'): string | null {
  const raw = asStringQuery(value, fallback);
  return allowedCalendarIds(env).has(raw) ? raw : null;
}

function parseSendUpdates(value: unknown): 'none' | 'all' | 'externalOnly' | null {
  const parsed = sendUpdatesSchema.safeParse(asStringQuery(value, 'none'));
  return parsed.success ? parsed.data : null;
}

async function refreshGoogleAccessToken(env: AppDeps['env']): Promise<string> {
  const credentials = await resolveGoogleCredentials(env);
  if (!credentials) {
    throw new Error('google_calendar_credentials_missing');
  }

  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: credentials.clientId,
      client_secret: credentials.clientSecret,
      refresh_token: credentials.refreshToken,
      grant_type: 'refresh_token',
    }),
    signal: AbortSignal.timeout(8_000),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`google_calendar_token_refresh_failed:${response.status}:${body.slice(0, 200)}`);
  }

  const payload = await response.json() as GoogleTokenPayload;
  if (!payload.access_token) throw new Error('google_calendar_token_refresh_no_token');
  return payload.access_token;
}

async function googleCalendarRequest<T>(
  path: string,
  accessToken: string,
  options?: { method?: 'GET' | 'POST' | 'PATCH' | 'DELETE'; body?: unknown },
): Promise<T> {
  const response = await fetch(`${GOOGLE_CALENDAR_BASE}${path}`, {
    method: options?.method ?? 'GET',
    headers: {
      authorization: `Bearer ${accessToken}`,
      accept: 'application/json',
      ...(options?.body ? { 'content-type': 'application/json' } : {}),
    },
    body: options?.body ? JSON.stringify(options.body) : undefined,
    signal: AbortSignal.timeout(10_000),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`google_calendar_request_failed:${response.status}:${body.slice(0, 300)}`);
  }

  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

function asBooleanQuery(value: unknown, fallback = false): boolean {
  if (typeof value !== 'string') return fallback;
  const normalized = value.trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes';
}

function asNumberQuery(value: unknown, fallback: number): number {
  if (typeof value !== 'string') return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return parsed;
}

function asStringQuery(value: unknown, fallback = ''): string {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

export function registerGoogleCalendarRoute(app: FastifyInstance, deps: AppDeps): void {
  app.get('/v1/calendar/google/calendars', async (_req, reply) => {
    const ready = await ensureCalendarReady(deps.env);
    if (!ready.ok) return reply.code(503).send({ error: 'google_calendar_not_configured', state: ready.error });

    try {
      const token = await refreshGoogleAccessToken(deps.env);
      const payload = await googleCalendarRequest<{ items?: GoogleCalendarListItem[] }>(
        '/users/me/calendarList?showHidden=true&maxResults=250',
        token,
      );
      const items = (payload.items ?? []).map((item) => ({
        id: item.id,
        summary: item.summary ?? item.id,
        description: item.description ?? '',
        timeZone: item.timeZone ?? '',
        backgroundColor: item.backgroundColor ?? '',
        foregroundColor: item.foregroundColor ?? '',
        accessRole: item.accessRole ?? 'reader',
        primary: Boolean(item.primary),
      }));

      return reply.code(200).send({ status: 'ok', items });
    } catch (error) {
      app.log.warn({ error }, 'google_calendar_calendars_failed');
      return reply.code(502).send({ error: 'google_calendar_calendars_failed' });
    }
  });

  app.get('/v1/calendar/google/events', async (req, reply) => {
    const ready = await ensureCalendarReady(deps.env);
    if (!ready.ok) return reply.code(503).send({ error: 'google_calendar_not_configured', state: ready.error });

    const query = req.query as Record<string, unknown>;
    const resolvedCalendarId = resolveAllowedCalendarId(query.calendarId, deps.env);
    if (!resolvedCalendarId) return reply.code(400).send({ error: 'calendar_id_not_allowed' });
    const calendarId = encodeURIComponent(resolvedCalendarId);
    const timeMin = asStringQuery(query.timeMin);
    const timeMax = asStringQuery(query.timeMax);
    const q = asStringQuery(query.q);
    const pageToken = asStringQuery(query.pageToken);
    const maxResults = Math.max(1, Math.min(250, asNumberQuery(query.maxResults, 120)));
    const singleEvents = asBooleanQuery(query.singleEvents, true);
    const showDeleted = asBooleanQuery(query.showDeleted, false);
    const orderBy = asStringQuery(query.orderBy, singleEvents ? 'startTime' : 'updated');

    const params = new URLSearchParams({
      maxResults: String(maxResults),
      singleEvents: String(singleEvents),
      showDeleted: String(showDeleted),
      orderBy,
    });
    if (timeMin) params.set('timeMin', timeMin);
    if (timeMax) params.set('timeMax', timeMax);
    if (q) params.set('q', q);
    if (pageToken) params.set('pageToken', pageToken);

    try {
      const token = await refreshGoogleAccessToken(deps.env);
      const payload = await googleCalendarRequest<{
        items?: GoogleCalendarEvent[];
        nextPageToken?: string;
        timeZone?: string;
      }>(`/calendars/${calendarId}/events?${params.toString()}`, token);

      return reply.code(200).send({
        status: 'ok',
        timeZone: payload.timeZone ?? '',
        nextPageToken: payload.nextPageToken ?? null,
        items: payload.items ?? [],
      });
    } catch (error) {
      app.log.warn({ error }, 'google_calendar_events_list_failed');
      return reply.code(502).send({ error: 'google_calendar_events_list_failed' });
    }
  });

  app.get('/v1/calendar/google/events/:eventId', async (req, reply) => {
    const ready = await ensureCalendarReady(deps.env);
    if (!ready.ok) return reply.code(503).send({ error: 'google_calendar_not_configured', state: ready.error });

    const params = req.params as { eventId?: string };
    const eventId = params.eventId?.trim();
    if (!eventId) return reply.code(400).send({ error: 'event_id_required' });

    const query = req.query as Record<string, unknown>;
    const resolvedCalendarId = resolveAllowedCalendarId(query.calendarId, deps.env);
    if (!resolvedCalendarId) return reply.code(400).send({ error: 'calendar_id_not_allowed' });
    const calendarId = encodeURIComponent(resolvedCalendarId);

    try {
      const token = await refreshGoogleAccessToken(deps.env);
      const item = await googleCalendarRequest<GoogleCalendarEvent>(
        `/calendars/${calendarId}/events/${encodeURIComponent(eventId)}?conferenceDataVersion=1`,
        token,
      );
      return reply.code(200).send({ status: 'ok', item });
    } catch (error) {
      app.log.warn({ error }, 'google_calendar_event_get_failed');
      return reply.code(502).send({ error: 'google_calendar_event_get_failed' });
    }
  });

  app.post('/v1/calendar/google/events', async (req, reply) => {
    const ready = await ensureCalendarReady(deps.env);
    if (!ready.ok) return reply.code(503).send({ error: 'google_calendar_not_configured', state: ready.error });

    const query = req.query as Record<string, unknown>;
    const resolvedCalendarId = resolveAllowedCalendarId(query.calendarId, deps.env);
    if (!resolvedCalendarId) return reply.code(400).send({ error: 'calendar_id_not_allowed' });
    const calendarId = encodeURIComponent(resolvedCalendarId);
    const sendUpdates = parseSendUpdates(query.sendUpdates);
    if (!sendUpdates) return reply.code(400).send({ error: 'invalid_send_updates' });
    const parsedBody = writableEventSchema.safeParse(req.body);
    if (!parsedBody.success) return reply.code(400).send({ error: 'invalid_body', issues: parsedBody.error.issues });
    const body = parsedBody.data;
    if (!body.start || !body.end) {
      return reply.code(400).send({ error: 'start_and_end_required' });
    }

    try {
      const token = await refreshGoogleAccessToken(deps.env);
      const item = await googleCalendarRequest<GoogleCalendarEvent>(
        `/calendars/${calendarId}/events?sendUpdates=${encodeURIComponent(sendUpdates)}`,
        token,
        { method: 'POST', body },
      );
      return reply.code(200).send({ status: 'ok', item });
    } catch (error) {
      app.log.warn({ error }, 'google_calendar_event_create_failed');
      return reply.code(502).send({ error: 'google_calendar_event_create_failed' });
    }
  });

  app.patch('/v1/calendar/google/events/:eventId', async (req, reply) => {
    const ready = await ensureCalendarReady(deps.env);
    if (!ready.ok) return reply.code(503).send({ error: 'google_calendar_not_configured', state: ready.error });

    const params = req.params as { eventId?: string };
    const eventId = params.eventId?.trim();
    if (!eventId) return reply.code(400).send({ error: 'event_id_required' });

    const query = req.query as Record<string, unknown>;
    const resolvedCalendarId = resolveAllowedCalendarId(query.calendarId, deps.env);
    if (!resolvedCalendarId) return reply.code(400).send({ error: 'calendar_id_not_allowed' });
    const calendarId = encodeURIComponent(resolvedCalendarId);
    const sendUpdates = parseSendUpdates(query.sendUpdates);
    if (!sendUpdates) return reply.code(400).send({ error: 'invalid_send_updates' });
    const parsedBody = writableEventSchema.safeParse(req.body);
    if (!parsedBody.success) return reply.code(400).send({ error: 'invalid_body', issues: parsedBody.error.issues });
    const body = parsedBody.data;

    try {
      const token = await refreshGoogleAccessToken(deps.env);
      const item = await googleCalendarRequest<GoogleCalendarEvent>(
        `/calendars/${calendarId}/events/${encodeURIComponent(eventId)}?sendUpdates=${encodeURIComponent(sendUpdates)}`,
        token,
        { method: 'PATCH', body },
      );
      return reply.code(200).send({ status: 'ok', item });
    } catch (error) {
      app.log.warn({ error }, 'google_calendar_event_patch_failed');
      return reply.code(502).send({ error: 'google_calendar_event_patch_failed' });
    }
  });

  app.delete('/v1/calendar/google/events/:eventId', async (req, reply) => {
    const ready = await ensureCalendarReady(deps.env);
    if (!ready.ok) return reply.code(503).send({ error: 'google_calendar_not_configured', state: ready.error });

    const params = req.params as { eventId?: string };
    const eventId = params.eventId?.trim();
    if (!eventId) return reply.code(400).send({ error: 'event_id_required' });

    const query = req.query as Record<string, unknown>;
    const resolvedCalendarId = resolveAllowedCalendarId(query.calendarId, deps.env);
    if (!resolvedCalendarId) return reply.code(400).send({ error: 'calendar_id_not_allowed' });
    const calendarId = encodeURIComponent(resolvedCalendarId);
    const sendUpdates = parseSendUpdates(query.sendUpdates);
    if (!sendUpdates) return reply.code(400).send({ error: 'invalid_send_updates' });

    try {
      const token = await refreshGoogleAccessToken(deps.env);
      await googleCalendarRequest<void>(
        `/calendars/${calendarId}/events/${encodeURIComponent(eventId)}?sendUpdates=${encodeURIComponent(sendUpdates)}`,
        token,
        { method: 'DELETE' },
      );
      return reply.code(200).send({ status: 'ok' });
    } catch (error) {
      app.log.warn({ error }, 'google_calendar_event_delete_failed');
      return reply.code(502).send({ error: 'google_calendar_event_delete_failed' });
    }
  });
}
