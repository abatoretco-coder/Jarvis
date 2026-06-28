/**
 * Calendar Agent — direct Google Calendar read/write for conversational queries.
 *
 * Architecture (mirrors mailAgent.ts / todoAgent.ts):
 *  1. isCalendarAgentKey()  — detected in ingest.ts to bypass HA conversation
 *  2. callCalendarAgent()   — LLM planner (gpt-4o-mini) → Google Calendar API executor
 *
 * Supported intents:
 *  - list_upcoming  : "Qu'est-ce que j'ai demain ?"
 *  - search_events  : "Est-ce qu'il y a un GP F1 ce mois ?"
 *  - create_event   : "Ajoute un RDV dentiste vendredi 15h"
 */

import { z } from 'zod';

import { formatParisDateTime, getParisIsoDate } from '../time/parisTime';
import {
  calendarApiRequest,
  type CalendarTokenEnv,
  fetchUpcomingEventsMultiCalendar,
  formatEventDate,
  getGoogleCalendarConfigState,
  type GoogleCalendarEvent,
  parseCalendarIds,
  refreshCalendarToken,
  resolveEventEnd,
  resolveEventStart,
} from './googleCalendarClient';

// ─── Key detection ────────────────────────────────────────────────────────────

/**
 * Returns true for any HA_AGENT_MAP key that should be handled by this
 * calendar agent directly (bypasses Home Assistant conversation).
 * Mirrors isMailAgentKey() from mail/mailAgent.ts.
 */
export function isCalendarAgentKey(key: string | undefined): key is string {
  if (!key) return false;
  return key === 'calendar' || key.startsWith('calendar.');
}

// ─── Env surface ──────────────────────────────────────────────────────────────

export interface CalendarAgentEnv {
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  GOOGLE_REFRESH_TOKEN?: string;
  OAUTH_REFRESH_TOKEN_STORE_PATH?: string;
  GOOGLE_CALENDAR_CALENDAR_IDS?: string;
  GOOGLE_CALENDAR_DEFAULT_CREATE_CALENDAR_ID?: string;
  GOOGLE_CALENDAR_DEFAULT_CREATE_CALENDAR_LABEL?: string;
  OPENAI_API_KEY?: string;
  OPENAI_BASE_URL: string;
  OPENAI_TIMEOUT_MS: number;
}

// ─── Planner types ────────────────────────────────────────────────────────────

export type CalendarAction =
  | { action: 'list_upcoming'; calendarId?: string; timeMin: string; timeMax: string; summary?: string }
  | { action: 'search_events'; q: string; calendarId?: string; timeMin?: string; timeMax?: string; maxResults?: number; summary?: string }
  | { action: 'create_event'; summary: string; start: string; end: string; isAllDay?: boolean; description?: string; location?: string; calendarId?: string };

export type CalendarAgentMode = 'execute' | 'propose';

const localDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/u);
const localDateTimeSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$/u);
const localTemporalSchema = z.union([localDateSchema, localDateTimeSchema]);
const optionalCalendarIdSchema = z.string().trim().min(1).max(256).optional();

const calendarActionSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('list_upcoming'),
    calendarId: optionalCalendarIdSchema,
    timeMin: localTemporalSchema,
    timeMax: localTemporalSchema,
    summary: z.string().trim().min(1).max(500).optional(),
  }).strict(),
  z.object({
    action: z.literal('search_events'),
    q: z.string().trim().min(1).max(200),
    calendarId: optionalCalendarIdSchema,
    timeMin: localTemporalSchema.optional(),
    timeMax: localTemporalSchema.optional(),
    maxResults: z.coerce.number().int().min(1).max(20).default(5),
    summary: z.string().trim().min(1).max(500).optional(),
  }).strict(),
  z.object({
    action: z.literal('create_event'),
    summary: z.string().trim().min(1).max(300),
    start: localTemporalSchema,
    end: localTemporalSchema,
    isAllDay: z.boolean().optional(),
    description: z.string().trim().max(2_000).optional(),
    location: z.string().trim().max(500).optional(),
    calendarId: optionalCalendarIdSchema,
  }).strict(),
]).superRefine((action, ctx) => {
  if ('timeMin' in action && action.timeMin && 'timeMax' in action && action.timeMax) {
    const start = Date.parse(action.timeMin);
    const end = Date.parse(action.timeMax);
    if (Number.isFinite(start) && Number.isFinite(end) && end <= start) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'timeMax must be after timeMin', path: ['timeMax'] });
    }
  }
  if (action.action !== 'create_event') return;
  const startIsDate = localDateSchema.safeParse(action.start).success;
  const endIsDate = localDateSchema.safeParse(action.end).success;
  const isAllDay = action.isAllDay ?? (startIsDate && endIsDate);
  if (isAllDay && (!startIsDate || !endIsDate)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'all-day events must use YYYY-MM-DD start/end', path: ['isAllDay'] });
  }
  if (!isAllDay && (startIsDate || endIsDate)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'timed events must use local date-time start/end', path: ['start'] });
  }
  const start = Date.parse(action.start);
  const end = Date.parse(action.end);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'end must be after start', path: ['end'] });
  }
});

function allowedCalendarIds(env: CalendarAgentEnv): Set<string> {
  return new Set(parseCalendarIds(env.GOOGLE_CALENDAR_CALENDAR_IDS));
}

export function parseCalendarAction(value: unknown, env: CalendarAgentEnv): CalendarAction {
  const parsed = calendarActionSchema.parse(value);
  const allowed = allowedCalendarIds(env);
  const checkAllowed = (calendarId: string | undefined, path: (string | number)[]): void => {
    if (calendarId && !allowed.has(calendarId)) {
      throw new z.ZodError([{ code: z.ZodIssueCode.custom, message: 'calendarId is not allowlisted', path }]);
    }
  };
  checkAllowed(parsed.calendarId, ['calendarId']);
  if (parsed.action === 'create_event') {
    const createCalendarId = parsed.calendarId?.trim() || env.GOOGLE_CALENDAR_DEFAULT_CREATE_CALENDAR_ID?.trim() || 'primary';
    if (!allowed.has(createCalendarId)) {
      throw new z.ZodError([{ code: z.ZodIssueCode.custom, message: 'create calendarId is not allowlisted', path: ['calendarId'] }]);
    }
    return { ...parsed, calendarId: createCalendarId, isAllDay: parsed.isAllDay ?? localDateSchema.safeParse(parsed.start).success };
  }
  return parsed;
}

type MinLogger = {
  info: (obj: Record<string, unknown>, msg: string) => void;
  warn: (obj: Record<string, unknown>, msg: string) => void;
};

// ─── Planner ──────────────────────────────────────────────────────────────────

