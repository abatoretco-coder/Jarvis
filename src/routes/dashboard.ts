import type { FastifyInstance } from 'fastify';

import {
  fetchUpcomingEventsMultiCalendarDetailed,
  hasCalendarConfig,
  parseCalendarIds,
  resolveEventEnd,
  resolveEventStart,
} from '../calendar/googleCalendarClient';
import { resolveGoogleCredentials } from '../google/googleCredentialService';
import { buildMailAccounts, type MailAccount } from '../mail/mailAgent';
import { cleanMailDetailText } from '../mail/mailContentCleaner';
import type { AppDeps } from '../server';

type HaState = {
  entity_id: string;
  state: string;
  attributes?: Record<string, unknown>;
};

type DashboardSection = {
  title: string;
  summary: string;
  lines: string[];
  source: string;
  status: 'ok' | 'empty' | 'partial' | 'error';
  items?: TodoTaskItem[] | DashboardMailItem[] | AgendaEventItem[];
};

type AgendaEventItem = {
  id: string;
  title: string;
  details?: string;
  start: string;
  end: string;
  isAllDay: boolean;
  durationDays: number;
};

type DashboardTask = {
  id: string;
  title: string;
  status?: 'notStarted' | 'inProgress' | 'completed' | 'waitingOnOthers' | 'deferred';
  importance?: 'low' | 'normal' | 'high';
  dueDateTime?: { dateTime: string; timeZone: string } | null;
  createdDateTime?: string;
  recurrence?: { pattern?: Record<string, unknown>; range?: Record<string, unknown> } | null;
  listId: string;
  listName: string;
};

type TodoTaskItem = {
  id: string;
  title: string;
  listId: string;
  listName: string;
  status: 'notStarted' | 'inProgress' | 'completed' | 'waitingOnOthers' | 'deferred';
  importance: 'low' | 'normal' | 'high';
  dueDateTime?: { dateTime: string; timeZone: string } | null;
  createdDateTime?: string;
  recurrence?: { pattern?: Record<string, unknown>; range?: Record<string, unknown> } | null;
};

type DashboardMailItem = {
  id: string;
  accountLabel: string;
  from: string;
  subject: string;
  receivedAt: number;
  snippet?: string;
};

type MicrosoftAccessTokenEnv = {
  MICROSOFT_TENANT_ID?: string;
  MICROSOFT_CLIENT_ID?: string;
  MICROSOFT_CLIENT_SECRET?: string;
  MICROSOFT_REFRESH_TOKEN?: string;
};

type MsTaskList = {
  id: string;
  displayName: string;
};

type GraphTodoTasksPage = {
  value?: Array<Omit<DashboardTask, 'listName' | 'listId'>>;
  '@odata.nextLink'?: string;
};

type TodoListItem = {
  id: string;
  displayName: string;
};

type GmailMessageRef = {
  id: string;
};

type GmailListPayload = {
  messages?: GmailMessageRef[];
  nextPageToken?: string;
};

type GmailDashboardMessage = {
  id: string;
  internalDate?: string;
  snippet?: string;
  payload?: {
    headers?: Array<{ name: string; value: string }>;
  };
};

type GmailMessageBodyPart = {
  mimeType?: string;
  body?: { data?: string };
  parts?: GmailMessageBodyPart[];
};

type GmailFullMessage = {
  id: string;
  snippet?: string;
  payload?: GmailMessageBodyPart;
};

const MS_GRAPH_BASE = 'https://graph.microsoft.com/v1.0';
const GMAIL_BASE = 'https://gmail.googleapis.com/gmail/v1/users/me';

const LOCAL_LINKS = [
  {
    label: 'assistant',
    title: 'Assistant',
    description: 'Revenir a la conversation Jarvis.',
    kind: 'tab',
    value: 'chat',
  },
  {
    label: 'home-assistant',
    title: 'Home Assistant',
    description: 'Pilotage et etats de la maison.',
    kind: 'url',
    value: 'http://192.168.1.38:8123',
  },
  {
    label: 'threads',
    title: 'Historique',
    description: 'Voir les fils et syntheses recentes.',
    kind: 'tab',
    value: 'threads',
  },
  {
    label: 'settings',
    title: 'Parametres',
    description: 'Reglages desktop et audio.',
    kind: 'tab',
    value: 'settings',
  },
] as const;

function mapWeatherConditionToWmo(condition: string): number {
  switch (condition.trim().toLowerCase()) {
    case 'sunny':
    case 'clear':
    case 'clear-night':
      return 0;
    case 'partlycloudy':
    case 'partly-cloudy':
      return 2;
    case 'cloudy':
    case 'overcast':
      return 3;
    case 'fog':
      return 45;
    case 'hail':
      return 82;
    case 'lightning':
    case 'lightning-rainy':
      return 95;
    case 'pouring':
      return 82;
    case 'rainy':
      return 61;
    case 'snowy':
      return 71;
    case 'snowy-rainy':
      return 85;
    case 'windy':
    case 'windy-variant':
      return 48;
    default:
      return 3;
  }
}

