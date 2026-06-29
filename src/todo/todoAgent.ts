/**
 * Todo agent — Microsoft To Do via Microsoft Graph API sub-agent.
 *
 * Architecture mirrors search/agents.ts:
 *   1. LLM planner (gpt-4o-mini, structured JSON output) translates voice text → TodoAction
 *   2. Token refresher acquires a short-lived Graph access token
 *   3. Executor calls Microsoft Graph /me/todo/* endpoints
 *   4. Returns a human-readable French string suitable for TTS
 *
 * Routing keys: "todo" | "todo.*"
 * Detected by isTodoAgentKey() — mirrors isSearchAgentKey() from search/agents.ts.
 *
 * Required env vars:
 *   MICROSOFT_CLIENT_ID, MICROSOFT_CLIENT_SECRET, MICROSOFT_REFRESH_TOKEN
 *   OPENAI_API_KEY, OPENAI_BASE_URL, OPENAI_TIMEOUT_MS
 *
 * Optional:
 *   MICROSOFT_TENANT_ID  (default: "common" — works for personal Microsoft accounts)
 */

import { getStoredRefreshToken, setStoredRefreshToken } from '../auth/oauthRefreshTokenStore';
import { buildTodoSynthesisSystemPrompt } from './prompts/todoSynthesisSystemPrompt';
import { buildTodoSynthesisUserPrompt } from './prompts/todoSynthesisUserTemplate';

const TODO_SYNTHESIS_SYSTEM_PROMPT = buildTodoSynthesisSystemPrompt();

/** Returns the first sentence of a TTS-friendly string, capped at maxChars. */
function firstSentence(text: string, maxChars = 140): string {
  const m = text.match(/^[^.!?]+[.!?]/);
  const s = m ? m[0] : text;
  return s.length > maxChars ? s.slice(0, maxChars).trimEnd() + '…' : s;
}

function compactTodoListForFallback(text: string): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (!clean) return clean;

  // Extract a concise intro + at most 5 listed tasks when the payload is very long.
  const match = clean.match(/^(Tu as\s+\d+\s+tâche[s]?.*?:)\s*(.+)\.$/i);
  if (match) {
    const intro = match[1] ?? 'Voici tes tâches :';
    const body = match[2] ?? '';
    const parts = body
      .split(/,\s+(?=[^,]+(?:échéance|urgente|en cours|différée|en attente|récurrente)|[^,]+$)/)
      .map((x) => x.trim())
      .filter(Boolean);

    if (parts.length > 5) {
      const shown = parts.slice(0, 5);
      const remaining = parts.length - shown.length;
      return `${intro} ${shown.join(', ')} et ${remaining} autre${remaining > 1 ? 's' : ''}.`;
    }
  }

  return firstSentence(clean, 220);
}

function normalizeForMatch(value: string): string {
  return String(value ?? '')
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function inferListTasksPeriodFromText(text: string): ListTasksAction['period'] | undefined {
  const t = text.toLowerCase();

  // Keep precedence explicit and deterministic.
  if (/(aujourd'hui|ce jour)/.test(t)) return 'today';
  if (/(demain|tomorrow)/.test(t)) return 'tomorrow';
  if (/(semaine prochaine|next week)/.test(t)) return 'next_week';
  if (/(cette semaine|semaine en cours|this week)/.test(t)) return 'this_week';
  if (/(ce mois|ce mois-ci|this month)/.test(t)) return 'this_month';
  if (/(en retard|retard|overdue)/.test(t)) return 'overdue';

  return undefined;
}

// ─── Action types ─────────────────────────────────────────────────────────────

// ─── Recurrence ──────────────────────────────────────────────────────────────
// Mirrors patternedRecurrence from Graph API (simplified for voice input).
// pattern.type: daily | weekly | absoluteMonthly | absoluteYearly
// daysOfWeek: for weekly — ['monday'], ['monday','wednesday'], etc.
// dayOfMonth: for absoluteMonthly / absoluteYearly (1-31)
// month: for absoluteYearly (1-12)
// interval: every N units (default 1)
type RecurrenceInput = {
  type: 'daily' | 'weekly' | 'absoluteMonthly' | 'absoluteYearly';
  interval?: number;
  daysOfWeek?: ('sunday'|'monday'|'tuesday'|'wednesday'|'thursday'|'friday'|'saturday')[];
  dayOfMonth?: number;
  month?: number;
};

type ListTasksAction           = { action: 'list_tasks';              list_name?: string; status?: 'active' | 'completed' | 'all'; period?: 'today' | 'tomorrow' | 'this_week' | 'next_week' | 'this_month' | 'overdue' };
type AddTaskAction             = { action: 'add_task';                 title: string; list_name?: string; due_date?: string; start_date?: string; reminder_date?: string; importance?: 'low' | 'normal' | 'high'; notes?: string; categories?: string[]; recurrence?: RecurrenceInput };
type CompleteAction            = { action: 'complete_task';            title: string; list_name?: string };
type DeleteAction              = { action: 'delete_task';              title: string; list_name?: string };
type UpdateTaskAction          = { action: 'update_task';              title: string; list_name?: string; new_title?: string; due_date?: string | null; importance?: 'low' | 'normal' | 'high'; status?: 'notStarted' | 'inProgress' | 'deferred' | 'waitingOnOthers'; notes?: string; reminder_date?: string; categories?: string[]; recurrence?: RecurrenceInput | null };
type ListListsAction           = { action: 'list_lists' };
type CreateListAction          = { action: 'create_list';              name: string };
type DeleteListAction          = { action: 'delete_list';              name: string };
type AddChecklistAction        = { action: 'add_checklist_item';       task_title: string; item_title: string; list_name?: string };
type CompleteChecklistAction   = { action: 'complete_checklist_item';  task_title: string; item_title: string; list_name?: string };
type DeleteChecklistAction     = { action: 'delete_checklist_item';    task_title: string; item_title: string; list_name?: string };

export type TodoAction =
  | ListTasksAction | AddTaskAction | CompleteAction | DeleteAction | UpdateTaskAction
  | ListListsAction | CreateListAction | DeleteListAction
  | AddChecklistAction | CompleteChecklistAction | DeleteChecklistAction;

// ─── Minimal env surface ──────────────────────────────────────────────────────

export type TodoEnv = {
  MICROSOFT_CLIENT_ID?: string;
  MICROSOFT_CLIENT_SECRET?: string;
  MICROSOFT_REFRESH_TOKEN?: string;
  MICROSOFT_TENANT_ID?: string;
  OAUTH_REFRESH_TOKEN_STORE_PATH?: string;
  OPENAI_API_KEY?: string;
  OPENAI_BASE_URL: string;
  OPENAI_TIMEOUT_MS: number;
  OPENAI_MODEL_SUMMARY?: string;
};

async function synthesizeTodoReplyWithOpenAi(params: {
  openAiApiKey: string;
  openAiBaseUrl: string;
  model: string;
  timeoutMs: number;
  userText: string;
  executorResult: string;
}): Promise<string> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), params.timeoutMs);
    const res = await fetch(`${params.openAiBaseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${params.openAiApiKey}` },
      body: JSON.stringify({
        model: params.model,
        max_tokens: 180,
        messages: [
          { role: 'system', content: TODO_SYNTHESIS_SYSTEM_PROMPT },
          { role: 'user',   content: buildTodoSynthesisUserPrompt(params.userText, params.executorResult) },
        ],
      }),
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) return compactTodoListForFallback(params.executorResult);
    const data = await res.json() as { choices?: { message?: { content?: string } }[] };
    return data.choices?.[0]?.message?.content?.trim() || compactTodoListForFallback(params.executorResult);
  } catch {
    return compactTodoListForFallback(params.executorResult);
  }
}

