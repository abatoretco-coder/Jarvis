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
import { completeOpenAiResponse } from '../openai/responsesClient';
import { buildTodoSynthesisSystemPrompt } from './prompts/todoSynthesisSystemPrompt';
import { buildTodoSynthesisUserPrompt } from './prompts/todoSynthesisUserTemplate';

const TODO_SYNTHESIS_SYSTEM_PROMPT = buildTodoSynthesisSystemPrompt();

/** Returns the first sentence of a TTS-friendly string, capped at maxChars. */
function firstSentence(text: string, maxChars = 140): string {
  const m = text.match(/^[^.!?]+[.!?]/);
  const s = m ? m[0] : text;
  return s.length > maxChars ? s.slice(0, maxChars).trimEnd() + '…' : s;
}

export function compactTodoListForFallback(text: string): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (!clean) return clean;

  // Extract a concise intro + at most 5 listed tasks when the payload is very long.
  const match = clean.match(/^(Tu as\s+\d+\s+tâche[s]?.*?:)\s*(.+)\.$/i);
  if (match) {
    const intro = match[1] ?? 'Voici tes tâches :';
    const body = match[2] ?? '';
    if (/aujourd['’]hui/iu.test(intro)) return clean;
    const parts = body
      .split(/\s*;\s*/u)
      .map((x) => x.trim())
      .filter(Boolean);

    if (parts.length > 5) {
      const shown = parts.slice(0, 5);
      const remaining = parts.length - shown.length;
      return `${intro} ${shown.join(', ')} et ${remaining} autre${remaining > 1 ? 's' : ''}.`;
    }
    return clean;
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
  credentialKey?: string;
  onRefreshToken?: (token: string) => Promise<void> | void;
  onConnectionError?: (code: string, terminal: boolean) => Promise<void> | void;
  onConnectionHealthy?: () => Promise<void> | void;
  OPENAI_API_KEY?: string;
  OPENAI_BASE_URL: string;
  OPENAI_TIMEOUT_MS: number;
  OPENAI_MODEL_SUMMARY?: string;
  OPENAI_MODEL_AGENT?: string;
  OPENAI_MODEL_SYNTHESIS?: string;
  OPENAI_MAX_OUTPUT_TOKENS_AGENT?: number;
  OPENAI_MAX_OUTPUT_TOKENS_SYNTHESIS?: number;
};

async function synthesizeTodoReplyWithOpenAi(params: {
  openAiApiKey: string;
  openAiBaseUrl: string;
  model: string;
  maxOutputTokens?: number;
  timeoutMs: number;
  userText: string;
  executorResult: string;
}): Promise<string> {
  try {
    return await completeOpenAiResponse({
      apiKey: params.openAiApiKey,
      baseUrl: params.openAiBaseUrl,
      model: params.model,
      capability: 'synthesis',
      messages: [
        { role: 'system', content: TODO_SYNTHESIS_SYSTEM_PROMPT },
        { role: 'user', content: buildTodoSynthesisUserPrompt(params.userText, params.executorResult) },
      ],
      maxOutputTokens: Math.min(240, params.maxOutputTokens ?? 768),
      timeoutMs: params.timeoutMs,
      reasoningEffort: 'low',
    });
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
//   2. Refresh token replacement: if Microsoft returns a new refresh_token, it is
//      durably stored before later calls use it.
//   3. Single-flight refresh: concurrent requests in one process share one exchange.
//   4. Keep-alive is only a best-effort optimization. Expiry and revocation remain
//      normal OAuth states and are surfaced to the integration connection.

interface CachedToken { accessToken: string; expiresAt: number }
const _msTokenCache          = new Map<string, CachedToken>();
const _msLiveRefreshToken    = new Map<string, string>(); // captures rotated refresh tokens
const _msRefreshInFlight     = new Map<string, Promise<string>>();
const _msKeepaliveTimers     = new Map<string, ReturnType<typeof setInterval>>();
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
  onRefreshToken?: (token: string) => Promise<void> | void;
  onConnectionError?: (code: string, terminal: boolean) => Promise<void> | void;
  onConnectionHealthy?: () => Promise<void> | void;
  onDiagnostic?: (code: string) => void;
}): Promise<string> {
  const cacheKey = env.cacheKey?.trim() || env.MICROSOFT_CLIENT_ID;
  const cached = _msTokenCache.get(cacheKey);
  if (cached && Date.now() < cached.expiresAt) return cached.accessToken;
  const inFlight = _msRefreshInFlight.get(cacheKey);
  if (inFlight) return inFlight;

  const refresh = refreshMicrosoftTokenUncached(env, cacheKey).finally(() => {
    if (_msRefreshInFlight.get(cacheKey) === refresh) _msRefreshInFlight.delete(cacheKey);
  });
  _msRefreshInFlight.set(cacheKey, refresh);
  return refresh;
}

async function refreshMicrosoftTokenUncached(env: {
  MICROSOFT_TENANT_ID?: string;
  MICROSOFT_CLIENT_ID: string;
  MICROSOFT_CLIENT_SECRET: string;
  MICROSOFT_REFRESH_TOKEN: string;
  cacheKey?: string;
  storeKey?: string;
  OAUTH_REFRESH_TOKEN_STORE_PATH?: string;
  onRefreshToken?: (token: string) => Promise<void> | void;
  onConnectionError?: (code: string, terminal: boolean) => Promise<void> | void;
  onConnectionHealthy?: () => Promise<void> | void;
  onDiagnostic?: (code: string) => void;
}, cacheKey: string): Promise<string> {
  const cached = _msTokenCache.get(cacheKey);
  if (cached && Date.now() < cached.expiresAt) return cached.accessToken;
  const storeKey = env.storeKey?.trim() || `todo:microsoft:${env.MICROSOFT_CLIENT_ID}`;

  // Use the latest rotated refresh token if we have one; fall back to env.
  const refreshToken =
    _msLiveRefreshToken.get(cacheKey)
    ?? await getStoredRefreshToken(env.OAUTH_REFRESH_TOKEN_STORE_PATH, storeKey)
    ?? env.MICROSOFT_REFRESH_TOKEN;
  const tenantId = env.MICROSOFT_TENANT_ID?.trim() || 'common';
  let resp: Response;
  try {
    resp = await fetch(
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
  } catch (error) {
    await env.onConnectionError?.('token_endpoint_unreachable', false);
    env.onDiagnostic?.('token_endpoint_unreachable');
    throw error;
  }
  if (!resp.ok) {
    _msTokenCache.delete(cacheKey);
    const body = await resp.json().catch(() => ({})) as { error?: string };
    const providerCode = typeof body.error === 'string' ? body.error : `http_${resp.status}`;
    const terminal = providerCode === 'invalid_grant' || providerCode === 'interaction_required';
    await env.onConnectionError?.(`microsoft_${providerCode}`, terminal);
    env.onDiagnostic?.(`microsoft_${providerCode}`);
    throw new Error(`todo_ms_token_refresh_failed:${resp.status}:${providerCode}`);
  }
  const data = await resp.json() as { access_token?: string; expires_in?: number; refresh_token?: string };
  if (!data.access_token) throw new Error('todo_ms_token_refresh_no_token');

  // Capture rotated refresh token if the provider issued a new one.
  if (data.refresh_token) {
    _msLiveRefreshToken.set(cacheKey, data.refresh_token);
    await setStoredRefreshToken(env.OAUTH_REFRESH_TOKEN_STORE_PATH, storeKey, data.refresh_token);
    await env.onRefreshToken?.(data.refresh_token);
  }
  await env.onConnectionHealthy?.();

  const expiresIn = typeof data.expires_in === 'number' ? data.expires_in : 3600;
  _msTokenCache.set(cacheKey, {
    accessToken: data.access_token,
    expiresAt:   Date.now() + expiresIn * 1_000 - TOKEN_EXPIRY_BUFFER_MS,
  });

  // Best-effort keep-alive while Jarvis remains online. Revocation and long
  // downtime are still handled as explicit reconnect-required states.
  // Note: Node.js setInterval uses a 32-bit ms counter (max ~24.8 days).
  // We chain 1-day intervals and count up to KEEPALIVE_DAYS to stay within bounds.
  if (!_msKeepaliveTimers.has(cacheKey)) {
    let dayCount = 0;
    const timer = setInterval(() => {
      dayCount++;
      if (dayCount >= KEEPALIVE_DAYS) {
        dayCount = 0;
        _msTokenCache.delete(cacheKey);
        refreshMicrosoftToken(env).catch(() => {
          env.onDiagnostic?.('microsoft_keepalive_failed');
        });
      }
    }, 24 * 3_600_000); // 1 day — safe for 32-bit setInterval
    _msKeepaliveTimers.set(cacheKey, timer);
    if (timer.unref) timer.unref();
  }

  return data.access_token;
}

export async function stopTodoTokenKeepalives(): Promise<void> {
  for (const timer of _msKeepaliveTimers.values()) clearInterval(timer);
  _msKeepaliveTimers.clear();
  await Promise.allSettled([..._msRefreshInFlight.values()]);
  for (const timer of _msKeepaliveTimers.values()) clearInterval(timer);
  _msKeepaliveTimers.clear();
  _msTokenCache.clear();
}

export async function getMicrosoftTodoAccessToken(env: {
  MICROSOFT_TENANT_ID?: string;
  MICROSOFT_CLIENT_ID?: string;
  MICROSOFT_CLIENT_SECRET?: string;
  MICROSOFT_REFRESH_TOKEN?: string;
  OAUTH_REFRESH_TOKEN_STORE_PATH?: string;
  credentialKey?: string;
  onRefreshToken?: (token: string) => Promise<void> | void;
  onConnectionError?: (code: string, terminal: boolean) => Promise<void> | void;
  onConnectionHealthy?: () => Promise<void> | void;
}, onDiagnostic?: (code: string) => void): Promise<string> {
  if (!env.MICROSOFT_CLIENT_ID || !env.MICROSOFT_CLIENT_SECRET || !env.MICROSOFT_REFRESH_TOKEN) {
    throw new Error('microsoft_credentials_missing');
  }
  return refreshMicrosoftToken({
    MICROSOFT_TENANT_ID: env.MICROSOFT_TENANT_ID,
    MICROSOFT_CLIENT_ID: env.MICROSOFT_CLIENT_ID,
    MICROSOFT_CLIENT_SECRET: env.MICROSOFT_CLIENT_SECRET,
    MICROSOFT_REFRESH_TOKEN: env.MICROSOFT_REFRESH_TOKEN,
    OAUTH_REFRESH_TOKEN_STORE_PATH: env.OAUTH_REFRESH_TOKEN_STORE_PATH,
    cacheKey: env.credentialKey ?? `todo:${env.MICROSOFT_CLIENT_ID}`,
    storeKey: `todo:microsoft:${env.MICROSOFT_CLIENT_ID}`,
    onRefreshToken: env.onRefreshToken,
    onConnectionError: env.onConnectionError,
    onConnectionHealthy: env.onConnectionHealthy,
    onDiagnostic,
  });
}

// ─── MS Graph — low-level helpers ────────────────────────────────────────────

const GRAPH = 'https://graph.microsoft.com/v1.0';
const GRAPH_ORIGIN = 'https://graph.microsoft.com';
const GRAPH_MAX_PAGES = 50;
const GRAPH_MAX_ITEMS = 2_000;
const GRAPH_READ_RETRIES = 1;
const GRAPH_RETRY_FALLBACK_MS = 1_000;
const GRAPH_RETRY_MAX_MS = 5_000;
const PARIS_GRAPH_TIME_ZONE = 'Romance Standard Time';

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

type GraphMethod = 'get' | 'post' | 'patch' | 'delete';
type GraphOutcome = 'rejected' | 'uncertain';

class TodoGraphError extends Error {
  constructor(
    readonly method: GraphMethod,
    readonly outcome: GraphOutcome,
    readonly status?: number,
  ) {
    super(outcome === 'uncertain'
      ? `todo_graph_${method}_uncertain${status ? `:${status}` : ''}`
      : `todo_graph_${method}_failed:${status ?? 'network'}`);
    this.name = 'TodoGraphError';
  }
}

function graphUrl(path: string): URL {
  return new URL(`${GRAPH}${path.startsWith('/') ? path : `/${path}`}`);
}

function validateGraphNextLink(value: unknown): URL | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') throw new Error('todo_graph_malformed_next_link');
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('todo_graph_malformed_next_link');
  }
  if (
    url.protocol !== 'https:'
    || url.origin !== GRAPH_ORIGIN
    || url.port !== ''
    || url.username !== ''
    || url.password !== ''
    || url.hash !== ''
    || !(url.pathname === '/v1.0' || url.pathname.startsWith('/v1.0/'))
  ) {
    throw new Error('todo_graph_untrusted_next_link');
  }
  return url;
}

function retryDelayMs(response: Response): number | undefined {
  const raw = response.headers.get('retry-after')?.trim();
  if (!raw) return GRAPH_RETRY_FALLBACK_MS;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) {
    const delayMs = Math.floor(seconds * 1_000);
    return delayMs <= GRAPH_RETRY_MAX_MS ? delayMs : undefined;
  }
  const dateMs = Date.parse(raw);
  if (Number.isFinite(dateMs)) {
    const delayMs = Math.max(0, dateMs - Date.now());
    return delayMs <= GRAPH_RETRY_MAX_MS ? delayMs : undefined;
  }
  return GRAPH_RETRY_FALLBACK_MS;
}