function asNumber(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function asStateNumber(state: HaState | undefined, fallback = 0): number {
  if (!state) return fallback;
  const parsed = Number(state.state);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function splitSummary(summary: string): string[] {
  const normalized = summary
    .replace(/\s+/g, ' ')
    .replace(/\s+\|\s+/g, '|')
    .trim();

  if (!normalized) return [];

  const rawParts = normalized.includes('|')
    ? normalized.split('|')
    : normalized.split(/(?<=[.!?])\s+/);

  return rawParts
    .map((part) => part.replace(/^\[[^\]]+\]\s*/, '').trim())
    .filter(Boolean)
    .slice(0, 5);
}

function classifySummary(summary: string): DashboardSection['status'] {
  const lower = summary.toLowerCase();
  if (!summary.trim()) return 'empty';
  if (lower.includes('non disponible') || lower.includes('impossible') || lower.includes('manquants')) return 'error';
  if (lower.includes('aucun') || lower.includes('pas de')) return 'empty';
  return 'ok';
}

function makeSection(title: string, source: string, summary: string): DashboardSection {
  return {
    title,
    source,
    summary,
    lines: splitSummary(summary),
    status: classifySummary(summary),
  };
}

function _formatDateTime(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString('fr-FR', {
    weekday: 'short',
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatDateForLine(date: Date): string {
  return date.toLocaleString('fr-FR', {
    weekday: 'short',
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function parseDate(value: unknown): Date | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const date = new Date(value);
  if (!Number.isNaN(date.getTime())) return date;

  // Handle Graph datetime variants by falling back to date-only parsing.
  const head = value.slice(0, 10);
  if (/^\d{4}-\d{2}-\d{2}$/.test(head)) {
    const normalized = new Date(`${head}T00:00:00`);
    if (!Number.isNaN(normalized.getTime())) return normalized;
  }

  return null;
}

function addDays(base: Date, days: number): Date {
  return new Date(base.getTime() + days * 86_400_000);
}

function startOfToday(base: Date): Date {
  const date = new Date(base);
  date.setHours(0, 0, 0, 0);
  return date;
}

/**
 * Build the agenda section by reading events directly from Google Calendar API.
 */
export async function buildAgendaFromGoogle(
  env: AppDeps['env'],
  now = new Date(),
): Promise<DashboardSection> {
  if (!hasCalendarConfig(env)) {
    return {
      ...makeSection('Agenda', 'google-calendar', 'Google Calendar n est pas configure sur ce serveur.'),
      status: 'error',
    };
  }

  const windowStart = startOfToday(now);
  const windowEnd = addDays(windowStart, 7);
  const calendarIds = parseCalendarIds(env.GOOGLE_CALENDAR_CALENDAR_IDS);

  const result = await fetchUpcomingEventsMultiCalendarDetailed(
    env,
    calendarIds,
    windowStart.toISOString(),
    windowEnd.toISOString(),
    50,
  );

  const events = result.events;
  const active = events.filter((ev) => ev.status !== 'cancelled');
  const failedCount = result.failedCalendarIds.length;

  if (failedCount === calendarIds.length && active.length === 0) {
    return {
      ...makeSection('Agenda', 'google-calendar', 'Je n ai pas pu lire Google Calendar pour le moment.'),
      status: 'error',
    };
  }

  if (active.length === 0) {
    return {
      ...makeSection('Agenda', 'google-calendar', failedCount > 0
        ? `Aucun evenement trouve sur les agendas disponibles, mais ${failedCount} calendrier${failedCount > 1 ? 's' : ''} n ont pas repondu.`
        : 'Rien a signaler dans l agenda pour les 7 prochains jours.'),
      status: failedCount > 0 ? 'partial' : 'empty',
    };
  }

  const limited = active.slice(0, 6);

  const lines = limited.map((ev) => {
    const start = resolveEventStart(ev);
    const title = ev.summary?.trim() || '(sans titre)';
    return `${formatDateForLine(start)} | ${title}`;
  });

  const items: AgendaEventItem[] = limited.map((ev, idx) => {
    const isAllDay = !ev.start?.dateTime;
    const start = resolveEventStart(ev);
    const end = resolveEventEnd(ev);
    const startDay = startOfToday(start);
    const endDay = startOfToday(end);
    const durationDays = Math.ceil((endDay.getTime() - startDay.getTime()) / 86_400_000) || 1;
    return {
      id: ev.id || `gcal-event-${idx}`,
      title: ev.summary?.trim() || '(sans titre)',
      details: ev.description?.trim() || undefined,
      start: start.toISOString(),
      end: end.toISOString(),
      isAllDay,
      durationDays,
    };
  });

  return {
    title: 'Agenda',
    source: 'google-calendar',
    summary: `${limited.length} evenement${limited.length > 1 ? 's' : ''} prevu${limited.length > 1 ? 's' : ''} cette semaine${failedCount > 0 ? `, avec ${failedCount} calendrier${failedCount > 1 ? 's' : ''} indisponible${failedCount > 1 ? 's' : ''}` : ''}.`,
    lines,
    status: failedCount > 0 ? 'partial' : 'ok',
    items,
  };
}

async function refreshMicrosoftAccessToken(env: MicrosoftAccessTokenEnv, scope: string): Promise<string> {
  if (!env.MICROSOFT_CLIENT_ID || !env.MICROSOFT_CLIENT_SECRET || !env.MICROSOFT_REFRESH_TOKEN) {
    throw new Error('microsoft_credentials_missing');
  }

  const tenantId = env.MICROSOFT_TENANT_ID?.trim() || 'common';
  const response = await fetch(`https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.MICROSOFT_CLIENT_ID,
      client_secret: env.MICROSOFT_CLIENT_SECRET,
      refresh_token: env.MICROSOFT_REFRESH_TOKEN,
      grant_type: 'refresh_token',
      scope,
    }),
    signal: AbortSignal.timeout(8_000),
  });

  if (!response.ok) {
    const rawBody = await response.text().catch(() => '');
    throw new Error(`microsoft_token_refresh_failed:${response.status}:${rawBody.slice(0, 200)}`);
  }

  const payload = await response.json() as { access_token?: string };
  if (!payload.access_token) {
    throw new Error('microsoft_token_refresh_no_token');
  }

  return payload.access_token;
}

async function refreshGoogleAccessToken(account: MailAccount, env: AppDeps['env']): Promise<string> {
  const credentials = await resolveGoogleCredentials({
    GOOGLE_CLIENT_ID: account.clientId,
    GOOGLE_CLIENT_SECRET: account.clientSecret,
    GOOGLE_REFRESH_TOKEN: account.refreshToken,
    OAUTH_REFRESH_TOKEN_STORE_PATH: env.OAUTH_REFRESH_TOKEN_STORE_PATH,
  });
  if (!credentials) {
    throw new Error('google_credentials_missing');
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
    const rawBody = await response.text().catch(() => '');
    throw new Error(`google_token_refresh_failed:${response.status}:${rawBody.slice(0, 200)}`);
  }

  const payload = await response.json() as { access_token?: string };
  if (!payload.access_token) {
    throw new Error('google_token_refresh_no_token');
  }

  return payload.access_token;
}

async function graphGet<T>(path: string, token: string): Promise<T> {
  const response = await fetch(`${MS_GRAPH_BASE}${path}`, {
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/json',
    },
    signal: AbortSignal.timeout(8_000),
  });

  if (!response.ok) {
    const rawBody = await response.text().catch(() => '');
    throw new Error(`graph_get_failed:${response.status}:${rawBody.slice(0, 200)}`);
  }

  return response.json() as Promise<T>;
}

async function graphGetAbsolute<T>(url: string, token: string): Promise<T> {
  const response = await fetch(url, {
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/json',
    },
    signal: AbortSignal.timeout(8_000),
  });

  if (!response.ok) {
    const rawBody = await response.text().catch(() => '');
    throw new Error(`graph_get_failed:${response.status}:${rawBody.slice(0, 200)}`);
  }

  return response.json() as Promise<T>;
}

async function graphPost<T>(path: string, token: string, body: Record<string, unknown>): Promise<T> {
  const response = await fetch(`${MS_GRAPH_BASE}${path}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/json',
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(8_000),
  });

  if (!response.ok) {
    const rawBody = await response.text().catch(() => '');
    throw new Error(`graph_post_failed:${response.status}:${rawBody.slice(0, 200)}`);
  }

  return response.json() as Promise<T>;
}

async function graphPatch(path: string, token: string, body: Record<string, unknown>): Promise<void> {
  const response = await fetch(`${MS_GRAPH_BASE}${path}`, {
    method: 'PATCH',
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/json',
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(8_000),
  });

  if (!response.ok) {
    const rawBody = await response.text().catch(() => '');
    throw new Error(`graph_patch_failed:${response.status}:${rawBody.slice(0, 200)}`);
  }
}

async function fetchMicrosoftTodoLists(env: AppDeps['env']): Promise<{ token: string; lists: MsTaskList[] }> {
  if (!env.MICROSOFT_CLIENT_ID || !env.MICROSOFT_CLIENT_SECRET || !env.MICROSOFT_REFRESH_TOKEN) {
    throw new Error('microsoft_todo_not_configured');
  }

  const token = await refreshMicrosoftAccessToken(env, 'Tasks.ReadWrite offline_access');
  const listsPayload = await graphGet<{ value?: MsTaskList[] }>('/me/todo/lists?$top=50', token);
  return { token, lists: listsPayload.value ?? [] };
}

function mapTodoListItem(list: MsTaskList): TodoListItem {
  return {
    id: list.id,
    displayName: list.displayName,
  };
}

function toGraphDateTimeFromDateOnly(dateOnly: string): { dateTime: string; timeZone: string } | undefined {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateOnly)) return undefined;
  const [year, month, day] = dateOnly.split('-').map((value) => Number(value));
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) return undefined;
  if (month < 1 || month > 12 || day < 1 || day > 31) return undefined;
  return {
    // Graph accepts date-time paired with timezone. Keep UTC explicit for stability.
    dateTime: `${dateOnly}T09:00:00.0000000`,
    timeZone: 'UTC',
  };
}

function mapTodoTaskItem(task: DashboardTask): TodoTaskItem {
  return {
    id: task.id,
    title: task.title,
    listId: task.listId,
    listName: task.listName,
    status: task.status ?? 'notStarted',
    importance: task.importance ?? 'normal',
    dueDateTime: task.dueDateTime,
    createdDateTime: task.createdDateTime,
    recurrence: task.recurrence,
  };
}

async function fetchMicrosoftTodoTasks(env: AppDeps['env']): Promise<TodoTaskItem[]> {
  const { token, lists } = await fetchMicrosoftTodoLists(env);
  if (lists.length === 0) return [];

  const taskResults = await Promise.allSettled(
    lists.map(async (list) => {
      const collected: DashboardTask[] = [];
      let nextLink: string | null = `/me/todo/lists/${list.id}/tasks?$orderby=createdDateTime desc&$top=200`;

      // Pull multiple pages so old recurring tasks are not dropped by the first page.
      for (let page = 0; page < 10 && nextLink; page += 1) {
        const payload: GraphTodoTasksPage = nextLink.startsWith('https://')
          ? await graphGetAbsolute<GraphTodoTasksPage>(nextLink, token)
          : await graphGet<GraphTodoTasksPage>(nextLink, token);

        collected.push(...(payload.value ?? []) as DashboardTask[]);
        const candidate: string | undefined = payload['@odata.nextLink'];
        nextLink = typeof candidate === 'string' && candidate.trim() ? candidate : null;
      }

      return collected.map((task) => ({
        ...task,
        listId: list.id,
        listName: list.displayName,
      }));
    }),
  );

  return taskResults
    .filter((result): result is PromiseFulfilledResult<DashboardTask[]> => result.status === 'fulfilled')
    .flatMap((result) => result.value)
    .filter((task) => task.title?.trim())
    .map(mapTodoTaskItem);
}

async function gmailGet<T>(path: string, token: string): Promise<T> {
  const response = await fetch(`${GMAIL_BASE}${path}`, {
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/json',
    },
    signal: AbortSignal.timeout(8_000),
  });

  if (!response.ok) {
    const rawBody = await response.text().catch(() => '');
    throw new Error(`gmail_get_failed:${response.status}:${rawBody.slice(0, 200)}`);
  }

  return response.json() as Promise<T>;
}

async function gmailPost<T>(path: string, token: string, body: Record<string, unknown>): Promise<T> {
  const response = await fetch(`${GMAIL_BASE}${path}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/json',
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(8_000),
  });

  if (!response.ok) {
    const rawBody = await response.text().catch(() => '');
    throw new Error(`gmail_post_failed:${response.status}:${rawBody.slice(0, 200)}`);
  }

  const text = await response.text().catch(() => '');
  if (!text.trim()) return {} as T;
  return JSON.parse(text) as T;
}

function decodeMimeHeader(value: string): string {
  if (!value.includes('=?')) return value;

  return value.replace(/=\?([^?]+)\?([bqBQ])\?([^?]+)\?=/g, (_match, charsetRaw: string, encodingRaw: string, textRaw: string) => {
    try {
      const charset = charsetRaw.trim().toLowerCase();
      const encoding = encodingRaw.toUpperCase();
      const nodeEncoding: BufferEncoding = charset.includes('8859-1') || charset.includes('latin1')
        ? 'latin1'
        : 'utf8';

      if (encoding === 'B') {
        const bytes = Buffer.from(textRaw, 'base64');
        return bytes.toString(nodeEncoding);
      }

      const qp = textRaw
        .replace(/_/g, ' ')
        .replace(/=([0-9A-Fa-f]{2})/g, (_hexMatch, hex: string) => String.fromCharCode(parseInt(hex, 16)));

      return Buffer.from(qp, 'binary').toString(nodeEncoding);
    } catch {
      return textRaw;
    }
  });
}

function isTaskOverdue(task: DashboardTask, now: Date): boolean {
  const dueDate = parseDate(task.dueDateTime?.dateTime);
  if (!dueDate) return false;
  const todayStart = startOfToday(now);
  return dueDate.getTime() < todayStart.getTime();
}

function isTaskDueToday(task: DashboardTask, now: Date): boolean {
  const dueDate = parseDate(task.dueDateTime?.dateTime);
  if (!dueDate) return false;
  const todayStart = startOfToday(now);
  const tomorrowStart = addDays(todayStart, 1);
  return dueDate.getTime() >= todayStart.getTime() && dueDate.getTime() < tomorrowStart.getTime();
}

function isTaskDueThisWeek(task: DashboardTask, now: Date): boolean {
  const dueDate = parseDate(task.dueDateTime?.dateTime);
  if (!dueDate) return false;
  const todayStart = startOfToday(now);
  const tomorrowStart = addDays(todayStart, 1);
  const weekLimit = addDays(todayStart, 7);
  return dueDate.getTime() >= tomorrowStart.getTime() && dueDate.getTime() < weekLimit.getTime();
}

function isRecentlyCreatedWithoutDueDate(task: DashboardTask, now: Date): boolean {
  if (task.dueDateTime?.dateTime) return false;
  const createdDate = parseDate(task.createdDateTime);
  if (!createdDate) return false;
  return createdDate.getTime() >= addDays(now, -7).getTime();
}

function taskPriorityBucket(task: DashboardTask, now: Date): number {
  if (isTaskOverdue(task, now)) return 0;
  if (isTaskDueToday(task, now)) return 1;
  if (isTaskDueThisWeek(task, now)) return 2;
  if (isRecentlyCreatedWithoutDueDate(task, now)) return 3;
  if (task.dueDateTime?.dateTime) return 4;
  return 5;
}

function importanceRank(value: DashboardTask['importance']): number {
  if (value === 'high') return 0;
  if (value === 'normal') return 1;
  return 2;
}

function compareDashboardTasks(left: DashboardTask, right: DashboardTask, now: Date): number {
  const leftBucket = taskPriorityBucket(left, now);
  const rightBucket = taskPriorityBucket(right, now);
  if (leftBucket !== rightBucket) return leftBucket - rightBucket;

  const leftDue = parseDate(left.dueDateTime?.dateTime)?.getTime() ?? Number.MAX_SAFE_INTEGER;
  const rightDue = parseDate(right.dueDateTime?.dateTime)?.getTime() ?? Number.MAX_SAFE_INTEGER;
  if (leftDue !== rightDue) return leftDue - rightDue;

  const leftImportance = importanceRank(left.importance);
  const rightImportance = importanceRank(right.importance);
  if (leftImportance !== rightImportance) return leftImportance - rightImportance;

  const leftCreated = parseDate(left.createdDateTime)?.getTime() ?? 0;
  const rightCreated = parseDate(right.createdDateTime)?.getTime() ?? 0;
  if (leftCreated !== rightCreated) return rightCreated - leftCreated;

  return left.title.localeCompare(right.title, 'fr', { sensitivity: 'base' });
}

function formatTaskLine(label: string, task: DashboardTask): string {
  const dueDate = parseDate(task.dueDateTime?.dateTime);
  const createdDate = parseDate(task.createdDateTime);
  const urgency = task.importance === 'high' ? ' | Urgente' : '';

  const formatTaskDateOnly = (date: Date): string => date.toLocaleDateString('fr-FR', {
    weekday: 'short',
    day: '2-digit',
    month: '2-digit',
  });

  const datePart = dueDate
    ? ` | Echeance ${formatTaskDateOnly(dueDate)}`
    : createdDate
      ? ` | Creee ${formatTaskDateOnly(createdDate)}`
      : '';
  return `${label}: ${task.title} (${task.listName})${datePart}${urgency}`;
}

async function buildTasksSection(env: AppDeps['env']): Promise<DashboardSection> {
  if (!env.MICROSOFT_CLIENT_ID || !env.MICROSOFT_CLIENT_SECRET || !env.MICROSOFT_REFRESH_TOKEN) {
    return makeSection('Taches', 'jarvis-todo', 'La gestion des taches n est pas configuree (identifiants Microsoft manquants).');
  }

  const tasks = (await fetchMicrosoftTodoTasks(env)).filter((task) => task.status !== 'completed');
  if (tasks.length === 0) {
    const { lists } = await fetchMicrosoftTodoLists(env);
    if (lists.length === 0) {
      return makeSection('Taches', 'jarvis-todo', 'Aucune liste de taches disponible dans Microsoft To Do.');
    }
    return makeSection('Taches', 'jarvis-todo', 'Aucune tache active dans Microsoft To Do.');
  }

  const now = new Date();
  const sortedTasks = tasks.slice().sort((left, right) => compareDashboardTasks(left, right, now));

  const overdueTasks = sortedTasks
    .filter((task) => isTaskOverdue(task, now))
    .sort((left, right) => {
      const leftDue = parseDate(left.dueDateTime?.dateTime)?.getTime() ?? Number.MAX_SAFE_INTEGER;
      const rightDue = parseDate(right.dueDateTime?.dateTime)?.getTime() ?? Number.MAX_SAFE_INTEGER;
      return leftDue - rightDue;
    });
  const upcomingTasks = sortedTasks
    .filter((task) => isTaskDueThisWeek(task, now))
    .sort((left, right) => {
      const leftDue = parseDate(left.dueDateTime?.dateTime)?.getTime() ?? Number.MAX_SAFE_INTEGER;
      const rightDue = parseDate(right.dueDateTime?.dateTime)?.getTime() ?? Number.MAX_SAFE_INTEGER;
      return leftDue - rightDue;
    });
  const todayTasks = sortedTasks
    .filter((task) => isTaskDueToday(task, now))
    .sort((left, right) => {
      const leftDue = parseDate(left.dueDateTime?.dateTime)?.getTime() ?? Number.MAX_SAFE_INTEGER;
      const rightDue = parseDate(right.dueDateTime?.dateTime)?.getTime() ?? Number.MAX_SAFE_INTEGER;
      return leftDue - rightDue;
    });

  const recentUndatedTasks = sortedTasks
    .filter((task) => isRecentlyCreatedWithoutDueDate(task, now))
    .sort((left, right) => {
      const leftCreated = parseDate(left.createdDateTime)?.getTime() ?? 0;
      const rightCreated = parseDate(right.createdDateTime)?.getTime() ?? 0;
      return rightCreated - leftCreated;
    });

  const relevantTasks = [
    ...overdueTasks.map((task) => formatTaskLine('En retard', task)),
    ...todayTasks.map((task) => formatTaskLine('Aujourd hui', task)),
    ...upcomingTasks.map((task) => formatTaskLine('Cette semaine', task)),
    ...recentUndatedTasks.map((task) => formatTaskLine('Recente sans date', task)),
  ].slice(0, 8);

  if (relevantTasks.length === 0) {
    if (tasks.length === 0) {
      return makeSection('Taches', 'jarvis-todo', 'Aucune tache active dans Microsoft To Do.');
    }

    const activePreview = sortedTasks
      .slice()
      .sort((left, right) => {
        const leftDue = parseDate(left.dueDateTime?.dateTime)?.getTime() ?? Number.MAX_SAFE_INTEGER;
        const rightDue = parseDate(right.dueDateTime?.dateTime)?.getTime() ?? Number.MAX_SAFE_INTEGER;
        if (leftDue !== rightDue) return leftDue - rightDue;
        const leftCreated = parseDate(left.createdDateTime)?.getTime() ?? 0;
        const rightCreated = parseDate(right.createdDateTime)?.getTime() ?? 0;
        return rightCreated - leftCreated;
      })
      .slice(0, 8)
      .map((task) => formatTaskLine('Active', task));

    return {
      title: 'Taches',
      source: 'jarvis-todo',
      summary: `${tasks.length} tache${tasks.length > 1 ? 's' : ''} active${tasks.length > 1 ? 's' : ''}. Aucune priorite urgente cette semaine.`,
      lines: activePreview,
      status: 'ok',
      items: sortedTasks,
    };
  }

  const summaryParts = [
    overdueTasks.length > 0 ? `${overdueTasks.length} en retard` : '',
    todayTasks.length > 0 ? `${todayTasks.length} aujourd hui` : '',
    upcomingTasks.length > 0 ? `${upcomingTasks.length} a echeance cette semaine` : '',
    recentUndatedTasks.length > 0 ? `${recentUndatedTasks.length} recente${recentUndatedTasks.length > 1 ? 's' : ''} sans date` : '',
  ].filter(Boolean);

  return {
    title: 'Taches',
    source: 'jarvis-todo',
    summary: `Priorites taches: ${summaryParts.join(', ')}.`,
    lines: relevantTasks,
    status: 'ok',
    items: sortedTasks,
  };
}

function gmailHeader(message: GmailDashboardMessage, headerName: string): string {
  const raw = message.payload?.headers?.find((header) => header.name.toLowerCase() === headerName.toLowerCase())?.value ?? '';
  return decodeMimeHeader(raw);
}

function decodeBase64UrlUtf8(value: string): string {
  if (!value) return '';
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
  return Buffer.from(padded, 'base64').toString('utf8');
}

function htmlToText(html: string): string {
  if (!html) return '';
  return html
    .replace(/<\s*br\s*\/?>/gi, '\n')
    .replace(/<\s*\/p\s*>/gi, '\n\n')
    .replace(/<\s*p[^>]*>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\r\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function collectMessageBodies(part: GmailMessageBodyPart | undefined): { plain: string[]; html: string[] } {
  if (!part) return { plain: [], html: [] };
  const plain: string[] = [];
  const html: string[] = [];

  const walk = (node: GmailMessageBodyPart): void => {
    const mime = String(node.mimeType ?? '').toLowerCase();
    const data = node.body?.data;
    if (typeof data === 'string' && data.trim()) {
      if (mime === 'text/plain') {
        const decoded = decodeBase64UrlUtf8(data).trim();
        if (decoded) plain.push(decoded);
      } else if (mime === 'text/html') {
        const decoded = decodeBase64UrlUtf8(data).trim();
        if (decoded) html.push(decoded);
      }
    }

    if (Array.isArray(node.parts)) {
      node.parts.forEach((child) => walk(child));
    }
  };

  walk(part);
  return { plain, html };
}

async function fetchMailMessageText(account: MailAccount, env: AppDeps['env'], messageId: string): Promise<{ text: string; snippet?: string }> {
  const token = await refreshGoogleAccessToken(account, env);
  const full = await gmailGet<GmailFullMessage>(`/messages/${encodeURIComponent(messageId)}?format=full`, token);
  const bodies = collectMessageBodies(full.payload);
  const plainText = cleanMailDetailText(bodies.plain.join('\n\n').trim());
  if (plainText) {
    return { text: plainText, snippet: full.snippet?.trim() || undefined };
  }

  const htmlText = cleanMailDetailText(htmlToText(bodies.html.join('\n\n')));
  if (htmlText) {
    return { text: htmlText, snippet: full.snippet?.trim() || undefined };
  }

  return { text: full.snippet?.trim() || '', snippet: full.snippet?.trim() || undefined };
}

async function fetchMailMessageTextFromAnyAccount(
  accounts: MailAccount[],
  preferredAccount: MailAccount | null,
  env: AppDeps['env'],
  messageId: string,
): Promise<{ account: MailAccount; payload: { text: string; snippet?: string } }> {
  if (accounts.length === 0) {
    throw new Error('mail_not_configured');
  }

  const orderedAccounts = preferredAccount
    ? [preferredAccount, ...accounts.filter((account) => account !== preferredAccount)]
    : [...accounts];

  let lastError: unknown = null;
  for (const account of orderedAccounts) {
    try {
      const payload = await fetchMailMessageText(account, env, messageId);
      return { account, payload };
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError instanceof Error ? lastError : new Error('mail_message_failed');
}

async function fetchMailItemsForAccount(account: MailAccount, env: AppDeps['env']): Promise<DashboardMailItem[]> {
  const payload = await fetchMailItemsPageForAccount(account, env, 0, 40);
  return payload.items;
}

async function fetchMailItemsPageForAccount(
  account: MailAccount,
  env: AppDeps['env'],
  page: number,
  pageSize: number,
): Promise<{ items: DashboardMailItem[]; hasMore: boolean }> {
  const token = await refreshGoogleAccessToken(account, env);
  const safePage = Math.max(0, Math.floor(page));
  const safePageSize = Math.max(1, Math.min(100, Math.floor(pageSize)));

  let pageToken = '';
  let listPayload: GmailListPayload = { messages: [] };
  for (let idx = 0; idx <= safePage; idx += 1) {
    const params = new URLSearchParams({
      q: 'in:inbox',
      maxResults: String(safePageSize),
    });
    if (pageToken) params.set('pageToken', pageToken);
    listPayload = await gmailGet<GmailListPayload>(`/messages?${params.toString()}`, token);
    pageToken = listPayload.nextPageToken ?? '';
    if (!pageToken && idx < safePage) {
      return { items: [], hasMore: false };
    }
  }

  const messages = listPayload.messages ?? [];
  if (messages.length === 0) return { items: [], hasMore: false };

  const detailedPayloads = await Promise.allSettled(
    messages.map((message) =>
      gmailGet<GmailDashboardMessage>(
        `/messages/${message.id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`,
        token,
      ),
    ),
  );

  const items = detailedPayloads
    .filter((result): result is PromiseFulfilledResult<GmailDashboardMessage> => result.status === 'fulfilled')
    .map((result) => {
      const from = gmailHeader(result.value, 'From').replace(/<[^>]+>/g, '').trim() || 'Inconnu';
      const subject = gmailHeader(result.value, 'Subject') || '(sans objet)';
      const internalDate = Number(result.value.internalDate ?? '0');
      const headerDate = Date.parse(gmailHeader(result.value, 'Date'));
      return {
        id: result.value.id,
        accountLabel: account.label,
        from,
        subject,
        receivedAt: Number.isFinite(internalDate) && internalDate > 0 ? internalDate : (Number.isFinite(headerDate) ? headerDate : 0),
        snippet: result.value.snippet?.trim() || undefined,
      };
    });

  return {
    items,
    hasMore: Boolean(listPayload.nextPageToken),
  };
}

async function buildMailSection(env: AppDeps['env'], log: FastifyInstance['log']): Promise<DashboardSection> {
  const accounts = buildMailAccounts(env);
  if (accounts.length === 0) {
    return makeSection('Mail', 'jarvis-mail', 'La gestion des emails n est pas configuree (identifiants Gmail ou Outlook manquants).');
  }

  const results = await Promise.allSettled(accounts.map((account) => fetchMailItemsForAccount(account, env)));
  const availableItems = results
    .filter((result): result is PromiseFulfilledResult<DashboardMailItem[]> => result.status === 'fulfilled')
    .flatMap((result) => result.value)
    .sort((left, right) => right.receivedAt - left.receivedAt);

  const failures = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
  if (failures.length > 0) {
    log.warn(
      {
        failures: failures.map((failure) => failure.reason instanceof Error ? failure.reason.message : String(failure.reason)),
      },
      'dashboard_mail_accounts_partial_failure',
    );
  }

  if (availableItems.length === 0) {
    if (failures.length === results.length) {
      return makeSection('Mail', 'jarvis-mail', 'Impossible de recuperer les boites mail connectees pour le moment.');
    }
    return makeSection('Mail', 'jarvis-mail', 'Aucun email recent dans les boites de reception connectees.');
  }

  const lines = availableItems.slice(0, 8).map((item) => {
    const receivedAt = item.receivedAt > 0 ? formatDateForLine(new Date(item.receivedAt)) : 'date inconnue';
    return `[${item.accountLabel}] ${receivedAt} — ${item.from} — ${item.subject}`;
  });

  const summary = `${availableItems.length} email${availableItems.length > 1 ? 's' : ''} concatene${availableItems.length > 1 ? 's' : ''} depuis ${accounts.length} boite${accounts.length > 1 ? 's' : ''} connectee${accounts.length > 1 ? 's' : ''}${failures.length > 0 ? `, ${failures.length} indisponible${failures.length > 1 ? 's' : ''}` : ''}.`;
  return {
    title: 'Mail',
    source: 'jarvis-mail',
    summary,
    lines,
    status: 'ok',
    items: availableItems,
  };
}

function buildWeatherPayload(states: HaState[]): Record<string, unknown> | null {
  const weatherEntity = states.find((state) => state.entity_id === 'weather.maison')
    ?? states.find((state) => state.entity_id.startsWith('weather.'));
  const temperatureSensor = states.find((state) => state.entity_id === 'sensor.maison_temperature');
  const apparentSensor = states.find((state) => state.entity_id === 'sensor.maison_apparent_temperature')
    ?? states.find((state) => state.entity_id === 'sensor.maison_heat_index_temperature');
  const humiditySensor = states.find((state) => state.entity_id === 'sensor.maison_humidity');

  if (!weatherEntity && !temperatureSensor) return null;

  const attributes = weatherEntity?.attributes ?? {};
  const forecast = Array.isArray(attributes.forecast) ? attributes.forecast as Array<Record<string, unknown>> : [];
  const weatherState = String(weatherEntity?.state ?? attributes.condition ?? 'cloudy');
  const conditionCode = mapWeatherConditionToWmo(weatherState);
  const location = String(
    attributes.friendly_name
    ?? weatherEntity?.entity_id.replace(/^weather\./, '')
    ?? temperatureSensor?.attributes?.friendly_name
    ?? 'Maison'
  );
  const temperature = asNumber(attributes.temperature, asStateNumber(temperatureSensor));
  const feelsLike = asNumber(attributes.apparent_temperature, asStateNumber(apparentSensor, temperature));
  const humidity = asNumber(attributes.humidity, asStateNumber(humiditySensor));
  const windSpeed = asNumber(attributes.wind_speed);
  const windBearing = asNumber(attributes.wind_bearing);
  const daily = (forecast.length > 0 ? forecast.slice(0, 7) : [{ temperature, templow: temperature, precipitation: 0, wind_speed: windSpeed, condition: weatherState }])
    .map((item, index) => ({
      date: typeof item.datetime === 'string' ? item.datetime : new Date(Date.now() + index * 86_400_000).toISOString(),
      code: mapWeatherConditionToWmo(String(item.condition ?? weatherState ?? 'cloudy')),
      max: asNumber(item.temperature, temperature),
      min: asNumber(item.templow, temperature),
      precipSum: asNumber(item.precipitation, 0),
      windMax: asNumber(item.wind_speed, windSpeed),
    }));

  return {
    location,
    temp: temperature,
    feelsLike,
    tempMax: daily[0]?.max ?? temperature,
    tempMin: daily[0]?.min ?? temperature,
    conditionCode,
    humidity,
    windSpeed,
    windDir: windBearing,
    precipitation: daily[0]?.precipSum ?? 0,
    daily,
    hourly: [],
  };
}

export function registerDashboardRoute(app: FastifyInstance, deps: AppDeps): void {
  let dashboardCache: { payload: Record<string, unknown>; fetchedAt: number } | undefined;
  const dashboardCacheTtlMs = 2 * 60 * 1000;
  app.get('/v1/mail/messages', async (req, reply) => {
    try {
      const query = (req.query ?? {}) as { page?: unknown; pageSize?: unknown; accountLabel?: unknown };
      const page = Number(query.page ?? 0);
      const pageSize = Number(query.pageSize ?? 40);
      const accountLabel = typeof query.accountLabel === 'string' ? query.accountLabel.trim().toLowerCase() : '';

      const accounts = buildMailAccounts(deps.env);
      if (accounts.length === 0) {
        return reply.code(400).send({ error: 'mail_not_configured' });
      }

      const account = accountLabel
        ? accounts.find((item) => item.label.trim().toLowerCase() === accountLabel) ?? accounts[0]
        : accounts[0];

      const safePage = Number.isFinite(page) ? Math.max(0, Math.floor(page)) : 0;
      const safePageSize = Number.isFinite(pageSize) ? Math.max(1, Math.min(100, Math.floor(pageSize))) : 40;
      const payload = await fetchMailItemsPageForAccount(account, deps.env, safePage, safePageSize);
      return reply.code(200).send({
        page: safePage,
        pageSize: safePageSize,
        hasMore: payload.hasMore,
        items: payload.items,
      });
    } catch (error) {
      app.log.warn({ error }, 'dashboard_mail_messages_failed');
      return reply.code(500).send({ error: 'mail_messages_failed' });
    }
  });

  app.get('/v1/mail/message', async (req, reply) => {
    try {
      const query = (req.query ?? {}) as { messageId?: unknown; accountLabel?: unknown };
      const messageId = typeof query.messageId === 'string' ? query.messageId.trim() : '';
      const accountLabel = typeof query.accountLabel === 'string' ? query.accountLabel.trim().toLowerCase() : '';

      if (!messageId) {
        return reply.code(400).send({ error: 'message_id_required' });
      }

      const accounts = buildMailAccounts(deps.env);
      if (accounts.length === 0) {
        return reply.code(400).send({ error: 'mail_not_configured' });
      }

      const preferredAccount = accountLabel
        ? accounts.find((item) => item.label.trim().toLowerCase() === accountLabel) ?? accounts[0]
        : accounts[0];

      const { account, payload } = await fetchMailMessageTextFromAnyAccount(accounts, preferredAccount, deps.env, messageId);
      return reply.code(200).send({
        messageId,
        accountLabel: account.label,
        text: payload.text,
        snippet: payload.snippet,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'mail_message_failed';
      const statusMatch = message.match(/^gmail_get_failed:(\d+):/);
      const status = statusMatch ? Number(statusMatch[1]) : 500;
      app.log.warn({ error }, 'dashboard_mail_message_failed');
      return reply.code(Number.isFinite(status) ? status : 500).send({ error: 'mail_message_failed' });
    }
  });

  app.post('/v1/mail/trash', async (req, reply) => {
    try {
      const body = (req.body ?? {}) as { messageId?: unknown; accountLabel?: unknown };
      const messageId = typeof body.messageId === 'string' ? body.messageId.trim() : '';
      const accountLabel = typeof body.accountLabel === 'string' ? body.accountLabel.trim().toLowerCase() : '';

      if (!messageId) {
        return reply.code(400).send({ error: 'message_id_required' });
      }

      const accounts = buildMailAccounts(deps.env);
      if (accounts.length === 0) {
        return reply.code(400).send({ error: 'mail_not_configured' });
      }

      const account = accountLabel
        ? accounts.find((item) => item.label.trim().toLowerCase() === accountLabel) ?? accounts[0]
        : accounts[0];

      const token = await refreshGoogleAccessToken(account, deps.env);
      await gmailPost(`/messages/${encodeURIComponent(messageId)}/trash`, token, {});
      return reply.code(200).send({ ok: true });
    } catch (error) {
      app.log.warn({ error }, 'dashboard_mail_trash_failed');
      return reply.code(500).send({ error: 'mail_trash_failed' });
    }
  });

  app.get('/v1/todo/lists', async (_req, reply) => {
    try {
      const { lists } = await fetchMicrosoftTodoLists(deps.env);
      const items = lists.map(mapTodoListItem);
      const defaultListId = items.find((list) => list.displayName.toLowerCase() === 'tasks')?.id ?? items[0]?.id ?? null;
      return reply.code(200).send({ items, defaultListId });
    } catch (error) {
      app.log.warn({ error }, 'todo_lists_list_failed');
      return reply.code(500).send({ error: 'todo_lists_list_failed' });
    }
  });

  app.get('/v1/todo/tasks', async (_req, reply) => {
    try {
      const items = (await fetchMicrosoftTodoTasks(deps.env))
        .filter((task) => task.status !== 'completed')
        .sort((left, right) => {
          const leftDue = parseDate(left.dueDateTime?.dateTime)?.getTime() ?? Number.MAX_SAFE_INTEGER;
          const rightDue = parseDate(right.dueDateTime?.dateTime)?.getTime() ?? Number.MAX_SAFE_INTEGER;
          if (leftDue !== rightDue) return leftDue - rightDue;
          const leftCreated = parseDate(left.createdDateTime)?.getTime() ?? 0;
          const rightCreated = parseDate(right.createdDateTime)?.getTime() ?? 0;
          return rightCreated - leftCreated;
        });
      return reply.code(200).send({ items });
    } catch (error) {
      app.log.warn({ error }, 'todo_tasks_list_failed');
      return reply.code(500).send({ error: 'todo_tasks_list_failed' });
    }
  });

  app.post('/v1/todo/tasks', async (req, reply) => {
    try {
      const body = (req.body ?? {}) as {
        title?: unknown;
        listId?: unknown;
        importance?: unknown;
        dueDate?: unknown;
      };
      const title = typeof body.title === 'string' ? body.title.trim() : '';
      if (!title) {
        return reply.code(400).send({ error: 'title_required' });
      }

      const { token, lists } = await fetchMicrosoftTodoLists(deps.env);
      if (lists.length === 0) {
        return reply.code(400).send({ error: 'todo_list_missing' });
      }

      const listIdInput = typeof body.listId === 'string' ? body.listId.trim() : '';
      const targetList = listIdInput
        ? lists.find((list) => list.id === listIdInput)
        : lists.find((list) => list.displayName.toLowerCase() === 'tasks') ?? lists[0];
      if (!targetList) {
        return reply.code(400).send({ error: 'todo_list_invalid' });
      }

      const importanceInput = typeof body.importance === 'string' ? body.importance.trim().toLowerCase() : 'normal';
      const importance = importanceInput === 'high' || importanceInput === 'low' ? importanceInput : 'normal';

      const payload: Record<string, unknown> = {
        title,
        importance,
      };

      const dueDateInput = typeof body.dueDate === 'string' ? body.dueDate.trim() : '';
      if (dueDateInput) {
        const dueDateTime = toGraphDateTimeFromDateOnly(dueDateInput);
        if (!dueDateTime) {
          return reply.code(400).send({ error: 'due_date_invalid' });
        }
        payload.dueDateTime = dueDateTime;
      }

      const created = await graphPost<Omit<DashboardTask, 'listId' | 'listName'>>(
        `/me/todo/lists/${targetList.id}/tasks`,
        token,
        payload,
      );

      const item = mapTodoTaskItem({
        ...created,
        listId: targetList.id,
        listName: targetList.displayName,
      });

      return reply.code(201).send({ item });
    } catch (error) {
      app.log.warn({ error }, 'todo_task_create_failed');
      return reply.code(500).send({ error: 'todo_task_create_failed' });
    }
  });

  async function patchTodoTaskStatus(
    req: { body?: unknown },
    reply: { code: (statusCode: number) => { send: (payload: Record<string, unknown>) => unknown } },
    taskIdRaw: unknown,
  ) {
    try {
      const taskId = typeof taskIdRaw === 'string' ? taskIdRaw.trim() : '';
      if (!taskId) {
        return reply.code(400).send({ error: 'task_id_required' });
      }

      const body = (req.body ?? {}) as {
        listId?: unknown;
        status?: unknown;
      };

      const { lists } = await fetchMicrosoftTodoLists(deps.env);
      if (lists.length === 0) {
        return reply.code(400).send({ error: 'todo_list_missing' });
      }

      const listIdInput = typeof body.listId === 'string' ? body.listId.trim() : '';
      const preferred = listIdInput && lists.some((list) => list.id === listIdInput)
        ? [listIdInput]
        : [];
      const candidateListIds = [...preferred, ...lists.map((list) => list.id).filter((id) => id !== listIdInput)];

      const statusInput = typeof body.status === 'string' ? body.status.trim() : '';
      if (statusInput !== 'completed' && statusInput !== 'notStarted') {
        return reply.code(400).send({ error: 'status_invalid' });
      }
      const status = statusInput;

      const token = await refreshMicrosoftAccessToken(deps.env, 'Tasks.ReadWrite offline_access');
      let patched = false;
      for (const listId of candidateListIds) {
        try {
          await graphPatch(`/me/todo/lists/${listId}/tasks/${taskId}`, token, { status });
          patched = true;
          break;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (message.includes('graph_patch_failed:404')) {
            continue;
          }
          throw error;
        }
      }

      if (!patched) {
        return reply.code(404).send({ error: 'todo_task_not_found' });
      }

      return reply.code(200).send({ ok: true });
    } catch (error) {
      app.log.warn({ error }, 'todo_task_patch_failed');
      return reply.code(500).send({ error: 'todo_task_patch_failed' });
    }
  }

  app.patch('/v1/todo/tasks/:taskId', async (req, reply) => {
    const params = (req.params ?? {}) as { taskId?: string };
    return patchTodoTaskStatus(req, reply, params.taskId);
  });

  app.patch('/v1/todo/tasks', async (req, reply) => {
    const body = (req.body ?? {}) as { taskId?: unknown };
    return patchTodoTaskStatus(req, reply, body.taskId);
  });

  app.get('/v1/dashboard', async (_req, reply) => {
    if (dashboardCache && Date.now() - dashboardCache.fetchedAt < dashboardCacheTtlMs) {
      return reply.code(200).send({
        ...dashboardCache.payload,
        cache: { hit: true, fetchedAt: new Date(dashboardCache.fetchedAt).toISOString() },
      });
    }
    const haStatesPromise = deps.ha
      ? deps.ha.getStates()
        .then((data) => Array.isArray(data) ? data as HaState[] : [])
        .catch((error) => {
          app.log.warn({ error }, 'dashboard_ha_states_failed');
          return [] as HaState[];
        })
      : Promise.resolve([] as HaState[]);

    const mailPromise = buildMailSection(deps.env, app.log).catch((error) => {
      app.log.warn({ error }, 'dashboard_mail_failed');
      return makeSection('Mail', 'jarvis-mail', 'Impossible de recuperer les emails pour le moment.');
    });

    const todoPromise = buildTasksSection(deps.env).catch((error) => {
      app.log.warn({ error }, 'dashboard_todo_failed');
      return makeSection('Taches', 'jarvis-todo', 'Impossible de recuperer les taches pour le moment.');
    });

    // Agenda: read directly from Google Calendar and keep failures visible.
    const agendaPromise = buildAgendaFromGoogle(deps.env).catch((error) => {
      app.log.warn({ error }, 'dashboard_agenda_google_failed');
      return {
        ...makeSection('Agenda', 'google-calendar', 'Je n ai pas pu lire Google Calendar pour le moment.'),
        status: 'error' as const,
      };
    });

    const [haStates, mailSection, tasksSection, googleAgenda] = await Promise.all([
      haStatesPromise, mailPromise, todoPromise, agendaPromise,
    ]);
    const weather = buildWeatherPayload(haStates);
    const agenda = googleAgenda;

    const payload = {
      status: 'ok',
      generatedAt: new Date().toISOString(),
      weather,
      organization: {
        mail: mailSection,
        tasks: tasksSection,
        agenda,
        links: LOCAL_LINKS,
      },
    };
    dashboardCache = { payload, fetchedAt: Date.now() };
    return reply.code(200).send({
      ...payload,
      cache: { hit: false, fetchedAt: new Date(dashboardCache.fetchedAt).toISOString() },
    });
  });
}
