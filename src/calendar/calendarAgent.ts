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

import {
  calendarApiRequest,
  fetchUpcomingEventsMultiCalendar,
  formatEventDate,
  type GoogleCalendarEvent,
  hasCalendarConfig,
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
  GOOGLE_CALENDAR_CALENDAR_IDS?: string;
  GOOGLE_CALENDAR_DEFAULT_CREATE_CALENDAR_ID?: string;
  OPENAI_API_KEY?: string;
  OPENAI_BASE_URL: string;
  OPENAI_TIMEOUT_MS: number;
}

// ─── Planner types ────────────────────────────────────────────────────────────

type CalendarAction =
  | { action: 'list_upcoming'; calendarId?: string; timeMin: string; timeMax: string; summary?: string }
  | { action: 'search_events'; q: string; calendarId?: string; timeMin?: string; timeMax?: string; maxResults?: number; summary?: string }
  | { action: 'create_event'; summary: string; start: string; end: string; isAllDay?: boolean; description?: string; location?: string; calendarId?: string };

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
  openAiApiKey: string,
  openAiBaseUrl: string,
  timeoutMs: number,
): Promise<CalendarAction> {
  const now = new Date();
  const tz = 'Europe/Paris';
  const dateStr = now.toLocaleString('fr-FR', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
    hour: '2-digit', minute: '2-digit', timeZone: tz,
  });
  const isoDate = now.toISOString().slice(0, 10);

  const resp = await fetch(`${openAiBaseUrl.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${openAiApiKey}`,
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
    signal: AbortSignal.timeout(timeoutMs),
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

  return parsed as CalendarAction;
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
  if (!hasCalendarConfig(env)) {
    return 'Le calendrier Google n\'est pas configuré sur ce serveur.';
  }

  switch (plan.action) {
    case 'list_upcoming': {
      const calendarIds = plan.calendarId
        ? [plan.calendarId]
        : parseCalendarIds(env.GOOGLE_CALENDAR_CALENDAR_IDS);

      const events = await fetchUpcomingEventsMultiCalendar(
        env,
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
      const token = await refreshCalendarToken(env);
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
      const token = await refreshCalendarToken(env);
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
      return `C'est ajoute dans l'agenda Famille Bourguignon : ${title}, ${dateStr}${isAllDay ? ', toute la journee' : ''}.`;
    }

    default:
      return 'Action calendrier non reconnue.';
  }
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
): Promise<string> {
  if (!hasCalendarConfig(env)) {
    return 'Le calendrier Google n\'est pas configuré. Ajoute GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET et GOOGLE_REFRESH_TOKEN dans l\'environnement.';
  }

  if (!env.OPENAI_API_KEY?.trim()) {
    throw new Error('calendar_agent_openai_key_missing');
  }

  const plan = await planCalendarAction(
    text,
    env.OPENAI_API_KEY,
    env.OPENAI_BASE_URL,
    env.OPENAI_TIMEOUT_MS,
  );

  log.info({ action: plan.action }, 'calendar_agent_plan');

  return executeCalendarAction(plan, env);
}

// ─── Also export resolve helpers for dashboard use ────────────────────────────
export { resolveEventEnd, resolveEventStart };