function delay(ms: number): Promise<void> {
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
}

async function graphFetch(
  url: URL,
  token: string,
  method: GraphMethod,
  init: RequestInit = {},
): Promise<Response> {
  const isRead = method === 'get';
  for (let attempt = 0; ; attempt += 1) {
    let response: Response;
    try {
      response = await fetch(url, {
        ...init,
        headers: {
          authorization: `Bearer ${token}`,
          accept: 'application/json',
          ...(init.headers ?? {}),
        },
        redirect: 'error',
        signal: AbortSignal.timeout(8_000),
      });
    } catch {
      if (isRead && attempt < GRAPH_READ_RETRIES) {
        await delay(GRAPH_RETRY_FALLBACK_MS);
        continue;
      }
      throw new TodoGraphError(method, isRead ? 'rejected' : 'uncertain');
    }

    if (response.ok) return response;
    const retryableRead = isRead
      && attempt < GRAPH_READ_RETRIES
      && (response.status === 429 || response.status === 502 || response.status === 503 || response.status === 504);
    if (retryableRead) {
      const retryDelay = retryDelayMs(response);
      if (retryDelay !== undefined) {
        await delay(retryDelay);
        continue;
      }
    }
    const uncertainMutation = !isRead && (response.status === 408 || response.status >= 500);
    throw new TodoGraphError(method, uncertainMutation ? 'uncertain' : 'rejected', response.status);
  }
}

