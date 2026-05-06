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

type ListTasksAction           = { action: 'list_tasks';              list_name?: string; status?: 'active' | 'completed' | 'all' };
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

type TodoAction =
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
};

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
const KEEPALIVE_INTERVAL_MS  = 30 * 24 * 3_600_000; // 30 days — resets inactivity window

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
  if (!_msKeepaliveScheduled.has(cacheKey)) {
    _msKeepaliveScheduled.add(cacheKey);
    const timer = setInterval(() => {
      _msTokenCache.delete(cacheKey); // force a real token call
      refreshMicrosoftToken(env).catch(() => { /* keep-alive failure is non-fatal */ });
    }, KEEPALIVE_INTERVAL_MS);
    // Do not keep the Node.js process alive solely for this timer.
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

// ─── List & task finders ──────────────────────────────────────────────────────

async function findList(token: string, listName?: string): Promise<MsTaskList | null> {
  const data = await graphGet<{ value: MsTaskList[] }>('/me/todo/lists', token);
  const lists = data.value ?? [];
  if (!listName) {
    // Prefer the built-in default list (wellknownListName === 'defaultList'),
    // then fall back to display-name heuristic, then first list.
    return (
      lists.find((l) => l.wellknownListName === 'defaultList') ??
      lists.find((l) => /^(tasks?|t[âa]ches?)$/i.test(l.displayName.trim())) ??
      lists[0] ??
      null
    );
  }
  const needle = listName.toLowerCase();
  return lists.find((l) => l.displayName.toLowerCase().includes(needle)) ?? null;
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
  const needle = title.toLowerCase();
  // Exact match first, then partial
  return (
    tasks.find((t) => t.title.toLowerCase() === needle) ??
    tasks.find((t) => t.title.toLowerCase().includes(needle)) ??
    null
  );
}

// ─── LLM planner ─────────────────────────────────────────────────────────────

const _PLANNER_SYSTEM = `Tu es un assistant de gestion de tâches (Microsoft To Do).
Analyse la commande vocale en français et retourne un JSON correspondant à une seule action.

Champ obligatoire "action" parmi :
  list_tasks | add_task | complete_task | delete_task | update_task
  list_lists | create_list | delete_list
  add_checklist_item | complete_checklist_item | delete_checklist_item

Champs conditionnels (selon l'action) :
  list_tasks              → "list_name" (optionnel), "status" ("active"|"completed"|"all", défaut "active")
  add_task                → "title" (obligatoire), "list_name" (optionnel),
                            "due_date" (YYYY-MM-DD, optionnel), "start_date" (YYYY-MM-DD, optionnel),
                            "reminder_date" (YYYY-MM-DDTHH:MM, optionnel),
                            "importance" ("low"|"normal"|"high", optionnel),
                            "notes" (string, optionnel),
                            "categories" (string[], optionnel — ex: ["Travail","Urgent"]),
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
      max_tokens: 200,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: _PLANNER_SYSTEM },
        { role: 'user',   content: text },
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
      const list = await findList(token, action.list_name);
      if (!list) return 'Aucune liste de tâches trouvée dans Microsoft To Do.';

      // Sort active tasks by due date ascending (soonest first), completed by completedDateTime desc.
      let qs: string;
      if (action.status === 'completed') {
        qs = `$filter=status eq 'completed'&$orderby=lastModifiedDateTime desc&$top=10`;
      } else if (action.status === 'all') {
        qs = `$top=20`;
      } else {
        qs = `$filter=status ne 'completed'&$top=20`;
      }
      const data = await graphGet<{ value: MsTask[] }>(
        `/me/todo/lists/${list.id}/tasks?${qs}`,
        token,
      );
      const tasks = data.value ?? [];

      // Sort active tasks: overdue first, then by dueDateTime asc, then no-due last.
      if (action.status !== 'completed') {
        tasks.sort((a, b) => {
          const aTime = a.dueDateTime ? new Date(a.dueDateTime.dateTime).getTime() : Number.MAX_SAFE_INTEGER;
          const bTime = b.dueDateTime ? new Date(b.dueDateTime.dateTime).getTime() : Number.MAX_SAFE_INTEGER;
          return aTime - bTime;
        });
      }

      if (tasks.length === 0) {
        return action.status === 'completed'
          ? `Aucune tâche terminée dans "${list.displayName}".`
          : `Aucune tâche en attente dans la liste "${list.displayName}".`;
      }
      const count = tasks.length;
      const titles = tasks.slice(0, 5).map((t) => {
        const due = t.dueDateTime ? `, échéance le ${t.dueDateTime.dateTime.slice(0, 10)}` : '';
        const imp = t.importance === 'high' ? ', urgente' : '';
        const rec = t.recurrence ? ', récurrente' : '';
        const cat = t.categories?.length ? `, [${t.categories.join(', ')}]` : '';
        return `${t.title}${due}${imp}${rec}${cat}`;
      }).join(' ; ');
      const more = count > 5 ? ` et ${count - 5} autre${count - 5 > 1 ? 's' : ''}` : '';
      return `Tu as ${count} tâche${count > 1 ? 's' : ''} dans "${list.displayName}" : ${titles}${more}.`;
    }

    case 'add_task': {
      const list = await findList(token, action.list_name);
      if (!list) return `Impossible de trouver la liste "${action.list_name ?? 'par défaut'}".`;

      const body: Record<string, unknown> = { title: action.title };
      if (action.due_date) {
        body['dueDateTime'] = { dateTime: `${action.due_date}T00:00:00.000Z`, timeZone: 'UTC' };
      }
      if (action.start_date) {
        body['startDateTime'] = { dateTime: `${action.start_date}T00:00:00.000Z`, timeZone: 'UTC' };
      }
      if (action.reminder_date) {
        const dt = action.reminder_date.includes('T') ? action.reminder_date : `${action.reminder_date}T09:00`;
        body['reminderDateTime'] = { dateTime: `${dt}:00.000000`, timeZone: 'UTC' };
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
      const dateClause = action.due_date ? ` pour le ${action.due_date}` : '';
      const impClause  = action.importance === 'high' ? ', marquée urgente' : '';
      const recClause  = action.recurrence ? `, récurrente (${action.recurrence.type})` : '';
      return `Tâche "${action.title}" ajoutée dans "${list.displayName}"${dateClause}${impClause}${recClause}.`;
    }

    case 'complete_task': {
      const list = await findList(token, action.list_name);
      if (!list) return 'Liste de tâches introuvable.';

      const task = await findTask(token, list.id, action.title);
      if (!task) return `Aucune tâche correspondant à "${action.title}" trouvée.`;

      await graphPatch(`/me/todo/lists/${list.id}/tasks/${task.id}`, token, { status: 'completed' });
      return `Tâche "${task.title}" marquée comme terminée.`;
    }

    case 'delete_task': {
      const list = await findList(token, action.list_name);
      if (!list) return 'Liste de tâches introuvable.';

      const task = await findTask(token, list.id, action.title, true);
      if (!task) return `Aucune tâche correspondant à "${action.title}" trouvée.`;

      await graphDelete(`/me/todo/lists/${list.id}/tasks/${task.id}`, token);
      return `Tâche "${task.title}" supprimée.`;
    }

    case 'update_task': {
      const list = await findList(token, action.list_name);
      if (!list) return 'Liste de tâches introuvable.';

      const task = await findTask(token, list.id, action.title, true);
      if (!task) return `Aucune tâche correspondant à "${action.title}" trouvée.`;

      const patch: Record<string, unknown> = {};
      if (action.new_title)   patch['title']      = action.new_title;
      if (action.importance)  patch['importance'] = action.importance;
      if (action.status)      patch['status']     = action.status;
      // due_date: null clears the field, string sets it
      if (action.due_date === null) {
        patch['dueDateTime'] = null;
      } else if (action.due_date) {
        patch['dueDateTime'] = { dateTime: `${action.due_date}T00:00:00.000Z`, timeZone: 'UTC' };
      }
      if (action.notes)       patch['body']        = { contentType: 'text', content: action.notes };
      if (action.categories)  patch['categories']  = action.categories;
      if (action.reminder_date) {
        const dt = action.reminder_date.includes('T') ? action.reminder_date : `${action.reminder_date}T09:00`;
        patch['reminderDateTime'] = { dateTime: `${dt}:00.000000`, timeZone: 'UTC' };
        patch['isReminderOn'] = true;
      }
      // recurrence: null removes it, object sets it
      if (action.recurrence === null) {
        patch['recurrence'] = null;
      } else if (action.recurrence) {
        const startDate = action.due_date ?? task.dueDateTime?.dateTime.slice(0, 10) ?? new Date().toISOString().slice(0, 10);
        patch['recurrence'] = buildRecurrence(action.recurrence, startDate);
      }
      if (Object.keys(patch).length === 0) return 'Aucune modification spécifiée.';

      await graphPatch(`/me/todo/lists/${list.id}/tasks/${task.id}`, token, patch);
      const updatedName = (patch['title'] as string | undefined) ?? task.title;
      return `Tâche "${updatedName}" mise à jour.`;
    }

    case 'list_lists': {
      const data = await graphGet<{ value: MsTaskList[] }>('/me/todo/lists?$top=50', token);
      const lists = data.value ?? [];
      if (lists.length === 0) return 'Tu n\'as aucune liste de tâches.';
      const names = lists.map((l) => l.displayName);
      return `Tu as ${lists.length} liste${lists.length > 1 ? 's' : ''} : ${names.join(', ')}.`;
    }

    case 'create_list': {
      await graphPost(`/me/todo/lists`, token, { displayName: action.name });
      return `Liste "${action.name}" créée.`;
    }

    case 'delete_list': {
      const data = await graphGet<{ value: MsTaskList[] }>('/me/todo/lists', token);
      const lists = data.value ?? [];
      const needle = action.name.toLowerCase();
      const found = lists.find((l) => l.displayName.toLowerCase().includes(needle));
      if (!found) return `Aucune liste correspondant à "${action.name}" trouvée.`;
      // Built-in lists (defaultList, flaggedEmails) cannot be deleted.
      if (found.wellknownListName && found.wellknownListName !== 'none') {
        return `La liste "${found.displayName}" est une liste système et ne peut pas être supprimée.`;
      }
      await graphDelete(`/me/todo/lists/${found.id}`, token);
      return `Liste "${found.displayName}" supprimée.`;
    }

    case 'add_checklist_item': {
      const list = await findList(token, action.list_name);
      if (!list) return 'Liste de tâches introuvable.';

      const task = await findTask(token, list.id, action.task_title);
      if (!task) return `Aucune tâche correspondant à "${action.task_title}" trouvée.`;

      await graphPost(
        `/me/todo/lists/${list.id}/tasks/${task.id}/checklistItems`,
        token,
        { displayName: action.item_title },
      );
      return `Sous-tâche "${action.item_title}" ajoutée à "${task.title}".`;
    }

    case 'complete_checklist_item': {
      const list = await findList(token, action.list_name);
      if (!list) return 'Liste de tâches introuvable.';
      const task = await findTask(token, list.id, action.task_title);
      if (!task) return `Aucune tâche correspondant à "${action.task_title}" trouvée.`;

      const checkData = await graphGet<{ value: MsChecklistItem[] }>(
        `/me/todo/lists/${list.id}/tasks/${task.id}/checklistItems`,
        token,
      );
      const needle = action.item_title.toLowerCase();
      const item = checkData.value?.find((c) => c.displayName.toLowerCase().includes(needle));
      if (!item) return `Sous-tâche "${action.item_title}" introuvable dans "${task.title}".`;
      await graphPatch(`/me/todo/lists/${list.id}/tasks/${task.id}/checklistItems/${item.id}`, token, { isChecked: true });
      return `Sous-tâche "${item.displayName}" marquée comme terminée.`;
    }

    case 'delete_checklist_item': {
      const list = await findList(token, action.list_name);
      if (!list) return 'Liste de tâches introuvable.';
      const task = await findTask(token, list.id, action.task_title);
      if (!task) return `Aucune tâche correspondant à "${action.task_title}" trouvée.`;

      const checkData = await graphGet<{ value: MsChecklistItem[] }>(
        `/me/todo/lists/${list.id}/tasks/${task.id}/checklistItems`,
        token,
      );
      const needle = action.item_title.toLowerCase();
      const item = checkData.value?.find((c) => c.displayName.toLowerCase().includes(needle));
      if (!item) return `Sous-tâche "${action.item_title}" introuvable dans "${task.title}".`;
      await graphDelete(`/me/todo/lists/${list.id}/tasks/${task.id}/checklistItems/${item.id}`, token);
      return `Sous-tâche "${item.displayName}" supprimée de "${task.title}".`;
    }

    default:
      return 'Action todo non reconnue.';
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Returns true for HA_AGENT_MAP keys that should be handled by this todo agent.
 * Mirrors isSearchAgentKey() from search/agents.ts.
 */
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
    return 'La gestion des tâches n\'est pas configurée (identifiants Microsoft manquants).';
  }
  if (!env.OPENAI_API_KEY) {
    return 'Agent todo non disponible : clé OpenAI manquante.';
  }

  const action = await planTodoAction(
    text, env.OPENAI_API_KEY, env.OPENAI_BASE_URL, env.OPENAI_TIMEOUT_MS,
  );
  log?.info({ action: action.action }, 'todo_agent_planned');

  const token = await refreshMicrosoftToken({
    MICROSOFT_TENANT_ID:     env.MICROSOFT_TENANT_ID,
    MICROSOFT_CLIENT_ID:     env.MICROSOFT_CLIENT_ID,
    MICROSOFT_CLIENT_SECRET: env.MICROSOFT_CLIENT_SECRET,
    MICROSOFT_REFRESH_TOKEN: env.MICROSOFT_REFRESH_TOKEN,
    cacheKey:                `todo:${env.MICROSOFT_CLIENT_ID}`,
    storeKey:                `todo:microsoft:${env.MICROSOFT_CLIENT_ID}`,
    OAUTH_REFRESH_TOKEN_STORE_PATH: env.OAUTH_REFRESH_TOKEN_STORE_PATH,
  });

  const result = await executeTodo(action, token);
  log?.info({ action: action.action, result_len: result.length }, 'todo_agent_done');
  return result;
}