type MinLogger = {
  info: (obj: Record<string, unknown>, msg: string) => void;
  warn: (obj: Record<string, unknown>, msg: string) => void;
};

// ─── MS Graph — token refresh ─────────────────────────────────────────────────

// ─── Access token cache (in-memory, per process) ─────────────────────────────
//
// Two protections against token expiry:
//   1. Access token cache: reused until TOKEN_EXPIRY_BUFFER_MS before expiry (~1 h window).
//   2. Refresh token rotation: if the provider returns a new refresh_token, it is kept
//      in memory and used for subsequent calls (Microsoft rotates by default).
//   3. Keep-alive: a setInterval fires every KEEPALIVE_INTERVAL_MS to proactively call
//      the token endpoint, keeping the refresh token's inactivity window reset.
//      Microsoft inactive limit: 90 days. We refresh every 30 days → always safe.
//      If the process is down for >90 days the user must re-run the auth flow once.

interface CachedToken { accessToken: string; expiresAt: number }
const _msTokenCache          = new Map<string, CachedToken>();
const _msLiveRefreshToken    = new Map<string, string>(); // captures rotated refresh tokens
const _msKeepaliveScheduled  = new Set<string>();
const TOKEN_EXPIRY_BUFFER_MS = 60_000;          // refresh access token 60 s before expiry
const KEEPALIVE_DAYS         = 30;              // resets Microsoft's 90-day inactivity window

async function refreshMicrosoftToken(env: {
  MICROSOFT_TENANT_ID?: string;
  MICROSOFT_CLIENT_ID: string;
  MICROSOFT_CLIENT_SECRET: string;
  MICROSOFT_REFRESH_TOKEN: string;
  cacheKey?: string;
  storeKey?: string;
  OAUTH_REFRESH_TOKEN_STORE_PATH?: string;
}): Promise<string> {
  const cacheKey = env.cacheKey?.trim() || env.MICROSOFT_CLIENT_ID;
  const storeKey = env.storeKey?.trim() || `todo:microsoft:${env.MICROSOFT_CLIENT_ID}`;
  const cached = _msTokenCache.get(cacheKey);
  if (cached && Date.now() < cached.expiresAt) return cached.accessToken;

  // Use the latest rotated refresh token if we have one; fall back to env.
  const refreshToken =
    _msLiveRefreshToken.get(cacheKey)
    ?? await getStoredRefreshToken(env.OAUTH_REFRESH_TOKEN_STORE_PATH, storeKey)
    ?? env.MICROSOFT_REFRESH_TOKEN;
  const tenantId = env.MICROSOFT_TENANT_ID?.trim() || 'common';
  const resp = await fetch(
    `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id:     env.MICROSOFT_CLIENT_ID,
        client_secret: env.MICROSOFT_CLIENT_SECRET,
        refresh_token: refreshToken,
        grant_type:    'refresh_token',
        scope:         'Tasks.ReadWrite offline_access',
      }),
      signal: AbortSignal.timeout(8_000),
    },
  );
  if (!resp.ok) {
    _msTokenCache.delete(cacheKey);
    const body = await resp.text().catch(() => '');
    throw new Error(`todo_ms_token_refresh_failed:${resp.status}:${body.slice(0, 200)}`);
  }
  const data = await resp.json() as { access_token?: string; expires_in?: number; refresh_token?: string };
  if (!data.access_token) throw new Error('todo_ms_token_refresh_no_token');

  // Capture rotated refresh token if the provider issued a new one.
  if (data.refresh_token) {
    _msLiveRefreshToken.set(cacheKey, data.refresh_token);
    await setStoredRefreshToken(env.OAUTH_REFRESH_TOKEN_STORE_PATH, storeKey, data.refresh_token);
  }

  const expiresIn = typeof data.expires_in === 'number' ? data.expires_in : 3600;
  _msTokenCache.set(cacheKey, {
    accessToken: data.access_token,
    expiresAt:   Date.now() + expiresIn * 1_000 - TOKEN_EXPIRY_BUFFER_MS,
  });

  // Schedule a keep-alive so the refresh token's inactivity window never expires
  // while the Jarvis process is running. Fires every 30 days (well within the
  // 90-day Microsoft inactive limit).
  // Note: Node.js setInterval uses a 32-bit ms counter (max ~24.8 days).
  // We chain 1-day intervals and count up to KEEPALIVE_DAYS to stay within bounds.
  if (!_msKeepaliveScheduled.has(cacheKey)) {
    _msKeepaliveScheduled.add(cacheKey);
    let dayCount = 0;
    const timer = setInterval(() => {
      dayCount++;
      if (dayCount >= KEEPALIVE_DAYS) {
        dayCount = 0;
        _msTokenCache.delete(cacheKey);
        refreshMicrosoftToken(env).catch(() => { /* keep-alive failure is non-fatal */ });
      }
    }, 24 * 3_600_000); // 1 day — safe for 32-bit setInterval
    if (timer.unref) timer.unref();
  }

  return data.access_token;
}

// ─── MS Graph — low-level helpers ────────────────────────────────────────────

const GRAPH = 'https://graph.microsoft.com/v1.0';

interface MsTaskList { id: string; displayName: string; wellknownListName?: string }
interface MsTask {
  id: string;
  title: string;
  status: 'notStarted' | 'inProgress' | 'completed' | 'waitingOnOthers' | 'deferred';
  importance?: 'low' | 'normal' | 'high';
  dueDateTime?:       { dateTime: string; timeZone: string } | null;
  startDateTime?:     { dateTime: string; timeZone: string } | null;
  reminderDateTime?:  { dateTime: string; timeZone: string } | null;
  completedDateTime?: { dateTime: string; timeZone: string } | null;
  isReminderOn?: boolean;
  body?: { content: string; contentType: string } | null;
  categories?: string[];
  recurrence?: { pattern: Record<string, unknown>; range: Record<string, unknown> } | null;
  createdDateTime?: string;
}
interface MsChecklistItem { id: string; displayName: string; isChecked: boolean; createdDateTime?: string }

async function graphGet<T>(path: string, token: string): Promise<T> {
  const resp = await fetch(`${GRAPH}${path}`, {
    headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
    signal: AbortSignal.timeout(8_000),
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    throw new Error(`todo_graph_get_failed:${resp.status}:${body.slice(0, 200)}`);
  }
  return resp.json() as Promise<T>;
}

async function graphPost<T>(path: string, token: string, body: object): Promise<T> {
  const resp = await fetch(`${GRAPH}${path}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(8_000),
  });
  if (!resp.ok) {
    const raw = await resp.text().catch(() => '');
    throw new Error(`todo_graph_post_failed:${resp.status}:${raw.slice(0, 200)}`);
  }
  return resp.json() as Promise<T>;
}