async function readJsonObject(response: Response, errorCode: string): Promise<Record<string, unknown>> {
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new Error(errorCode);
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error(errorCode);
  return payload as Record<string, unknown>;
}

async function graphGetCollection<T>(path: string, token: string): Promise<T[]> {
  const values: T[] = [];
  let nextUrl: URL | undefined = graphUrl(path);
  let pageCount = 0;
  while (nextUrl) {
    const response = await graphFetch(nextUrl, token, 'get');
    const page = await readJsonObject(response, 'todo_graph_malformed_collection');
    if (!Array.isArray(page.value)) throw new Error('todo_graph_malformed_collection');
    values.push(...page.value as T[]);
    pageCount += 1;
    nextUrl = validateGraphNextLink(page['@odata.nextLink']);
    if (values.length > GRAPH_MAX_ITEMS) throw new Error('todo_graph_item_limit');
    if (pageCount >= GRAPH_MAX_PAGES && nextUrl) throw new Error('todo_graph_pagination_limit');
  }
  return values;
}

async function executeTodoWithAccessRecovery(
  action: TodoAction,
  token: string,
  env: TodoEnv,
  onDiagnostic?: (code: string) => void,
): Promise<string> {
  try {
    return await executeTodo(action, token);
  } catch (error) {
    if (!(error instanceof TodoGraphError) || error.status !== 401 || error.outcome !== 'rejected') throw error;
    const cacheKey = env.credentialKey ?? `todo:${env.MICROSOFT_CLIENT_ID}`;
    _msTokenCache.delete(cacheKey);
    const refreshedToken = await getMicrosoftTodoAccessToken(env, onDiagnostic);
    return executeTodo(action, refreshedToken);
  }
}

