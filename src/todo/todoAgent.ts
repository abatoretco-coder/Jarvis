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

// ─── Action types ─────────────────────────────────────────────────────────────

type ListTasksAction    = { action: 'list_tasks';          list_name?: string; status?: 'active' | 'completed' | 'all' };
type AddTaskAction      = { action: 'add_task';             title: string; list_name?: string; due_date?: string; start_date?: string; reminder_date?: string; importance?: 'low' | 'normal' | 'high'; notes?: string };
type CompleteAction     = { action: 'complete_task';        title: string; list_name?: string };
type DeleteAction       = { action: 'delete_task';          title: string; list_name?: string };
type UpdateTaskAction   = { action: 'update_task';          title: string; list_name?: string; new_title?: string; due_date?: string; importance?: 'low' | 'normal' | 'high'; status?: 'notStarted' | 'inProgress' | 'deferred' | 'waitingOnOthers'; notes?: string; reminder_date?: string };
type ListListsAction    = { action: 'list_lists' };
type CreateListAction   = { action: 'create_list';          name: string };
type AddChecklistAction = { action: 'add_checklist_item';   task_title: string; item_title: string; list_name?: string };

type TodoAction = ListTasksAction | AddTaskAction | CompleteAction | DeleteAction | UpdateTaskAction | ListListsAction | CreateListAction | AddChecklistAction;

// ─── Minimal env surface ──────────────────────────────────────────────────────

export type TodoEnv = {
  MICROSOFT_CLIENT_ID?: string;
  MICROSOFT_CLIENT_SECRET?: string;
  MICROSOFT_REFRESH_TOKEN?: string;
  MICROSOFT_TENANT_ID?: string;
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
}): Promise<string> {
  const cacheKey = env.MICROSOFT_CLIENT_ID;
  const cached = _msTokenCache.get(cacheKey);
  if (cached && Date.now() < cached.expiresAt) return cached.accessToken;

  // Use the latest rotated refresh token if we have one; fall back to env.
  const refreshToken = _msLiveRefreshToken.get(cacheKey) ?? env.MICROSOFT_REFRESH_TOKEN;
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
  if (data.refresh_token) _msLiveRefreshToken.set(cacheKey, data.refresh_token);

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
  dueDateTime?:      { dateTime: string; timeZone: string } | null;
  startDateTime?:    { dateTime: string; timeZone: string } | null;
  reminderDateTime?: { dateTime: string; timeZone: string } | null;
  isReminderOn?: boolean;
  body?: { content: string; contentType: string } | null;
  createdDateTime?: string;
}

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
    // Default: prefer the standard "Tasks" / "Tâches" list, otherwise first list.
    return lists.find((l) => /^(tasks?|t[âa]ches?)$/i.test(l.displayName.trim())) ?? lists[0] ?? null;
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
  list_tasks | add_task | complete_task | delete_task | update_task | list_lists | create_list | add_checklist_item