function buildPlannerSystemPrompt(dateStr: string, isoDate: string): string {
  return `Tu es un assistant de gestion du calendrier personnel.
La date et heure actuelles sont : ${dateStr}.
Date ISO du jour : ${isoDate}.

Analyse la commande en français et retourne un JSON correspondant à UNE seule action calendrier.

Champ obligatoire "action" parmi :
  list_upcoming | search_events | create_event

Champs selon l'action :

  list_upcoming :
    timeMin (string, ISO8601, obligatoire) — début de la fenêtre (minuit du jour de début)
    timeMax (string, ISO8601, obligatoire) — fin de la fenêtre (minuit du lendemain du dernier jour)
    calendarId (string, optionnel) — "primary" si non précisé

  search_events :
    q (string, obligatoire) — texte libre à chercher dans le résumé/description
    timeMin (string, ISO8601, optionnel)
    timeMax (string, ISO8601, optionnel)
    maxResults (entier 1-20, défaut 5)
    calendarId (string, optionnel)

  create_event :
    summary (string, obligatoire) — titre de l'événement
    start (string, obligatoire) — ISO8601 : "YYYY-MM-DD" pour journée entière, "YYYY-MM-DDTHH:MM:SS" pour timed
    end (string, obligatoire) — ISO8601 : idem
    isAllDay (bool, optionnel) — true si start/end sont des dates sans heure
    description (string, optionnel)
    location (string, optionnel)
    calendarId (string, optionnel)

Règles de résolution temporelle relative :
  - "demain" = le lendemain du jour actuel, de 00:00 à 23:59:59
  - "après-demain" = jour + 2
  - "cette semaine" = du lundi au dimanche de la semaine courante
  - "la semaine prochaine" = lundi au dimanche de la semaine suivante
  - "ce mois" = du 1er au dernier jour du mois actuel
  - "ce week-end" = samedi et dimanche à venir
  - Si une heure est précisée (ex "15h") : utiliser HH:MM:00 en heure locale (Europe/Paris)
  - Pour create_event sans durée précisée : durée par défaut d'1 heure

Réponds UNIQUEMENT avec du JSON valide, sans texte supplémentaire.

Exemples :
  "Qu'est-ce que j'ai demain ?"
    → {"action":"list_upcoming","timeMin":"2026-05-23T00:00:00","timeMax":"2026-05-24T00:00:00"}
  "Montre mes événements de cette semaine"
    → {"action":"list_upcoming","timeMin":"2026-05-18T00:00:00","timeMax":"2026-05-25T00:00:00"}
  "Est-ce qu'il y a un GP F1 ce mois ?"
    → {"action":"search_events","q":"Formula 1","timeMin":"2026-05-01T00:00:00","timeMax":"2026-06-01T00:00:00"}
  "Ajoute un RDV dentiste vendredi 15h"
    → {"action":"create_event","summary":"RDV dentiste","start":"2026-05-29T15:00:00","end":"2026-05-29T16:00:00"}
  "Ajoute journée télétravail lundi"
    → {"action":"create_event","summary":"Télétravail","start":"2026-05-25","end":"2026-05-26","isAllDay":true}
`.trim();
}

async function planCalendarAction(
  text: string,
  env: CalendarAgentEnv,
): Promise<CalendarAction> {
  const now = new Date();
  const dateStr = formatParisDateTime(now);
  const isoDate = getParisIsoDate(now);

  const resp = await fetch(`${env.OPENAI_BASE_URL.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${env.OPENAI_API_KEY?.trim() ?? ''}`,
    },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      temperature: 0,
      max_tokens: 250,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: buildPlannerSystemPrompt(dateStr, isoDate) },
        { role: 'user', content: text },
      ],
    }),
    signal: AbortSignal.timeout(env.OPENAI_TIMEOUT_MS),
  });

  if (!resp.ok) {
    const raw = await resp.text().catch(() => '');
    throw new Error(`calendar_planner_llm_failed:${resp.status}:${raw.slice(0, 200)}`);
  }

  const data = await resp.json() as { choices?: Array<{ message?: { content?: string } }> };
  const content = data.choices?.[0]?.message?.content?.trim() ?? '{}';

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error(`calendar_planner_invalid_json:${content.slice(0, 100)}`);
  }

  if (typeof parsed !== 'object' || parsed === null || !('action' in parsed)) {
    throw new Error(`calendar_planner_missing_action:${content.slice(0, 100)}`);
  }

  return parseCalendarAction(parsed, env);
}

export async function planCalendarAgentAction(
  text: string,
  env: CalendarAgentEnv,
): Promise<CalendarAction> {
  const configState = await getGoogleCalendarConfigState(env);
  if (configState !== 'ready') {
    throw new Error('calendar_credentials_missing');
  }
  if (!env.OPENAI_API_KEY?.trim()) {
    throw new Error('calendar_agent_openai_key_missing');
  }
  return planCalendarAction(text, env);
}