async function graphPost<T extends { id?: unknown }>(path: string, token: string, body: object): Promise<T> {
  const response = await graphFetch(graphUrl(path), token, 'post', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  let payload: Record<string, unknown>;
  try {
    payload = await readJsonObject(response, 'todo_graph_post_response_missing');
  } catch {
    throw new TodoGraphError('post', 'uncertain');
  }
  if (typeof payload.id !== 'string' || !payload.id.trim()) throw new TodoGraphError('post', 'uncertain');
  return payload as T;
}

async function graphPatch(path: string, token: string, body: object): Promise<void> {
  await graphFetch(graphUrl(path), token, 'patch', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function graphDelete(path: string, token: string): Promise<void> {
  try {
    await graphFetch(graphUrl(path), token, 'delete', { method: 'DELETE' });
  } catch (error) {
    if (error instanceof TodoGraphError && error.status === 404) return;
    throw error;
  }
}

/** Build a Graph API dateTimeTimeZone object.
 * The dateTime must NOT include a timezone suffix (no 'Z') when timeZone is provided separately.
 */
function parseDateOnly(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}(?:T.*)?$/.test(value)) throw new Error('todo_invalid_date');
  const date = value.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('todo_invalid_date');
  const [year, month, day] = date.split('-').map(Number);
  const normalized = new Date(Date.UTC(year!, month! - 1, day!));
  if (
    normalized.getUTCFullYear() !== year
    || normalized.getUTCMonth() + 1 !== month
    || normalized.getUTCDate() !== day
  ) throw new Error('todo_invalid_date');
  return date;
}

function graphDateTime(
  isoDate: string,
  time = '00:00:00.0000000',
  timeZone = 'UTC',
): { dateTime: string; timeZone: string } {
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d\.\d{7}$/.test(time)) throw new Error('todo_invalid_time');
  return { dateTime: `${parseDateOnly(isoDate)}T${time}`, timeZone };
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
  const lists = await graphGetCollection<MsTaskList>('/me/todo/lists', token);
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

async function findTasks(token: string, listId: string, title: string, includeCompleted = false): Promise<MsTask[]> {
  const qs = includeCompleted
    ? '$top=100'
    : `$filter=status ne 'completed'&$top=100`;
  const tasks = await graphGetCollection<MsTask>(
    `/me/todo/lists/${listId}/tasks?${qs}`,
    token,
  );
  const needle = normalizeForMatch(title);
  if (!needle) return [];
  return tasks.filter((t) => normalizeForMatch(t.title) === needle);
}

async function findTaskMatchesAcrossWatchedLists(
  token: string,
  title: string,
  includeCompleted = false,
): Promise<Array<{ list: MsTaskList; task: MsTask }>> {
  const watched = (await graphGetCollection<MsTaskList>('/me/todo/lists', token)).filter(isWatchedList);
  const hits = await Promise.all(
    watched.map(async (l) => {
      const tasks = await findTasks(token, l.id, title, includeCompleted);
      return tasks.map((task) => ({ list: l, task }));
    }),
  );
  return hits.flat();
}

/** Normalize a reminder dateTime string (from LLM) to 'HH:MM:SS.0000000'.
 * Handles: '09:00', '09:00:00', '09:00:00.000', etc.
 */
function normalizeReminderTime(reminderDate: string): string {
  const raw = reminderDate.includes('T') ? reminderDate.split('T')[1]! : '09:00';
  if (!/^\d{1,2}:\d{2}(?::\d{2}(?:\.\d+)?)?$/.test(raw)) throw new Error('todo_invalid_time');
  const parts = raw.split(':');
  const h = (parts[0] ?? '09').padStart(2, '0');
  const m = (parts[1] ?? '00').padStart(2, '0');
  const s = (parts[2] ?? '00').split('.')[0]!.padStart(2, '0');
  const normalized = `${h}:${m}:${s}.0000000`;
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d\.\d{7}$/.test(normalized)) throw new Error('todo_invalid_time');
  return normalized;
}