Champs conditionnels (selon l'action) :
  list_tasks         → "list_name" (string, optionnel), "status" ("active"|"completed"|"all", défaut "active")
  add_task           → "title" (obligatoire), "list_name" (optionnel), "due_date" (YYYY-MM-DD, optionnel),
                       "start_date" (YYYY-MM-DD, optionnel), "reminder_date" (YYYY-MM-DDTHH:MM, optionnel),
                       "importance" ("low"|"normal"|"high", optionnel), "notes" (string, optionnel)
  complete_task      → "title" (obligatoire), "list_name" (optionnel)
  delete_task        → "title" (obligatoire), "list_name" (optionnel)
  update_task        → "title" (titre actuel, obligatoire), "list_name" (optionnel),
                       "new_title" (optionnel), "due_date" (YYYY-MM-DD, optionnel),
                       "importance" ("low"|"normal"|"high", optionnel),
                       "status" ("notStarted"|"inProgress"|"deferred"|"waitingOnOthers", optionnel),
                       "notes" (string, optionnel), "reminder_date" (YYYY-MM-DDTHH:MM, optionnel)
  list_lists         → (aucun champ supplémentaire)
  create_list        → "name" (obligatoire)
  add_checklist_item → "task_title" (tâche parente, obligatoire), "item_title" (sous-tâche, obligatoire), "list_name" (optionnel)

Réponds UNIQUEMENT avec du JSON valide, sans texte supplémentaire.
Exemples :
  "montre mes tâches"                              → {"action":"list_tasks"}
  "tâches terminées"                               → {"action":"list_tasks","status":"completed"}
  "ajoute acheter du pain"                         → {"action":"add_task","title":"Acheter du pain"}
  "tâche urgente : appeler le médecin"             → {"action":"add_task","title":"Appeler le médecin","importance":"high"}
  "rappelle-moi appeler le médecin lundi matin"    → {"action":"add_task","title":"Appeler le médecin","reminder_date":"<YYYY-MM-DDT09:00>"}
  "marque faire la vaisselle comme fait"           → {"action":"complete_task","title":"faire la vaisselle"}
  "supprime la tâche courses"                      → {"action":"delete_task","title":"courses"}
  "change l'échéance de réunion au 15 mars"        → {"action":"update_task","title":"réunion","due_date":"<YYYY-03-15>"}
  "mets la tâche rapport en cours"                 → {"action":"update_task","title":"rapport","status":"inProgress"}
  "affiche mes listes"                             → {"action":"list_lists"}
  "crée une liste Vacances"                        → {"action":"create_list","name":"Vacances"}
  "ajoute la sous-tâche Réserver hôtel à Vacances" → {"action":"add_checklist_item","task_title":"Vacances","item_title":"Réserver hôtel"}
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

// ─── Executor ─────────────────────────────────────────────────────────────────

async function executeTodo(action: TodoAction, token: string): Promise<string> {
  switch (action.action) {
    case 'list_tasks': {
      const list = await findList(token, action.list_name);
      if (!list) return 'Aucune liste de tâches trouvée dans Microsoft To Do.';

      let qs: string;
      if (action.status === 'completed') {
        qs = `$filter=status eq 'completed'&$orderby=createdDateTime desc&$top=10`;
      } else if (action.status === 'all') {
        qs = `$orderby=createdDateTime desc&$top=20`;
      } else {
        qs = `$filter=status ne 'completed'&$orderby=createdDateTime desc&$top=10`;
      }
      const data = await graphGet<{ value: MsTask[] }>(
        `/me/todo/lists/${list.id}/tasks?${qs}`,
        token,
      );
      const tasks = data.value ?? [];
      if (tasks.length === 0) {
        return action.status === 'completed'
          ? `Aucune tâche terminée dans "${list.displayName}".`
          : `Aucune tâche en attente dans la liste "${list.displayName}".`;
      }
      const count = tasks.length;
      const titles = tasks.slice(0, 5).map((t) => {
        const due = t.dueDateTime ? `, échéance le ${t.dueDateTime.dateTime.slice(0, 10)}` : '';
        const imp = t.importance === 'high' ? ', urgente' : '';
        return `${t.title}${due}${imp}`;
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

      await graphPost(`/me/todo/lists/${list.id}/tasks`, token, body);
      const dateClause = action.due_date ? ` pour le ${action.due_date}` : '';
      const impClause  = action.importance === 'high' ? ', marquée urgente' : '';
      return `Tâche "${action.title}" ajoutée dans "${list.displayName}"${dateClause}${impClause}.`;
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
      if (action.due_date)    patch['dueDateTime'] = { dateTime: `${action.due_date}T00:00:00.000Z`, timeZone: 'UTC' };
      if (action.notes)       patch['body']        = { contentType: 'text', content: action.notes };
      if (action.reminder_date) {
        const dt = action.reminder_date.includes('T') ? action.reminder_date : `${action.reminder_date}T09:00`;
        patch['reminderDateTime'] = { dateTime: `${dt}:00.000000`, timeZone: 'UTC' };
        patch['isReminderOn'] = true;
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
  });

  const result = await executeTodo(action, token);
  log?.info({ action: action.action, result_len: result.length }, 'todo_agent_done');
  return result;
}