// ─── Executor ─────────────────────────────────────────────────────────────────

function formatEventLine(ev: GoogleCalendarEvent): string {
  const isAllDay = !ev.start?.dateTime;
  const start = resolveEventStart(ev);
  const title = ev.summary?.trim() || '(sans titre)';
  const dateStr = formatEventDate(start, isAllDay);
  return `${dateStr} : ${title}`;
}

function resolveCreateCalendarId(plan: CalendarAction, env: CalendarAgentEnv): string {
  if ('calendarId' in plan && typeof plan.calendarId === 'string' && plan.calendarId.trim()) {
    return plan.calendarId.trim();
  }
  if (env.GOOGLE_CALENDAR_DEFAULT_CREATE_CALENDAR_ID?.trim()) {
    return env.GOOGLE_CALENDAR_DEFAULT_CREATE_CALENDAR_ID.trim();
  }
  return 'primary';
}

export function formatCalendarProposal(plan: CalendarAction): string {
  if (plan.action !== 'create_event') return 'Action calendrier prête.';
  const when = plan.isAllDay
    ? `le ${plan.start}`
    : `du ${plan.start.replace('T', ' à ')} au ${plan.end.replace('T', ' à ')}`;
  const place = plan.location ? `, lieu : ${plan.location}` : '';
  return `Je peux ajouter "${plan.summary}" dans ton agenda ${when}${place}. Confirme dans ce fil si tu veux que je le crée.`;
}

function formatCreatedEventDate(ev: GoogleCalendarEvent, isAllDay: boolean): string {
  const start = resolveEventStart(ev);
  if (isAllDay) {
    return start.toLocaleDateString('fr-FR', {
      weekday: 'long',
      day: 'numeric',
      month: 'long',
      timeZone: 'Europe/Paris',
    });
  }
  return start.toLocaleString('fr-FR', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Europe/Paris',
  });
}