async function graphPatch(path: string, token: string, body: object): Promise<void> {
  const resp = await fetch(`${GRAPH}${path}`, {
    method: 'PATCH',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(8_000),
  });
  if (!resp.ok) {
    const raw = await resp.text().catch(() => '');
    throw new Error(`todo_graph_patch_failed:${resp.status}:${raw.slice(0, 200)}`);
  }
}

async function graphDelete(path: string, token: string): Promise<void> {
  const resp = await fetch(`${GRAPH}${path}`, {
    method: 'DELETE',
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(8_000),
  });
  if (!resp.ok && resp.status !== 404) {
    throw new Error(`todo_graph_delete_failed:${resp.status}`);
  }
}

/** Build a Graph API dateTimeTimeZone object.
 * The dateTime must NOT include a timezone suffix (no 'Z') when timeZone is provided separately.
 */
function graphDateTime(isoDate: string, time = '00:00:00.0000000'): { dateTime: string; timeZone: string } {
  return { dateTime: `${isoDate.slice(0, 10)}T${time}`, timeZone: 'UTC' };
}

// ─── Watched lists (aggregated when no list_name given) ─────────────────────

// Patterns matching the 3 lists the user manages with Jarvis.
// Order matters: first match wins for display purposes.
const WATCHED_LIST_PATTERNS: RegExp[] = [
  /^(tasks?|t[\u00e2a]ches?)$/i,  // built-in "T\u00e2ches" / "Tasks"
  /^vie\s+quotidienne$/i,
  /^nas$/i,
];

function isWatchedList(l: MsTaskList): boolean {
  if (l.wellknownListName === 'defaultList') return true;
  return WATCHED_LIST_PATTERNS.some((p) => p.test(l.displayName.trim()));
}

// ─── Period filter helpers ────────────────────────────────────────────────────

function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function isInPeriod(isoDate: string | undefined, period: string): boolean {
  if (!isoDate) return false;
  const taskDay = startOfDay(new Date(isoDate.slice(0, 10)));
  const today   = startOfDay(new Date());
  switch (period) {
    case 'today':       return taskDay.getTime() === today.getTime();
    case 'tomorrow': {
      const tom = new Date(today); tom.setDate(today.getDate() + 1);
      return taskDay.getTime() === tom.getTime();
    }
    case 'this_week': {
      const mon = new Date(today); mon.setDate(today.getDate() - ((today.getDay() + 6) % 7));
      const sun = new Date(mon);   sun.setDate(mon.getDate() + 6);
      return taskDay >= mon && taskDay <= sun;
    }
    case 'next_week': {
      const mon = new Date(today); mon.setDate(today.getDate() - ((today.getDay() + 6) % 7) + 7);
      const sun = new Date(mon);   sun.setDate(mon.getDate() + 6);
      return taskDay >= mon && taskDay <= sun;
    }
    case 'this_month':
      return taskDay.getFullYear() === today.getFullYear() && taskDay.getMonth() === today.getMonth();
    case 'overdue':
      return taskDay.getTime() < today.getTime();
    default:
      return true;
  }
}

function periodFr(period: string): string {
  switch (period) {
    case 'today':      return "pour aujourd'hui";
    case 'tomorrow':   return 'pour demain';
    case 'this_week':  return 'cette semaine';
    case 'next_week':  return 'la semaine prochaine';
    case 'this_month': return 'ce mois-ci';
    case 'overdue':    return 'en retard';
    default:           return '';
  }
}

// ─── List & task finders ──────────────────────────────────────────────────────

async function findList(token: string, listName?: string): Promise<MsTaskList | null> {
  const data = await graphGet<{ value: MsTaskList[] }>('/me/todo/lists', token);
  const lists = data.value ?? [];
  const resolveDefaultList = (): MsTaskList | null => (
    lists.find((l) => l.wellknownListName === 'defaultList') ??
    lists.find((l) => /^(tasks?|t[âa]ches?)$/i.test(l.displayName.trim())) ??
    lists[0] ??
    null
  );
  if (!listName) {
    // Prefer the built-in default list (wellknownListName === 'defaultList'),
    // then fall back to display-name heuristic, then first list.
    return resolveDefaultList();
  }
  const needle = normalizeForMatch(listName);
  if (!needle) return null;

  // Canonical aliasing for the built-in default To Do list across FR/EN labels.
  if (needle === 'taches' || needle === 'tache' || needle === 'tasks' || needle === 'task') {
    return resolveDefaultList();
  }

  return lists.find((l) => normalizeForMatch(l.displayName) === needle) ?? null;
}

async function findTask(token: string, listId: string, title: string, includeCompleted = false): Promise<MsTask | null> {
  const qs = includeCompleted
    ? '$top=100'
    : `$filter=status ne 'completed'&$top=100`;
  const data = await graphGet<{ value: MsTask[] }>(
    `/me/todo/lists/${listId}/tasks?${qs}`,
    token,
  );
  const tasks = data.value ?? [];
  const needle = normalizeForMatch(title);
  if (!needle) return null;
  return tasks.find((t) => normalizeForMatch(t.title) === needle) ?? null;
}

async function findTaskMatchesAcrossWatchedLists(
  token: string,
  title: string,
  includeCompleted = false,
): Promise<Array<{ list: MsTaskList; task: MsTask }>> {
  const allData = await graphGet<{ value: MsTaskList[] }>('/me/todo/lists', token);
  const watched = (allData.value ?? []).filter(isWatchedList);
  const hits = await Promise.all(
    watched.map(async (l) => {
      const task = await findTask(token, l.id, title, includeCompleted);
      return task ? { list: l, task } : null;
    }),
  );
  return hits.filter((item): item is { list: MsTaskList; task: MsTask } => item !== null);
}

/** Normalize a reminder dateTime string (from LLM) to 'HH:MM:SS.0000000'.
 * Handles: '09:00', '09:00:00', '09:00:00.000', etc.
 */
function normalizeReminderTime(reminderDate: string): string {
  const raw = reminderDate.includes('T') ? reminderDate.split('T')[1]! : '09:00';
  const parts = raw.split(':');
  const h = (parts[0] ?? '09').padStart(2, '0');
  const m = (parts[1] ?? '00').padStart(2, '0');
  const s = (parts[2] ?? '00').split('.')[0]!.padStart(2, '0');
  return `${h}:${m}:${s}.0000000`;
}

// ─── LLM planner ─────────────────────────────────────────────────────────────