// ─── LLM planner ─────────────────────────────────────────────────────────────

const _PLANNER_SYSTEM = `Tu es un assistant de gestion de tâches (Microsoft To Do).
Analyse la commande vocale en français et retourne un JSON correspondant à une seule action.
Le message utilisateur commencera par "TODAY=YYYY-MM-DD" indiquant la date du jour. Utilise cette date pour calculer les dates relatives (demain, la semaine prochaine, etc.).
Dans le JSON, les champs de date doivent toujours rester au format YYYY-MM-DD absolu. Ne produis aucune phrase utilisateur ici.

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
  model = 'gpt-6-luna',
  maxOutputTokens = 512,
): Promise<TodoAction> {
  const content = await completeOpenAiResponse({
    apiKey: openAiApiKey,
    baseUrl: openAiBaseUrl,
    model,
    capability: 'agent',
    messages: [
      { role: 'system', content: _PLANNER_SYSTEM },
      { role: 'user', content: `TODAY=${todayIsoInParis()}\n${text}` },
    ],
    maxOutputTokens,
    timeoutMs,
    jsonMode: true,
    reasoningEffort: 'none',
  });

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error('todo_planner_invalid_json');
  }

  if (typeof parsed !== 'object' || parsed === null || !('action' in parsed)) {
    throw new Error('todo_planner_missing_action');
  }

  return parsed as TodoAction;
}

export async function planTodoAgentAction(
  text: string,
  env: TodoEnv,
  log?: MinLogger,
): Promise<TodoAction | { clarification: string }> {
  if (!env.MICROSOFT_CLIENT_ID || !env.MICROSOFT_CLIENT_SECRET || !env.MICROSOFT_REFRESH_TOKEN) {
    return { clarification: "La gestion des tâches n'est pas configurée." };
  }
  if (!env.OPENAI_API_KEY) return { clarification: "Je ne peux pas gérer les tâches pour l'instant, la clé OpenAI est manquante." };
  try {
    let action = await planTodoAction(
      text,
      env.OPENAI_API_KEY,
      env.OPENAI_BASE_URL,
      env.OPENAI_TIMEOUT_MS,
      env.OPENAI_MODEL_AGENT,
      env.OPENAI_MAX_OUTPUT_TOKENS_AGENT,
    );
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
      return `J'ajoute la tache ${action.title}${action.list_name ? ` dans ${action.list_name}` : ''}${action.due_date ? ` pour ${formatDueDateForUser(action.due_date)}` : ''}.`;
    case 'complete_task':
      return `Tache a terminer: ${action.title}${action.list_name ? ` dans ${action.list_name}` : ''}.`;
    case 'delete_task':
      return `Tache a supprimer: ${action.title}${action.list_name ? ` dans ${action.list_name}` : ''}.`;
    case 'update_task':
      return `Tache a modifier: ${action.title}${action.new_title ? ` vers ${action.new_title}` : ''}${action.due_date ? `, pour ${formatDueDateForUser(action.due_date)}` : ''}.`;
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
function todayIsoInParis(now = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Paris',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function addDaysIso(iso: string, days: number): string {
  const [year = 1970, month = 1, day = 1] = iso.slice(0, 10).split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + days));
  return date.toISOString().slice(0, 10);
}