async function executeCalendarAction(
  plan: CalendarAction,
  env: CalendarAgentEnv,
): Promise<string> {
  const configState = await getGoogleCalendarConfigState(env);
  if (configState === 'missing_client') return 'Le calendrier Google n\'est pas configuré sur ce serveur.';
  if (configState === 'missing_refresh_token') return 'Connecte Google via OAuth pour activer le calendrier.';
  const tokenEnv = env as CalendarTokenEnv;

  switch (plan.action) {
    case 'list_upcoming': {
      const calendarIds = plan.calendarId
        ? [plan.calendarId]
        : parseCalendarIds(env.GOOGLE_CALENDAR_CALENDAR_IDS);

      const events = await fetchUpcomingEventsMultiCalendar(
        tokenEnv,
        calendarIds,
        plan.timeMin,
        plan.timeMax,
        20,
      );
      const active = events.filter((ev) => ev.status !== 'cancelled');

      if (active.length === 0) {
        return 'Aucun événement prévu dans cette période.';
      }

      const lines = active.slice(0, 10).map(formatEventLine);
      return lines.join('\n');
    }

    case 'search_events': {
      const token = await refreshCalendarToken(tokenEnv);
      const calendarIds = plan.calendarId
        ? [plan.calendarId]
        : parseCalendarIds(env.GOOGLE_CALENDAR_CALENDAR_IDS);
      const maxResults = Math.max(1, Math.min(20, plan.maxResults ?? 5));

      const perCalendar = await Promise.allSettled(
        calendarIds.map((id) => {
          const params = new URLSearchParams({
            singleEvents: 'true',
            orderBy:      'startTime',
            maxResults:   String(maxResults),
            showDeleted:  'false',
            q:            plan.q,
          });
          if (plan.timeMin) params.set('timeMin', plan.timeMin);
          if (plan.timeMax) params.set('timeMax', plan.timeMax);
          return calendarApiRequest<{ items?: GoogleCalendarEvent[] }>(
            `/calendars/${encodeURIComponent(id)}/events?${params.toString()}`,
            token,
          );
        }),
      );

      const all: GoogleCalendarEvent[] = [];
      for (const r of perCalendar) {
        if (r.status === 'fulfilled') all.push(...(r.value.items ?? []));
      }
      const active = all.filter((ev) => ev.status !== 'cancelled');
      active.sort((a, b) => {
        const aS = a.start?.dateTime ?? a.start?.date ?? '';
        const bS = b.start?.dateTime ?? b.start?.date ?? '';
        return aS.localeCompare(bS);
      });

      if (active.length === 0) {
        return `Aucun événement trouvé pour "${plan.q}".`;
      }

      const lines = active.slice(0, maxResults).map(formatEventLine);
      return `${active.length} résultat${active.length > 1 ? 's' : ''} pour "${plan.q}" :\n${lines.join('\n')}`;
    }

    case 'create_event': {
      const token = await refreshCalendarToken(tokenEnv);
      const calendarId = resolveCreateCalendarId(plan, env);

      const eventBody: Record<string, unknown> = {
        summary: plan.summary,
        start: plan.isAllDay
          ? { date: plan.start }
          : { dateTime: plan.start.includes('T') ? plan.start : `${plan.start}T00:00:00`, timeZone: 'Europe/Paris' },
        end: plan.isAllDay
          ? { date: plan.end }
          : { dateTime: plan.end.includes('T') ? plan.end : `${plan.end}T00:00:00`, timeZone: 'Europe/Paris' },
      };
      eventBody['reminders'] = { useDefault: false, overrides: [] };
      if (plan.description) eventBody['description'] = plan.description;
      if (plan.location)    eventBody['location']    = plan.location;

      const created = await calendarApiRequest<GoogleCalendarEvent>(
        `/calendars/${encodeURIComponent(calendarId)}/events?sendUpdates=none`,
        token,
        { method: 'POST', body: eventBody },
      );

      const isAllDay = Boolean(plan.isAllDay);
      const dateStr = formatCreatedEventDate(created, isAllDay);
      const title = created.summary ?? plan.summary;
      const agendaLabel = env.GOOGLE_CALENDAR_DEFAULT_CREATE_CALENDAR_LABEL?.trim() || 'ton agenda';
      return `C'est ajoute dans ${agendaLabel} : ${title}, ${dateStr}${isAllDay ? ', toute la journee' : ''}.`;
    }

    default:
      return 'Action calendrier non reconnue.';
  }
}

export async function executeCalendarAgentAction(
  plan: CalendarAction,
  env: CalendarAgentEnv,
): Promise<string> {
  return executeCalendarAction(plan, env);
}

// ─── Public entry point ───────────────────────────────────────────────────────

/**
 * Main entry point called from ingest.ts.
 * Plans the user request then executes it directly against Google Calendar API,
 * bypassing Home Assistant entirely.
 */
export async function callCalendarAgent(
  text: string,
  env: CalendarAgentEnv,
  log: MinLogger,
  options: { mode?: CalendarAgentMode } = {},
): Promise<string> {
  const configState = await getGoogleCalendarConfigState(env);
  if (configState === 'missing_client') {
    return 'Le calendrier Google n\'est pas configuré. Connecte Google via OAuth ou ajoute les identifiants Google côté serveur.';
  }
  if (configState === 'missing_refresh_token') return 'Connecte Google via OAuth pour activer le calendrier.';

  if (!env.OPENAI_API_KEY?.trim()) {
    throw new Error('calendar_agent_openai_key_missing');
  }

  const plan = await planCalendarAgentAction(text, env);

  log.info({ action: plan.action }, 'calendar_agent_plan');

  if (options.mode === 'propose' && plan.action === 'create_event') {
    return formatCalendarProposal(plan);
  }

  return executeCalendarAction(plan, env);
}

// ─── Also export resolve helpers for dashboard use ────────────────────────────
export { resolveEventEnd, resolveEventStart };