const _PLANNER_SYSTEM = `Tu es un assistant de gestion de tâches (Microsoft To Do).
Analyse la commande vocale en français et retourne un JSON correspondant à une seule action.
Le message utilisateur commencera par "TODAY=YYYY-MM-DD" indiquant la date du jour. Utilise cette date pour calculer les dates relatives (demain, la semaine prochaine, etc.) et toujours exprimer les dates en format YYYY-MM-DD absolu.

Listes surveillées par défaut (utilisées quand aucune liste n'est précisée) :
  - "Tâches" (liste système par défaut)
  - "Vie quotidienne"
  - "NAS"

Champ obligatoire "action" parmi :
  list_tasks | add_task | complete_task | delete_task | update_task
  list_lists | create_list | delete_list
  add_checklist_item | complete_checklist_item | delete_checklist_item

Champs conditionnels (selon l'action) :
  list_tasks              → "list_name" (optionnel),
                            "status" ("active"|"completed"|"all", défaut "active"),
                            "period" (optionnel — UNIQUEMENT si l'utilisateur donne une temporalité) :
                              "today"      = aujourd'hui
                              "tomorrow"   = demain
                              "this_week"  = cette semaine
                              "next_week"  = la semaine prochaine
                              "this_month" = ce mois-ci
                              "overdue"    = en retard
                            Quand "period" est présent, seules les tâches AVEC échéance dans cette période sont retournées.
  add_task                → "title" (obligatoire), "list_name" (optionnel),
                            "due_date" (YYYY-MM-DD, optionnel), "start_date" (YYYY-MM-DD, optionnel),
                            "reminder_date" (YYYY-MM-DDTHH:MM, optionnel),
                            "importance" ("low"|"normal"|"high", optionnel),
                            "notes" (string, optionnel),
                            "categories" (string[], optionnel),
                            "recurrence" (objet optionnel — voir format ci-dessous)
  complete_task           → "title" (obligatoire), "list_name" (optionnel)
  delete_task             → "title" (obligatoire), "list_name" (optionnel)
  update_task             → "title" (titre actuel, obligatoire), "list_name" (optionnel),
                            "new_title" (optionnel), "due_date" (YYYY-MM-DD | null pour supprimer, optionnel),
                            "importance" ("low"|"normal"|"high", optionnel),
                            "status" ("notStarted"|"inProgress"|"deferred"|"waitingOnOthers", optionnel),
                            "notes" (string, optionnel), "reminder_date" (YYYY-MM-DDTHH:MM, optionnel),
                            "categories" (string[], optionnel),
                            "recurrence" (objet optionnel | null pour supprimer la récurrence)
  list_lists              → (aucun champ)
  create_list             → "name" (obligatoire)
  delete_list             → "name" (obligatoire)
  add_checklist_item      → "task_title" (obligatoire), "item_title" (obligatoire), "list_name" (optionnel)
  complete_checklist_item → "task_title" (obligatoire), "item_title" (obligatoire), "list_name" (optionnel)
  delete_checklist_item   → "task_title" (obligatoire), "item_title" (obligatoire), "list_name" (optionnel)

Format "recurrence" :
  { "type": "daily"|"weekly"|"absoluteMonthly"|"absoluteYearly",
    "interval": <entier, défaut 1>,
    "daysOfWeek": ["monday",...],   ← pour weekly
    "dayOfMonth": <1-31>,           ← pour absoluteMonthly / absoluteYearly
    "month": <1-12>                 ← pour absoluteYearly uniquement }

Réponds UNIQUEMENT avec du JSON valide, sans texte supplémentaire.
Exemples :
  "montre mes tâches"                              → {"action":"list_tasks"}
  "mes tâches d'aujourd'hui"                       → {"action":"list_tasks","period":"today"}
  "qu'est-ce que j'ai à faire cette semaine"       → {"action":"list_tasks","period":"this_week"}
  "tâches en retard"                               → {"action":"list_tasks","period":"overdue"}
  "tâches de demain"                               → {"action":"list_tasks","period":"tomorrow"}
  "tâches terminées"                               → {"action":"list_tasks","status":"completed"}
  "ajoute acheter du pain"                         → {"action":"add_task","title":"Acheter du pain"}
  "tâche urgente : appeler le médecin"             → {"action":"add_task","title":"Appeler le médecin","importance":"high"}
  "rappelle-moi chaque lundi de faire le point"    → {"action":"add_task","title":"Faire le point","recurrence":{"type":"weekly","daysOfWeek":["monday"]}}
  "tâche récurrente chaque jour : sport"           → {"action":"add_task","title":"Sport","recurrence":{"type":"daily"}}
  "rappelle-moi le 1er de chaque mois"             → {"action":"add_task","title":"Rappel mensuel","recurrence":{"type":"absoluteMonthly","dayOfMonth":1}}
  "rappelle-moi appeler le médecin lundi matin"    → {"action":"add_task","title":"Appeler le médecin","reminder_date":"<YYYY-MM-DDT09:00>"}
  "marque faire la vaisselle comme fait"           → {"action":"complete_task","title":"faire la vaisselle"}
  "supprime la tâche courses"                      → {"action":"delete_task","title":"courses"}
  "change l'échéance de réunion au 15 mars"        → {"action":"update_task","title":"réunion","due_date":"<YYYY-03-15>"}
  "supprime l'échéance de la tâche rapport"        → {"action":"update_task","title":"rapport","due_date":null}
  "arrête la récurrence de sport"                  → {"action":"update_task","title":"sport","recurrence":null}
  "mets la tâche rapport en cours"                 → {"action":"update_task","title":"rapport","status":"inProgress"}
  "affiche mes listes"                             → {"action":"list_lists"}
  "crée une liste Vacances"                        → {"action":"create_list","name":"Vacances"}
  "supprime la liste Vacances"                     → {"action":"delete_list","name":"Vacances"}
  "ajoute la sous-tâche Réserver hôtel à Vacances" → {"action":"add_checklist_item","task_title":"Vacances","item_title":"Réserver hôtel"}
  "marque Réserver hôtel comme fait"               → {"action":"complete_checklist_item","task_title":"Vacances","item_title":"Réserver hôtel"}
  "supprime la sous-tâche Réserver hôtel"          → {"action":"delete_checklist_item","task_title":"Vacances","item_title":"Réserver hôtel"}
`.trim();

async function planTodoAction(
  text: string,
  openAiApiKey: string,
  openAiBaseUrl: string,
  timeoutMs: number,
): Promise<TodoAction> {
  const resp = await fetch(`${openAiBaseUrl.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${openAiApiKey}`,
    },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      temperature: 0,
      max_tokens: 350,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: _PLANNER_SYSTEM },
        { role: 'user',   content: `TODAY=${new Date().toISOString().slice(0, 10)}\n${text}` },
      ],
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!resp.ok) {
    const raw = await resp.text().catch(() => '');
    throw new Error(`todo_planner_llm_failed:${resp.status}:${raw.slice(0, 200)}`);
  }

  const data = await resp.json() as { choices?: Array<{ message?: { content?: string } }> };
  const content = data.choices?.[0]?.message?.content?.trim() ?? '{}';

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error(`todo_planner_invalid_json:${content.slice(0, 100)}`);
  }

  if (typeof parsed !== 'object' || parsed === null || !('action' in parsed)) {
    throw new Error(`todo_planner_missing_action:${content.slice(0, 100)}`);
  }

  return parsed as TodoAction;
}