export function formatDueDateForUser(iso: string, todayIso = todayIsoInParis()): string {
  const normalized = iso.slice(0, 10);
  if (normalized === todayIso) return "aujourd'hui";
  if (normalized === addDaysIso(todayIso, 1)) return 'demain';
  return `le ${formatDateFr(normalized)}`;
}

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
  const validTypes = new Set(['daily', 'weekly', 'absoluteMonthly', 'absoluteYearly']);
  if (!validTypes.has(r.type)) throw new Error('todo_invalid_recurrence');
  if (!Number.isInteger(interval) || interval < 1 || interval > 99) throw new Error('todo_invalid_recurrence');
  const validDays = new Set(['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']);
  const pattern: Record<string, unknown> = { type: r.type, interval };
  if (r.type === 'weekly') {
    const days = r.daysOfWeek?.length ? r.daysOfWeek : ['monday'];
    if (days.some((day) => !validDays.has(day))) throw new Error('todo_invalid_recurrence');
    pattern['daysOfWeek']    = days;
    pattern['firstDayOfWeek'] = 'monday';
  } else if (r.type === 'absoluteMonthly') {
    if (!Number.isInteger(r.dayOfMonth) || r.dayOfMonth! < 1 || r.dayOfMonth! > 31) throw new Error('todo_invalid_recurrence');
    pattern['dayOfMonth'] = r.dayOfMonth;
  } else if (r.type === 'absoluteYearly') {
    if (!Number.isInteger(r.dayOfMonth) || r.dayOfMonth! < 1 || r.dayOfMonth! > 31) throw new Error('todo_invalid_recurrence');
    if (!Number.isInteger(r.month) || r.month! < 1 || r.month! > 12) throw new Error('todo_invalid_recurrence');
    pattern['dayOfMonth'] = r.dayOfMonth;
    pattern['month']      = r.month;
  }
  return {
    pattern,
    range: { type: 'noEnd', startDate: parseDateOnly(startDate) },
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
        targetLists = (await graphGetCollection<MsTaskList>('/me/todo/lists', token)).filter(isWatchedList);
        if (targetLists.length === 0) return 'Aucune liste surveillée trouvée dans Microsoft To Do.';
      }

      // Build Graph query string.
      let qs: string;
      if (action.status === 'completed') {
        qs = `$filter=status eq 'completed'&$top=100`;
      } else if (action.status === 'all') {
        qs = `$top=100`;
      } else {
        qs = `$filter=status ne 'completed'&$top=100`;
      }

      // Fetch from all target lists in parallel.
      const results = await Promise.allSettled(
        targetLists.map((l) => graphGetCollection<MsTask>(`/me/todo/lists/${l.id}/tasks?${qs}`, token)),
      );
      const failures = results.filter((result) => result.status === 'rejected');
      if (failures.length === results.length) throw failures[0]!.reason;
      let tasks = results.flatMap((result) => result.status === 'fulfilled' ? result.value : []);
      const partialSuffix = failures.length > 0
        ? ` Résultat partiel : ${failures.length} liste${failures.length > 1 ? 's' : ''} indisponible${failures.length > 1 ? 's' : ''}.`
        : '';

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
          return `Tu n'as aucune tâche avec échéance ${periodFr(action.period)}.${partialSuffix}`;
        }
        return action.status === 'completed'
          ? `Tu n'as aucune tâche terminée dans tes listes.${partialSuffix}`
          : `Tu n'as aucune tâche en attente.${partialSuffix}`;
      }

      const count = tasks.length;
      // Every task due today is relevant. Future and unbounded queries stay concise.
      const displayMax = action.period === 'today' ? tasks.length : 5;
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
      return `${intro} ${displayed.join(' ; ')}${more}.${partialSuffix}`;
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
        body['reminderDateTime'] = graphDateTime(action.reminder_date, normalizeReminderTime(action.reminder_date), PARIS_GRAPH_TIME_ZONE);
        body['isReminderOn'] = true;
      }
      if (action.importance) body['importance'] = action.importance;
      if (action.notes)      body['body'] = { contentType: 'text', content: action.notes };
      if (action.categories?.length) body['categories'] = action.categories;
      if (action.recurrence) {
        const startDate = action.due_date ?? todayIsoInParis();
        body['recurrence'] = buildRecurrence(action.recurrence, startDate);
      }

      await graphPost<MsTask>(`/me/todo/lists/${list.id}/tasks`, token, body);
      const parts: string[] = [];
      if (action.due_date)                     parts.push(`pour ${formatDueDateForUser(action.due_date)}`);
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
        const matches = await findTasks(token, list.id, action.title);
        if (matches.length === 0) return `Je n'ai pas trouvé de tâche correspondant à ${action.title}.`;
        if (matches.length > 1) return `J'ai trouvé plusieurs tâches nommées ${action.title} dans ${list.displayName}. Précise laquelle terminer.`;
        task = matches[0]!;
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
        const matches = await findTasks(token, list.id, action.title, true);
        if (matches.length === 0) return `Je n'ai pas trouvé de tâche correspondant à ${action.title}.`;
        if (matches.length > 1) return `J'ai trouvé plusieurs tâches nommées ${action.title} dans ${list.displayName}. Précise laquelle supprimer.`;
        task = matches[0]!;
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
        const matches = await findTasks(token, list.id, action.title, true);
        if (matches.length === 0) return `Je n'ai pas trouvé de tâche correspondant à ${action.title}.`;
        if (matches.length > 1) return `J'ai trouvé plusieurs tâches nommées ${action.title} dans ${list.displayName}. Précise laquelle modifier.`;
        task = matches[0]!;
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
        patch['reminderDateTime'] = graphDateTime(action.reminder_date, normalizeReminderTime(action.reminder_date), PARIS_GRAPH_TIME_ZONE);
        patch['isReminderOn'] = true;
      }
      // recurrence: null removes it, object sets it
      if (action.recurrence === null) {
        patch['recurrence'] = null;
      } else if (action.recurrence) {
        const startDate = action.due_date ?? task.dueDateTime?.dateTime.slice(0, 10) ?? todayIsoInParis();
        patch['recurrence'] = buildRecurrence(action.recurrence, startDate);
      }
      if (Object.keys(patch).length === 0) return 'Tu n\'as pas précisé de modification.';

      await graphPatch(`/me/todo/lists/${list.id}/tasks/${task.id}`, token, patch);
      const updatedName = (patch['title'] as string | undefined) ?? task.title;
      // Build a specific confirmation based on what changed.
      const details: string[] = [];
      if (patch['title'])       details.push(`renommée en ${patch['title'] as string}`);
      if (patch['dueDateTime'] === null)     details.push('échéance supprimée');
      else if (patch['dueDateTime'])         details.push(`échéance fixée pour ${formatDueDateForUser(action.due_date as string)}`);
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
      const lists = await graphGetCollection<MsTaskList>('/me/todo/lists?$top=50', token);
      if (lists.length === 0) return 'Tu n\'as aucune liste de tâches pour le moment.';
      const names = lists.map((l) => l.displayName);
      return `Tu as ${lists.length} liste${lists.length > 1 ? 's' : ''} : ${joinFr(names)}.`;
    }

    case 'create_list': {
      await graphPost<MsTaskList>(`/me/todo/lists`, token, { displayName: action.name });
      return `La liste ${action.name} a bien été créée.`;
    }

    case 'delete_list': {
      const lists = await graphGetCollection<MsTaskList>('/me/todo/lists', token);
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

      const taskMatches = await findTasks(token, list.id, action.task_title);
      if (taskMatches.length === 0) return `Je n'ai pas trouvé de tâche correspondant à ${action.task_title}.`;
      if (taskMatches.length > 1) return `J'ai trouvé plusieurs tâches nommées ${action.task_title} dans ${list.displayName}. Précise laquelle modifier.`;
      const task = taskMatches[0]!;

      await graphPost<MsChecklistItem>(
        `/me/todo/lists/${list.id}/tasks/${task.id}/checklistItems`,
        token,
        { displayName: action.item_title },
      );
      return `J'ai ajouté ${action.item_title} dans la tâche ${task.title}.`;
    }

    case 'complete_checklist_item': {
      const list = await findList(token, action.list_name);
      if (!list) return 'Je n\'ai pas trouvé la liste de tâches.';
      const taskMatches = await findTasks(token, list.id, action.task_title);
      if (taskMatches.length === 0) return `Je n'ai pas trouvé de tâche correspondant à ${action.task_title}.`;
      if (taskMatches.length > 1) return `J'ai trouvé plusieurs tâches nommées ${action.task_title} dans ${list.displayName}. Précise laquelle modifier.`;
      const task = taskMatches[0]!;

      const checklist = await graphGetCollection<MsChecklistItem>(
        `/me/todo/lists/${list.id}/tasks/${task.id}/checklistItems`,
        token,
      );
      const needle = normalizeForMatch(action.item_title);
      const matches = checklist.filter((c) => normalizeForMatch(c.displayName) === needle);
      if (matches.length === 0) return `Je n'ai pas trouvé ${action.item_title} dans la tâche ${task.title}.`;
      if (matches.length > 1) return `J'ai trouvé plusieurs éléments ${action.item_title} dans ${task.title}. Précise lequel cocher.`;
      const item = matches[0]!;
      await graphPatch(`/me/todo/lists/${list.id}/tasks/${task.id}/checklistItems/${item.id}`, token, { isChecked: true });
      return `Parfait, ${item.displayName} est cochée dans ${task.title}.`;
    }

    case 'delete_checklist_item': {
      const list = await findList(token, action.list_name);
      if (!list) return 'Je n\'ai pas trouvé la liste de tâches.';
      const taskMatches = await findTasks(token, list.id, action.task_title);
      if (taskMatches.length === 0) return `Je n'ai pas trouvé de tâche correspondant à ${action.task_title}.`;
      if (taskMatches.length > 1) return `J'ai trouvé plusieurs tâches nommées ${action.task_title} dans ${list.displayName}. Précise laquelle modifier.`;
      const task = taskMatches[0]!;

      const checklist = await graphGetCollection<MsChecklistItem>(
        `/me/todo/lists/${list.id}/tasks/${task.id}/checklistItems`,
        token,
      );
      const needle = normalizeForMatch(action.item_title);
      const matches = checklist.filter((c) => normalizeForMatch(c.displayName) === needle);
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
    return "La gestion des tâches n'est pas disponible, les identifiants Microsoft ne sont pas configurés.";
  }
  if (!env.OPENAI_API_KEY) return "Je ne peux pas gérer les tâches pour l'instant, la clé OpenAI est manquante.";

  let token: string;
  try {
    token = await getMicrosoftTodoAccessToken(
      env,
      (code) => options?.log?.warn({ errorCode: code }, 'todo_agent_token_diagnostic'),
    );
  } catch (err) {
    options?.log?.warn({ err: String(err) }, 'todo_agent_token_error');
    return 'Je ne peux pas acceder a Microsoft To Do pour le moment, le token d authentification a expire ou est invalide.';
  }

  const rawResult = await executeTodoWithAccessRecovery(
    action,
    token,
    env,
    (code) => options?.log?.warn({ errorCode: code }, 'todo_agent_token_diagnostic'),
  );
  options?.log?.info({ action: action.action, result_len: rawResult.length }, 'todo_agent_done');
  if (action.action === 'list_tasks') return compactTodoListForFallback(rawResult);
  return synthesizeTodoReplyWithOpenAi({
    openAiApiKey: env.OPENAI_API_KEY,
    openAiBaseUrl: env.OPENAI_BASE_URL,
    model: env.OPENAI_MODEL_SYNTHESIS ?? env.OPENAI_MODEL_SUMMARY ?? 'gpt-6.1-sol',
    maxOutputTokens: env.OPENAI_MAX_OUTPUT_TOKENS_SYNTHESIS,
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
      text,
      env.OPENAI_API_KEY,
      env.OPENAI_BASE_URL,
      env.OPENAI_TIMEOUT_MS,
      env.OPENAI_MODEL_AGENT,
      env.OPENAI_MAX_OUTPUT_TOKENS_AGENT,
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
    token = await getMicrosoftTodoAccessToken(
      env,
      (code) => log?.warn({ errorCode: code }, 'todo_agent_token_diagnostic'),
    );
  } catch (err) {
    log?.warn({ err: String(err) }, 'todo_agent_token_error');
    return 'Je ne peux pas accéder à Microsoft To Do pour le moment, le token d\'authentification a expiré ou est invalide.';
  }

  try {
    const rawResult = await executeTodoWithAccessRecovery(
      action,
      token,
      env,
      (code) => log?.warn({ errorCode: code }, 'todo_agent_token_diagnostic'),
    );
    log?.info({ action: action.action, result_len: rawResult.length }, 'todo_agent_done');

    // For list reads, keep deterministic executor output to avoid synthesis drift/hallucinations
    // (e.g. inventing timelines that are not in the filtered result set).
    if (action.action === 'list_tasks') {
      return compactTodoListForFallback(rawResult);
    }

    const synthesized = await synthesizeTodoReplyWithOpenAi({
      openAiApiKey:  env.OPENAI_API_KEY!,
      openAiBaseUrl: env.OPENAI_BASE_URL,
      model:         env.OPENAI_MODEL_SYNTHESIS ?? env.OPENAI_MODEL_SUMMARY ?? 'gpt-6.1-sol',
      maxOutputTokens: env.OPENAI_MAX_OUTPUT_TOKENS_SYNTHESIS,
      timeoutMs:     env.OPENAI_TIMEOUT_MS,
      userText:      text,
      executorResult: rawResult,
    });
    return synthesized;
  } catch (err) {
    log?.warn({ err: String(err), action: action.action }, 'todo_agent_execute_error');
    if (err instanceof TodoGraphError && err.outcome === 'uncertain') {
      return 'Microsoft To Do a reçu la demande, mais son résultat ne peut pas être confirmé. Vérifie la tâche avant de réessayer pour éviter un doublon.';
    }
    return 'Une erreur s\'est produite lors de l\'accès à Microsoft To Do. Réessaie dans un instant.';
  }
}