export async function planTodoAgentAction(
  text: string,
  env: TodoEnv,
  log?: MinLogger,
): Promise<TodoAction | { clarification: string }> {
  if (!env.MICROSOFT_CLIENT_ID || !env.MICROSOFT_CLIENT_SECRET || !env.MICROSOFT_REFRESH_TOKEN) {
    return { clarification: 'La gestion des taches n est pas configuree.' };
  }
  if (!env.OPENAI_API_KEY) return { clarification: 'Je ne peux pas gerer les taches pour l instant, la cle OpenAI est manquante.' };
  try {
    let action = await planTodoAction(text, env.OPENAI_API_KEY, env.OPENAI_BASE_URL, env.OPENAI_TIMEOUT_MS);
    if (action.action === 'list_tasks' && !action.period) {
      const inferred = inferListTasksPeriodFromText(text);
      if (inferred) {
        action = { ...action, period: inferred };
        log?.info({ inferred_period: inferred }, 'todo_agent_period_inferred');
      }
    }
    return action;
  } catch (err) {
    log?.warn({ err: String(err) }, 'todo_agent_planner_error');
    return { clarification: 'Desole, je n ai pas compris cette demande de tache. Tu peux reessayer differemment.' };
  }
}

export function formatTodoActionPreview(action: TodoAction): string {
  switch (action.action) {
    case 'add_task':
      return `Tache a ajouter: ${action.title}${action.list_name ? ` dans ${action.list_name}` : ''}${action.due_date ? `, echeance ${action.due_date}` : ''}.`;
    case 'complete_task':
      return `Tache a terminer: ${action.title}${action.list_name ? ` dans ${action.list_name}` : ''}.`;
    case 'delete_task':
      return `Tache a supprimer: ${action.title}${action.list_name ? ` dans ${action.list_name}` : ''}.`;
    case 'update_task':
      return `Tache a modifier: ${action.title}${action.new_title ? ` vers ${action.new_title}` : ''}${action.due_date ? `, echeance ${action.due_date}` : ''}.`;
    case 'create_list':
      return `Liste a creer: ${action.name}.`;
    case 'delete_list':
      return `Liste a supprimer: ${action.name}.`;
    case 'add_checklist_item':
      return `Element checklist a ajouter: ${action.item_title} dans ${action.task_title}.`;
    case 'complete_checklist_item':
      return `Element checklist a terminer: ${action.item_title} dans ${action.task_title}.`;
    case 'delete_checklist_item':
      return `Element checklist a supprimer: ${action.item_title} dans ${action.task_title}.`;
    default:
      return `Action tache ${action.action}.`;
  }
}

// ─── TTS formatting helpers ───────────────────────────────────────────────────

const FR_MONTHS = ['janvier','février','mars','avril','mai','juin','juillet','août','septembre','octobre','novembre','décembre'];
const FR_DAYS   = { sunday:'dimanche', monday:'lundi', tuesday:'mardi', wednesday:'mercredi', thursday:'jeudi', friday:'vendredi', saturday:'samedi' } as const;

/** "2026-05-06" → "aujourd'hui", "demain", "hier", "6 mai" or "6 mai 2026" */
function formatDateFr(iso: string): string {
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  const now = new Date();
  const todayY = now.getFullYear(), todayM = now.getMonth() + 1, todayD = now.getDate();
  if (y === todayY && m === todayM && d === todayD) return "aujourd'hui";
  // tomorrow
  const tom = new Date(now); tom.setDate(todayD + 1);
  if (y === tom.getFullYear() && m === tom.getMonth() + 1 && d === tom.getDate()) return 'demain';
  // yesterday
  const yest = new Date(now); yest.setDate(todayD - 1);
  if (y === yest.getFullYear() && m === yest.getMonth() + 1 && d === yest.getDate()) return 'hier';

  const month = FR_MONTHS[(m ?? 1) - 1] ?? '';
  if (y !== todayY) return `${d} ${month} ${y}`;
  return `${d} ${month}`;
}

/** Localize recurrence type for TTS */
function recurrenceFr(r: RecurrenceInput): string {
  const daysLabel = r.daysOfWeek?.map((d) => FR_DAYS[d as keyof typeof FR_DAYS] ?? d).join(' et ');
  switch (r.type) {
    case 'daily':           return r.interval && r.interval > 1 ? `tous les ${r.interval} jours` : 'tous les jours';
    case 'weekly':          return daysLabel ? `chaque ${daysLabel}` : (r.interval && r.interval > 1 ? `toutes les ${r.interval} semaines` : 'chaque semaine');
    case 'absoluteMonthly': return r.interval && r.interval > 1 ? `tous les ${r.interval} mois` : 'chaque mois';
    case 'absoluteYearly':  return r.interval && r.interval > 1 ? `tous les ${r.interval} ans` : 'chaque année';
    default:                return 'régulièrement';
  }
}

/** Join a list of strings naturally: "a, b et c" */
function joinFr(items: string[]): string {
  if (items.length === 0) return '';
  if (items.length === 1) return items[0]!;
  return `${items.slice(0, -1).join(', ')} et ${items[items.length - 1]}`;
}

// ─── Recurrence builder ───────────────────────────────────────────────────────

/**
 * Convert a simplified RecurrenceInput into a Graph API patternedRecurrence object.
 * startDate must be YYYY-MM-DD.
 */
function buildRecurrence(r: RecurrenceInput, startDate: string): object {
  const interval = r.interval ?? 1;
  const pattern: Record<string, unknown> = { type: r.type, interval };
  if (r.type === 'weekly') {
    pattern['daysOfWeek']    = r.daysOfWeek?.length ? r.daysOfWeek : ['monday'];
    pattern['firstDayOfWeek'] = 'monday';
  } else if (r.type === 'absoluteMonthly' && r.dayOfMonth) {
    pattern['dayOfMonth'] = r.dayOfMonth;
  } else if (r.type === 'absoluteYearly') {
    if (r.dayOfMonth) pattern['dayOfMonth'] = r.dayOfMonth;
    if (r.month)      pattern['month']      = r.month;
  }
  return {
    pattern,
    range: { type: 'noEnd', startDate },
  };
}

// ─── Executor ─────────────────────────────────────────────────────────────────

async function executeTodo(action: TodoAction, token: string): Promise<string> {
  switch (action.action) {
    case 'list_tasks': {
      // Determine which list(s) to query.
      let targetLists: MsTaskList[];
      if (action.list_name) {
        const found = await findList(token, action.list_name);
        if (!found) return `Je n'ai pas trouvé de liste correspondant à ${action.list_name}.`;
        targetLists = [found];
      } else {
        const allData = await graphGet<{ value: MsTaskList[] }>('/me/todo/lists', token);
        targetLists = (allData.value ?? []).filter(isWatchedList);
        if (targetLists.length === 0) return 'Aucune liste surveillée trouvée dans Microsoft To Do.';
      }

      // Build Graph query string.
      let qs: string;
      if (action.status === 'completed') {
        qs = `$filter=status eq 'completed'&$top=20`;
      } else if (action.status === 'all') {
        qs = `$top=30`;
      } else {
        qs = `$filter=status ne 'completed'&$top=30`;
      }

      // Fetch from all target lists in parallel.
      const results = await Promise.all(
        targetLists.map((l) =>
          graphGet<{ value: MsTask[] }>(`/me/todo/lists/${l.id}/tasks?${qs}`, token)
            .then((d) => d.value ?? [])
            .catch(() => [] as MsTask[]),
        ),
      );
      let tasks = results.flat();

      // Period filter: when a temporal context is given, only keep tasks WITH a due date in that period.
      // Tasks without due date are excluded — the user manages those separately.
      if (action.period) {
        tasks = tasks.filter((t) => isInPeriod(t.dueDateTime?.dateTime, action.period!));
      }

      // Sort by dueDateTime asc (tasks without due date go last).
      tasks.sort((a, b) => {
        const aTime = a.dueDateTime ? new Date(a.dueDateTime.dateTime).getTime() : Number.MAX_SAFE_INTEGER;
        const bTime = b.dueDateTime ? new Date(b.dueDateTime.dateTime).getTime() : Number.MAX_SAFE_INTEGER;
        return aTime - bTime;
      });

      if (tasks.length === 0) {
        if (action.period) {
          return `Tu n'as aucune tâche avec échéance ${periodFr(action.period)}.`;
        }
        return action.status === 'completed'
          ? 'Tu n\'as aucune tâche terminée dans tes listes.'
          : 'Tu n\'as aucune tâche en attente.';
      }

      const count = tasks.length;
      // Show more tasks when a period filter is active (all are relevant by definition).
      const displayMax = action.period ? 10 : 5;
      const displayed = tasks.slice(0, displayMax).map((t) => {
        const dueIso = t.dueDateTime?.dateTime.slice(0, 10);
        const isOverdue = dueIso && new Date(dueIso) < startOfDay(new Date());
        const due = dueIso
          ? isOverdue ? `, en retard depuis le ${formatDateFr(dueIso)}`
                      : action.period ? ''  // period gives context, avoid repeating date
                      : `, échéance ${formatDateFr(dueIso)}`
          : '';
        const imp = t.importance === 'high' ? ', urgente' : '';
        const rec = t.recurrence ? ', récurrente' : '';
        const statusLabel = t.status === 'inProgress' ? ', en cours'
          : t.status === 'deferred' ? ', différée'
          : t.status === 'waitingOnOthers' ? ', en attente'
          : '';
        return `${t.title}${due}${imp}${statusLabel}${rec}`;
      });
      const more = count > displayMax ? ` et ${count - displayMax} autre${count - displayMax > 1 ? 's' : ''}` : '';
      const periodLabel = action.period ? ` ${periodFr(action.period)}` : '';
      const intro = action.status === 'completed'
        ? `Tu as ${count} tâche${count > 1 ? 's' : ''} terminée${count > 1 ? 's' : ''}${periodLabel} :`
        : `Tu as ${count} tâche${count > 1 ? 's' : ''}${periodLabel} :`;
      return `${intro} ${joinFr(displayed)}${more}.`;
    }

    case 'add_task': {
      const list = await findList(token, action.list_name);
      if (!list) return `Je n'ai pas trouvé la liste ${action.list_name ?? 'par défaut'}.`;

      const body: Record<string, unknown> = { title: action.title };
      if (action.due_date) {
        body['dueDateTime'] = graphDateTime(action.due_date);
      }
      if (action.start_date) {
        body['startDateTime'] = graphDateTime(action.start_date);
      }
      if (action.reminder_date) {
        body['reminderDateTime'] = graphDateTime(action.reminder_date, normalizeReminderTime(action.reminder_date));
        body['isReminderOn'] = true;
      }
      if (action.importance) body['importance'] = action.importance;
      if (action.notes)      body['body'] = { contentType: 'text', content: action.notes };
      if (action.categories?.length) body['categories'] = action.categories;
      if (action.recurrence) {
        const startDate = action.due_date ?? new Date().toISOString().slice(0, 10);
        body['recurrence'] = buildRecurrence(action.recurrence, startDate);
      }

      await graphPost(`/me/todo/lists/${list.id}/tasks`, token, body);
      const parts: string[] = [];
      if (action.due_date)                     parts.push(`pour le ${formatDateFr(action.due_date)}`);
      if (action.importance === 'high')        parts.push('marquée urgente');
      if (action.recurrence)                   parts.push(recurrenceFr(action.recurrence));
      const suffix = parts.length ? `, ${parts.join(', ')}` : '';
      return `C'est noté. J'ai ajouté ${action.title} dans ta liste ${list.displayName}${suffix}.`;
    }

    case 'complete_task': {
      let list: MsTaskList | null;
      let task: MsTask | null;
      if (action.list_name) {
        list = await findList(token, action.list_name);
        if (!list) return 'Je n\'ai pas trouvé la liste de tâches.';
        task = await findTask(token, list.id, action.title);
        if (!task) return `Je n'ai pas trouvé de tâche correspondant à ${action.title}.`;
      } else {
        const matches = await findTaskMatchesAcrossWatchedLists(token, action.title);
        if (matches.length === 0) return `Je n'ai pas trouvé de tâche correspondant à ${action.title}.`;
        if (matches.length > 1) {
          const options = matches.slice(0, 3).map((match) => `${match.task.title} dans ${match.list.displayName}`);
          return `J'ai trouvé plusieurs tâches possibles. Dis-moi laquelle terminer : ${joinFr(options)}.`;
        }
        const found = matches[0]!;
        list = found.list; task = found.task;
      }
      await graphPatch(`/me/todo/lists/${list.id}/tasks/${task.id}`, token, { status: 'completed' });
      return `Parfait, ${task.title} est marquée comme terminée.`;
    }

    case 'delete_task': {
      let list: MsTaskList | null;
      let task: MsTask | null;
      if (action.list_name) {
        list = await findList(token, action.list_name);
        if (!list) return 'Je n\'ai pas trouvé la liste de tâches.';
        task = await findTask(token, list.id, action.title, true);
        if (!task) return `Je n'ai pas trouvé de tâche correspondant à ${action.title}.`;
      } else {
        const matches = await findTaskMatchesAcrossWatchedLists(token, action.title, true);
        if (matches.length === 0) return `Je n'ai pas trouvé de tâche correspondant à ${action.title}.`;
        if (matches.length > 1) {
          const options = matches.slice(0, 3).map((match) => `${match.task.title} dans ${match.list.displayName}`);
          return `J'ai trouvé plusieurs tâches possibles. Dis-moi laquelle supprimer : ${joinFr(options)}.`;
        }
        const found = matches[0]!;
        list = found.list; task = found.task;
      }
      await graphDelete(`/me/todo/lists/${list.id}/tasks/${task.id}`, token);
      return `La tâche ${task.title} a bien été supprimée.`;
    }

    case 'update_task': {
      let list: MsTaskList | null;
      let task: MsTask | null;
      if (action.list_name) {
        list = await findList(token, action.list_name);
        if (!list) return 'Je n\'ai pas trouvé la liste de tâches.';
        task = await findTask(token, list.id, action.title, true);
        if (!task) return `Je n'ai pas trouvé de tâche correspondant à ${action.title}.`;
      } else {
        const matches = await findTaskMatchesAcrossWatchedLists(token, action.title, true);
        if (matches.length === 0) return `Je n'ai pas trouvé de tâche correspondant à ${action.title}.`;
        if (matches.length > 1) {
          const options = matches.slice(0, 3).map((match) => `${match.task.title} dans ${match.list.displayName}`);
          return `J'ai trouvé plusieurs tâches possibles. Dis-moi laquelle modifier : ${joinFr(options)}.`;
        }
        const found = matches[0]!;
        list = found.list; task = found.task;
      }

      const patch: Record<string, unknown> = {};
      if (action.new_title)   patch['title']      = action.new_title;
      if (action.importance)  patch['importance'] = action.importance;
      if (action.status)      patch['status']     = action.status;
      // due_date: null clears the field, string sets it
      if (action.due_date === null) {
        patch['dueDateTime'] = null;
      } else if (action.due_date) {
        patch['dueDateTime'] = graphDateTime(action.due_date);
      }
      if (action.notes)       patch['body']        = { contentType: 'text', content: action.notes };
      if (action.categories)  patch['categories']  = action.categories;
      if (action.reminder_date) {
        patch['reminderDateTime'] = graphDateTime(action.reminder_date, normalizeReminderTime(action.reminder_date));
        patch['isReminderOn'] = true;
      }
      // recurrence: null removes it, object sets it
      if (action.recurrence === null) {
        patch['recurrence'] = null;
      } else if (action.recurrence) {
        const startDate = action.due_date ?? task.dueDateTime?.dateTime.slice(0, 10) ?? new Date().toISOString().slice(0, 10);
        patch['recurrence'] = buildRecurrence(action.recurrence, startDate);
      }
      if (Object.keys(patch).length === 0) return 'Tu n\'as pas précisé de modification.';

      await graphPatch(`/me/todo/lists/${list.id}/tasks/${task.id}`, token, patch);
      const updatedName = (patch['title'] as string | undefined) ?? task.title;
      // Build a specific confirmation based on what changed.
      const details: string[] = [];
      if (patch['title'])       details.push(`renommée en ${patch['title'] as string}`);
      if (patch['dueDateTime'] === null)     details.push('échéance supprimée');
      else if (patch['dueDateTime'])         details.push(`échéance fixée au ${formatDateFr(action.due_date as string)}`);
      if (patch['recurrence'] === null)      details.push('récurrence supprimée');
      else if (patch['recurrence'])          details.push(`récurrence mise à jour`);
      if (patch['reminderDateTime'])         details.push('rappel programmé');
      if (patch['importance'])               details.push(patch['importance'] === 'high' ? 'marquée urgente' : `importance ${patch['importance'] as string}`);
      if (patch['status']) {
        const statusFr: Record<string, string> = { notStarted: 'non commencée', inProgress: 'en cours', deferred: 'différée', waitingOnOthers: 'en attente' };
        details.push(statusFr[patch['status'] as string] ?? String(patch['status']));
      }
      if (patch['body'])        details.push('notes mises à jour');
      if (patch['categories'])  details.push('catégories mises à jour');
      const detailStr = details.length ? ` : ${joinFr(details)}` : '';
      return `C'est fait, ${updatedName} a été mise à jour${detailStr}.`;
    }

    case 'list_lists': {
      const data = await graphGet<{ value: MsTaskList[] }>('/me/todo/lists?$top=50', token);
      const lists = data.value ?? [];
      if (lists.length === 0) return 'Tu n\'as aucune liste de tâches pour le moment.';
      const names = lists.map((l) => l.displayName);
      return `Tu as ${lists.length} liste${lists.length > 1 ? 's' : ''} : ${joinFr(names)}.`;
    }

    case 'create_list': {
      await graphPost(`/me/todo/lists`, token, { displayName: action.name });
      return `La liste ${action.name} a bien été créée.`;
    }

    case 'delete_list': {
      const data = await graphGet<{ value: MsTaskList[] }>('/me/todo/lists', token);
      const lists = data.value ?? [];
      const needle = normalizeForMatch(action.name);
      const matches = lists.filter((l) => normalizeForMatch(l.displayName) === needle);
      if (matches.length === 0) return `Je n'ai pas trouvé de liste correspondant à ${action.name}.`;
      if (matches.length > 1) return `J'ai trouvé plusieurs listes nommées ${action.name}. Précise laquelle supprimer.`;
      const found = matches[0]!;
      // Built-in lists (defaultList, flaggedEmails) cannot be deleted.
      if (found.wellknownListName && found.wellknownListName !== 'none') {
        return `La liste ${found.displayName} est une liste système, je ne peux pas la supprimer.`;
      }
      await graphDelete(`/me/todo/lists/${found.id}`, token);
      return `La liste ${found.displayName} a bien été supprimée.`;
    }

    case 'add_checklist_item': {
      const list = await findList(token, action.list_name);
      if (!list) return 'Je n\'ai pas trouvé la liste de tâches.';

      const task = await findTask(token, list.id, action.task_title);
      if (!task) return `Je n'ai pas trouvé de tâche correspondant à ${action.task_title}.`;

      await graphPost(
        `/me/todo/lists/${list.id}/tasks/${task.id}/checklistItems`,
        token,
        { displayName: action.item_title },
      );
      return `J'ai ajouté ${action.item_title} dans la tâche ${task.title}.`;
    }

    case 'complete_checklist_item': {
      const list = await findList(token, action.list_name);
      if (!list) return 'Je n\'ai pas trouvé la liste de tâches.';
      const task = await findTask(token, list.id, action.task_title);
      if (!task) return `Je n'ai pas trouvé de tâche correspondant à ${action.task_title}.`;

      const checkData = await graphGet<{ value: MsChecklistItem[] }>(
        `/me/todo/lists/${list.id}/tasks/${task.id}/checklistItems`,
        token,
      );
      const needle = normalizeForMatch(action.item_title);
      const item = checkData.value?.find((c) => normalizeForMatch(c.displayName) === needle);
      if (!item) return `Je n'ai pas trouvé ${action.item_title} dans la tâche ${task.title}.`;
      await graphPatch(`/me/todo/lists/${list.id}/tasks/${task.id}/checklistItems/${item.id}`, token, { isChecked: true });
      return `Parfait, ${item.displayName} est cochée dans ${task.title}.`;
    }

    case 'delete_checklist_item': {
      const list = await findList(token, action.list_name);
      if (!list) return 'Je n\'ai pas trouvé la liste de tâches.';
      const task = await findTask(token, list.id, action.task_title);
      if (!task) return `Je n'ai pas trouvé de tâche correspondant à ${action.task_title}.`;

      const checkData = await graphGet<{ value: MsChecklistItem[] }>(
        `/me/todo/lists/${list.id}/tasks/${task.id}/checklistItems`,
        token,
      );
      const needle = normalizeForMatch(action.item_title);
      const matches = (checkData.value ?? []).filter((c) => normalizeForMatch(c.displayName) === needle);
      if (matches.length === 0) return `Je n'ai pas trouvé ${action.item_title} dans la tâche ${task.title}.`;
      if (matches.length > 1) return `J'ai trouvé plusieurs éléments ${action.item_title} dans ${task.title}. Précise lequel supprimer.`;
      const item = matches[0]!;
      await graphDelete(`/me/todo/lists/${list.id}/tasks/${task.id}/checklistItems/${item.id}`, token);
      return `${item.displayName} a bien été supprimée de ${task.title}.`;
    }

    default:
      return 'Je ne reconnais pas cette action.';
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Returns true for HA_AGENT_MAP keys that should be handled by this todo agent.
 * Mirrors isSearchAgentKey() from search/agents.ts.
 */
export async function executeTodoAgentAction(
  action: TodoAction,
  env: TodoEnv,
  options?: { userText?: string; log?: MinLogger },
): Promise<string> {
  if (!env.MICROSOFT_CLIENT_ID || !env.MICROSOFT_CLIENT_SECRET || !env.MICROSOFT_REFRESH_TOKEN) {
    return 'La gestion des taches n est pas disponible, les identifiants Microsoft ne sont pas configures.';
  }
  if (!env.OPENAI_API_KEY) return 'Je ne peux pas gerer les taches pour l instant, la cle OpenAI est manquante.';

  let token: string;
  try {
    token = await refreshMicrosoftToken({
      MICROSOFT_TENANT_ID:     env.MICROSOFT_TENANT_ID,
      MICROSOFT_CLIENT_ID:     env.MICROSOFT_CLIENT_ID,
      MICROSOFT_CLIENT_SECRET: env.MICROSOFT_CLIENT_SECRET,
      MICROSOFT_REFRESH_TOKEN: env.MICROSOFT_REFRESH_TOKEN,
      cacheKey:                `todo:${env.MICROSOFT_CLIENT_ID}`,
      storeKey:                `todo:microsoft:${env.MICROSOFT_CLIENT_ID}`,
      OAUTH_REFRESH_TOKEN_STORE_PATH: env.OAUTH_REFRESH_TOKEN_STORE_PATH,
    });
  } catch (err) {
    options?.log?.warn({ err: String(err) }, 'todo_agent_token_error');
    return 'Je ne peux pas acceder a Microsoft To Do pour le moment, le token d authentification a expire ou est invalide.';
  }

  const rawResult = await executeTodo(action, token);
  options?.log?.info({ action: action.action, result_len: rawResult.length }, 'todo_agent_done');
  if (action.action === 'list_tasks') return compactTodoListForFallback(rawResult);
  return synthesizeTodoReplyWithOpenAi({
    openAiApiKey: env.OPENAI_API_KEY,
    openAiBaseUrl: env.OPENAI_BASE_URL,
    model: env.OPENAI_MODEL_SUMMARY ?? 'gpt-4o-mini',
    timeoutMs: env.OPENAI_TIMEOUT_MS,
    userText: options?.userText ?? action.action,
    executorResult: rawResult,
  });
}

export function isTodoAgentKey(key: string | undefined): key is string {
  if (!key) return false;
  return key === 'todo' || key.startsWith('todo.');
}

/**
 * Main entry point — call from ingest.ts specialized task pipeline.
 *
 * Mirrors callSearchAgent(): takes user text + env subset → returns TTS string.
 */
export async function callTodoAgent(
  text: string,
  env: TodoEnv,
  log?: MinLogger,
): Promise<string> {
  if (!env.MICROSOFT_CLIENT_ID || !env.MICROSOFT_CLIENT_SECRET || !env.MICROSOFT_REFRESH_TOKEN) {
    return 'La gestion des tâches n\'est pas disponible, les identifiants Microsoft ne sont pas configurés.';
  }
  if (!env.OPENAI_API_KEY) {
    return 'Je ne peux pas gérer les tâches pour l\'instant, la clé OpenAI est manquante.';
  }

  let action: TodoAction;
  try {
    action = await planTodoAction(
      text, env.OPENAI_API_KEY, env.OPENAI_BASE_URL, env.OPENAI_TIMEOUT_MS,
    );
  } catch (err) {
    log?.warn({ err: String(err) }, 'todo_agent_planner_error');
    return 'Désolé, je n\'ai pas compris cette demande de tâche. Tu peux réessayer différemment.';
  }

  // Guardrail: if planner omits period on a temporal list request, infer it deterministically.
  if (action.action === 'list_tasks' && !action.period) {
    const inferred = inferListTasksPeriodFromText(text);
    if (inferred) {
      action = { ...action, period: inferred };
      log?.info({ inferred_period: inferred }, 'todo_agent_period_inferred');
    }
  }

log?.info({ action: action.action, due_date: (action as Record<string,unknown>).due_date, reminder_date: (action as Record<string,unknown>).reminder_date }, 'todo_agent_planned');

  let token: string;
  try {
    token = await refreshMicrosoftToken({
      MICROSOFT_TENANT_ID:     env.MICROSOFT_TENANT_ID,
      MICROSOFT_CLIENT_ID:     env.MICROSOFT_CLIENT_ID,
      MICROSOFT_CLIENT_SECRET: env.MICROSOFT_CLIENT_SECRET,
      MICROSOFT_REFRESH_TOKEN: env.MICROSOFT_REFRESH_TOKEN,
      cacheKey:                `todo:${env.MICROSOFT_CLIENT_ID}`,
      storeKey:                `todo:microsoft:${env.MICROSOFT_CLIENT_ID}`,
      OAUTH_REFRESH_TOKEN_STORE_PATH: env.OAUTH_REFRESH_TOKEN_STORE_PATH,
    });
  } catch (err) {
    log?.warn({ err: String(err) }, 'todo_agent_token_error');
    return 'Je ne peux pas accéder à Microsoft To Do pour le moment, le token d\'authentification a expiré ou est invalide.';
  }

  try {
    const rawResult = await executeTodo(action, token);
    log?.info({ action: action.action, result_len: rawResult.length }, 'todo_agent_done');

    // For list reads, keep deterministic executor output to avoid synthesis drift/hallucinations
    // (e.g. inventing timelines that are not in the filtered result set).
    if (action.action === 'list_tasks') {
      return compactTodoListForFallback(rawResult);
    }

    const synthesized = await synthesizeTodoReplyWithOpenAi({
      openAiApiKey:  env.OPENAI_API_KEY!,
      openAiBaseUrl: env.OPENAI_BASE_URL,
      model:         env.OPENAI_MODEL_SUMMARY ?? 'gpt-4o-mini',
      timeoutMs:     env.OPENAI_TIMEOUT_MS,
      userText:      text,
      executorResult: rawResult,
    });
    return synthesized;
  } catch (err) {
    log?.warn({ err: String(err), action: action.action }, 'todo_agent_execute_error');
    return 'Une erreur s\'est produite lors de l\'accès à Microsoft To Do. Réessaie dans un instant.';
  }
}
