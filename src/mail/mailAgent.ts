import { getStoredRefreshToken, setStoredRefreshToken } from '../auth/oauthRefreshTokenStore';
import { googleRefreshTokenStoreKey } from '../google/googleCredentialService';
import { cleanMailDetailText } from './mailContentCleaner';
import { buildMailSynthesisSystemPrompt } from './prompts/mailSynthesisSystemPrompt';
import { buildMailSynthesisUserPrompt } from './prompts/mailSynthesisUserTemplate';

/**
 * Mail agent — Gmail (Google) sub-agent.
 *
 * Architecture mirrors todo/todoAgent.ts:
 *   1. LLM planner (gpt-4o-mini, structured JSON) translates voice → MailAction
 *   2. Token refresher acquires a short-lived access token for the active provider
 *   3. Executor calls the provider API
 *   4. Returns a human-readable French string suitable for TTS
 *
 * Provider selection (auto-detected from env vars):
 *   - GOOGLE_REFRESH_TOKEN set      → Gmail API (googleapis.com)
 *
 * Routing keys: "mail" | "mail.*"
 * Detected by isMailAgentKey() — mirrors isSearchAgentKey() from search/agents.ts.
 *
 * Required env vars:
 *   Gmail:   GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN
 *   Common:  OPENAI_API_KEY, OPENAI_BASE_URL, OPENAI_TIMEOUT_MS
 *
 * Optional: MAIL_PROVIDER ("gmail")
 */

// ─── Action types ─────────────────────────────────────────────────────────────

type ListInboxAction  = { action: 'list_inbox';        max?: number; unread_only?: boolean; account?: string };
type SearchAction     = { action: 'search_emails';     query: string; max?: number; account?: string };
type SendAction       = { action: 'send_email';        to: string; subject: string; body: string; cc?: string; bcc?: string; importance?: 'low' | 'normal' | 'high'; account?: string };
type MarkReadAction   = { action: 'mark_read';         subject?: string; sender?: string; account?: string };
type MarkUnreadAction = { action: 'mark_unread';       subject?: string; sender?: string; account?: string };
type ReplyAction      = { action: 'reply_email';       sender?: string; subject?: string; body: string; account?: string };
type ForwardAction    = { action: 'forward_email';     to: string; sender?: string; subject?: string; comment?: string; account?: string };
type TrashAction      = { action: 'trash_email';       subject?: string; sender?: string; account?: string };
type GetEmailAction   = { action: 'get_email';         subject?: string; sender?: string; account?: string };
type FlagAction       = { action: 'flag_email';        subject?: string; sender?: string; flagged?: boolean; account?: string };

type MailAction = ListInboxAction | SearchAction | SendAction | MarkReadAction |
  MarkUnreadAction | ReplyAction | ForwardAction | TrashAction | GetEmailAction | FlagAction;

// ─── Multi-account types ──────────────────────────────────────────────────────

export interface MailAccount {
  label: string;
  provider: 'gmail';
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  tenantId?: string;
}

// Env surface required by buildMailAccounts() — a subset of the full zod env.
export interface MailAccountsEnv {
  // Optional unlimited JSON config
  MAIL_ACCOUNTS_JSON?: string;
  // Optional persistent rotated refresh-token store
  OAUTH_REFRESH_TOKEN_STORE_PATH?: string;
  // Legacy single-account vars (backward compat)
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  GOOGLE_REFRESH_TOKEN?: string;
  MAIL_PROVIDER?: string;
  // Indexed multi-account (takes priority when any LABEL_1 is set)
  MAIL_ACCOUNT_1_LABEL?: string; MAIL_ACCOUNT_1_PROVIDER?: string; MAIL_ACCOUNT_1_CLIENT_ID?: string; MAIL_ACCOUNT_1_CLIENT_SECRET?: string; MAIL_ACCOUNT_1_REFRESH_TOKEN?: string; MAIL_ACCOUNT_1_TENANT_ID?: string;
  MAIL_ACCOUNT_2_LABEL?: string; MAIL_ACCOUNT_2_PROVIDER?: string; MAIL_ACCOUNT_2_CLIENT_ID?: string; MAIL_ACCOUNT_2_CLIENT_SECRET?: string; MAIL_ACCOUNT_2_REFRESH_TOKEN?: string; MAIL_ACCOUNT_2_TENANT_ID?: string;
  MAIL_ACCOUNT_3_LABEL?: string; MAIL_ACCOUNT_3_PROVIDER?: string; MAIL_ACCOUNT_3_CLIENT_ID?: string; MAIL_ACCOUNT_3_CLIENT_SECRET?: string; MAIL_ACCOUNT_3_REFRESH_TOKEN?: string; MAIL_ACCOUNT_3_TENANT_ID?: string;
  MAIL_ACCOUNT_4_LABEL?: string; MAIL_ACCOUNT_4_PROVIDER?: string; MAIL_ACCOUNT_4_CLIENT_ID?: string; MAIL_ACCOUNT_4_CLIENT_SECRET?: string; MAIL_ACCOUNT_4_REFRESH_TOKEN?: string; MAIL_ACCOUNT_4_TENANT_ID?: string;
  MAIL_ACCOUNT_5_LABEL?: string; MAIL_ACCOUNT_5_PROVIDER?: string; MAIL_ACCOUNT_5_CLIENT_ID?: string; MAIL_ACCOUNT_5_CLIENT_SECRET?: string; MAIL_ACCOUNT_5_REFRESH_TOKEN?: string; MAIL_ACCOUNT_5_TENANT_ID?: string;
}

/**
 * Builds the list of configured mail accounts from env vars.
 * Indexed MAIL_ACCOUNT_N_* vars take priority over legacy GOOGLE_* / MICROSOFT_* vars.
 * Call this once per request in ingest.ts and pass the result in MailEnv.mailAccounts.
 */
export function buildMailAccounts(env: MailAccountsEnv): MailAccount[] {
  const accounts: MailAccount[] = [];
  const e = env as Record<string, string | undefined>;

  // Unlimited mode via a single JSON env var.
  // Example:
  // MAIL_ACCOUNTS_JSON=[{"label":"perso","provider":"gmail","clientId":"...","clientSecret":"...","refreshToken":"..."}]
  const jsonRaw = env.MAIL_ACCOUNTS_JSON?.trim();
  if (jsonRaw) {
    try {
      const parsed = JSON.parse(jsonRaw) as unknown;
      if (Array.isArray(parsed)) {
        for (const row of parsed) {
          if (typeof row !== 'object' || row === null) continue;
          const candidate = row as Record<string, unknown>;
          const label = typeof candidate.label === 'string' ? candidate.label.trim() : '';
          const provider = typeof candidate.provider === 'string' ? candidate.provider.trim().toLowerCase() : '';
          const clientId = typeof candidate.clientId === 'string' ? candidate.clientId.trim() : '';
          const clientSecret = typeof candidate.clientSecret === 'string' ? candidate.clientSecret.trim() : '';
          const refreshToken = typeof candidate.refreshToken === 'string' ? candidate.refreshToken.trim() : '';
          const tenantId = typeof candidate.tenantId === 'string' ? candidate.tenantId.trim() : undefined;
          if (!label || !clientId || !clientSecret || !refreshToken) continue;
          if (provider !== 'gmail') continue;
          accounts.push({ label, provider, clientId, clientSecret, refreshToken, tenantId });
        }
      }
    } catch {
      // Invalid JSON is ignored on purpose, fallback modes remain available.
    }
  }

  if (accounts.length > 0) return accounts;

  for (let i = 1; i <= 5; i++) {
    const label         = e[`MAIL_ACCOUNT_${i}_LABEL`];
    const provider      = e[`MAIL_ACCOUNT_${i}_PROVIDER`];
    const clientId      = e[`MAIL_ACCOUNT_${i}_CLIENT_ID`];
    const clientSecret  = e[`MAIL_ACCOUNT_${i}_CLIENT_SECRET`];
    const refreshToken  = e[`MAIL_ACCOUNT_${i}_REFRESH_TOKEN`];
    const tenantId      = e[`MAIL_ACCOUNT_${i}_TENANT_ID`];
    if (!label || !provider || !clientId || !clientSecret || !refreshToken) continue;
    if (provider !== 'gmail') continue;
    accounts.push({ label, provider: 'gmail', clientId, clientSecret, refreshToken, tenantId });
  }

  if (accounts.length > 0) return accounts;

  // Legacy single-account fallback
  const override = env.MAIL_PROVIDER?.trim().toLowerCase();
  if (override && override !== 'gmail') return [];
  if (env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET && (env.GOOGLE_REFRESH_TOKEN || env.OAUTH_REFRESH_TOKEN_STORE_PATH)) {
    return [{ label: 'gmail', provider: 'gmail', clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET, refreshToken: env.GOOGLE_REFRESH_TOKEN ?? '' }];
  }
  return [];
}

// ─── Minimal env surface ──────────────────────────────────────────────────────

export type MailEnv = MailAccountsEnv & {
  // Pre-parsed account list (built by buildMailAccounts in ingest.ts).
  // When provided, overrides legacy GOOGLE_*/MICROSOFT_* detection.
  mailAccounts?: MailAccount[];
  // OpenAI planner
  OPENAI_API_KEY?: string;
  OPENAI_BASE_URL: string;
  OPENAI_TIMEOUT_MS: number;
  // OpenAI synthesis model (defaults to gpt-4o-mini)
  OPENAI_MODEL_SUMMARY?: string;
};

type MinLogger = {
  info: (obj: Record<string, unknown>, msg: string) => void;
  warn: (obj: Record<string, unknown>, msg: string) => void;
};

// ─── Account token helper ─────────────────────────────────────────────────────

async function getAccountTokenWithStore(acc: MailAccount, refreshStorePath?: string): Promise<string> {
  const cacheBase = `${acc.provider}:${acc.label.toLowerCase()}:${acc.clientId}`;
  const storeBase = acc.provider === 'gmail' ? googleRefreshTokenStoreKey(acc.clientId) : `mail:${acc.provider}:${acc.label.toLowerCase()}:${acc.clientId}`;
  return refreshGoogleToken({
    GOOGLE_CLIENT_ID:     acc.clientId,
    GOOGLE_CLIENT_SECRET: acc.clientSecret,
    GOOGLE_REFRESH_TOKEN: acc.refreshToken,
    cacheKey:             cacheBase,
    storeKey:             storeBase,
    OAUTH_REFRESH_TOKEN_STORE_PATH: refreshStorePath,
  });
}

// ─── Access token cache (in-memory, per process) ─────────────────────────────
//
// Two protections against token expiry:
//   1. Access token cache: reused until TOKEN_EXPIRY_BUFFER_MS before expiry (~1 h window).
//   2. Refresh token rotation: if the provider returns a new refresh_token, it is kept
//      in memory and used for subsequent calls (Microsoft rotates by default).
//   3. Keep-alive: a setInterval fires every KEEPALIVE_INTERVAL_MS to proactively call
//      the token endpoint, resetting each provider's inactivity window:
//        – Microsoft inactive limit: 90 days → we refresh every 30 days.
//        – Google inactive limit: 6 months  → we refresh every 30 days.
//      If the process is down for longer than the limit, the user must re-run the auth flow once.

interface CachedToken { accessToken: string; expiresAt: number }
const _googleTokenCache         = new Map<string, CachedToken>();
const _googleLiveRefreshToken   = new Map<string, string>(); // captures rotated tokens
const _googleKeepaliveScheduled = new Set<string>();
const TOKEN_EXPIRY_BUFFER_MS    = 60_000;           // refresh access token 60 s before expiry
const KEEPALIVE_DAYS            = 30;
const KEEPALIVE_TICK_MS         = 24 * 3_600_000; // 1 day — safe for Node.js 32-bit timer range

// ─── Google — token refresh ───────────────────────────────────────────────────

async function refreshGoogleToken(env: {
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  GOOGLE_REFRESH_TOKEN: string;
  cacheKey?: string;
  storeKey?: string;
  OAUTH_REFRESH_TOKEN_STORE_PATH?: string;
}): Promise<string> {
  const cacheKey = env.cacheKey?.trim() || env.GOOGLE_CLIENT_ID;
  const storeKey = env.storeKey?.trim() || `mail:gmail:${env.GOOGLE_CLIENT_ID}`;
  const cached = _googleTokenCache.get(cacheKey);
  if (cached && Date.now() < cached.expiresAt) return cached.accessToken;

  const refreshToken =
    _googleLiveRefreshToken.get(cacheKey)
    ?? await getStoredRefreshToken(env.OAUTH_REFRESH_TOKEN_STORE_PATH, storeKey)
    ?? env.GOOGLE_REFRESH_TOKEN;
  const resp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id:     env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      refresh_token: refreshToken,
      grant_type:    'refresh_token',
    }),
    signal: AbortSignal.timeout(8_000),
  });
  if (!resp.ok) {
    _googleTokenCache.delete(cacheKey);
    const body = await resp.text().catch(() => '');
    throw new Error(`mail_google_token_refresh_failed:${resp.status}:${body.slice(0, 200)}`);
  }
  const data = await resp.json() as { access_token?: string; expires_in?: number; refresh_token?: string };
  if (!data.access_token) throw new Error('mail_google_token_refresh_no_token');

  if (data.refresh_token) {
    _googleLiveRefreshToken.set(cacheKey, data.refresh_token);
    await setStoredRefreshToken(env.OAUTH_REFRESH_TOKEN_STORE_PATH, storeKey, data.refresh_token);
  }

  const expiresIn = typeof data.expires_in === 'number' ? data.expires_in : 3600;
  _googleTokenCache.set(cacheKey, {
    accessToken: data.access_token,
    expiresAt:   Date.now() + expiresIn * 1_000 - TOKEN_EXPIRY_BUFFER_MS,
  });

  if (!_googleKeepaliveScheduled.has(cacheKey)) {
    _googleKeepaliveScheduled.add(cacheKey);
    let dayCount = 0;
    const timer = setInterval(() => {
      dayCount += 1;
      if (dayCount >= KEEPALIVE_DAYS) {
        dayCount = 0;
        _googleTokenCache.delete(cacheKey);
        refreshGoogleToken(env).catch(() => {});
      }
    }, KEEPALIVE_TICK_MS);
    if (timer.unref) timer.unref();
  }

  return data.access_token;
}

// ─── LLM synthesis ───────────────────────────────────────────────────────────

const MAIL_SYNTHESIS_SYSTEM_PROMPT = buildMailSynthesisSystemPrompt();

/** Returns the first sentence of a TTS-friendly string, capped at maxChars. */
function firstSentence(text: string, maxChars = 140): string {
  const m = text.match(/^[^.!?]+[.!?]/);
  const s = m ? m[0] : text;
  return s.length > maxChars ? s.slice(0, maxChars).trimEnd() + '…' : s;
}

function compactMailListForFallback(text: string): string {
  const clean = text.replace(/\s+/g, ' ').trim();

  // Pattern emitted by executeGmail list_inbox.
  const listMatch = clean.match(/^Tu as\s+(\d+)\s+emails?\s+non\s+lu[s]?\s*:\s*(.+)\.?$/i);
  if (listMatch) {
    const total = Number.parseInt(listMatch[1] ?? '0', 10);
    const itemsRaw = listMatch[2] ?? '';
    const items = itemsRaw
      .split(';')
      .map((x) => x.trim().replace(/\.+$/, ''))
      .filter(Boolean);
    const shown = items.slice(0, 3);
    const remaining = Math.max(0, total - shown.length);
    const suffix = remaining > 0 ? ` + ${remaining} autre${remaining > 1 ? 's' : ''}.` : '.';
    return `Tu as ${total} non lus. Top: ${shown.join(' ; ')}${suffix}`;
  }

  // Pattern emitted by executeGmail search_emails.
  const searchMatch = clean.match(/^(\d+)\s+résultat[s]?\s+pour\s+"([^"]+)"\s*:\s*(.+)\.?$/i);
  if (searchMatch) {
    const total = Number.parseInt(searchMatch[1] ?? '0', 10);
    const query = searchMatch[2] ?? '';
    const items = (searchMatch[3] ?? '')
      .split(';')
      .map((x) => x.trim().replace(/\.+$/, ''))
      .filter(Boolean);
    const shown = items.slice(0, 3);
    const remaining = Math.max(0, total - shown.length);
    const suffix = remaining > 0 ? ` + ${remaining} autre${remaining > 1 ? 's' : ''}.` : '.';
    return `${total} résultat${total > 1 ? 's' : ''} pour "${query}". Top: ${shown.join(' ; ')}${suffix}`;
  }

  // Last-resort compacting for very long one-line payloads.
  if (clean.length > 220 && clean.includes(';')) {
    const chunks = clean
      .split(';')
      .map((x) => x.trim())
      .filter(Boolean)
      .slice(0, 3);
    return `${chunks.join(' ; ')}.`;
  }

  return firstSentence(clean, 180);
}

async function synthesizeMailReplyWithOpenAi(params: {
  openAiApiKey: string;
  openAiBaseUrl: string;
  model: string;
  timeoutMs: number;
  userText: string;
  executorResult: string;
}): Promise<string> {
  const resp = await fetch(`${params.openAiBaseUrl.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${params.openAiApiKey}`,
    },
    body: JSON.stringify({
      model: params.model,
      temperature: 0.2,
      max_tokens: 180,
      messages: [
        { role: 'system', content: MAIL_SYNTHESIS_SYSTEM_PROMPT },
        { role: 'user',   content: buildMailSynthesisUserPrompt(params.userText, params.executorResult) },
      ],
    }),
    signal: AbortSignal.timeout(params.timeoutMs),
  });

  if (!resp.ok) {
    return compactMailListForFallback(params.executorResult);
  }

  const data = await resp.json() as { choices?: Array<{ message?: { content?: string } }> };
  const content = data.choices?.[0]?.message?.content?.trim() ?? '';
  return content || compactMailListForFallback(params.executorResult);
}

// ─── LLM planner ─────────────────────────────────────────────────────────────

function buildPlannerSystem(accountLabels: string[]): string {
  const accountField = accountLabels.length > 1
    ? `\n  account       → "account" (optionnel) : label du compte parmi ${accountLabels.map(l => `"${l}"`).join(' | ')} si l'utilisateur le précise explicitement.`
    : '';
  return `Tu es un assistant de gestion des emails.
Analyse la commande vocale en français et retourne un JSON correspondant à une seule action email.

Champ obligatoire "action" parmi :
  list_inbox | search_emails | send_email | mark_read | mark_unread |
  reply_email | forward_email | trash_email | get_email | flag_email

Champs conditionnels :
  list_inbox    → "max" (entier 1-20, défaut 5), "unread_only" (bool, défaut true)
  search_emails → "query" (termes de recherche, obligatoire), "max" (entier 1-20, défaut 5)
  send_email    → "to" (obligatoire), "subject" (obligatoire), "body" (obligatoire),
                  "cc" (adresse CC, optionnel), "bcc" (adresse BCC, optionnel),
                  "importance" ("low"|"normal"|"high", optionnel)
  mark_read     → "subject" (mots-clés, optionnel), "sender" (nom ou email, optionnel)
  mark_unread   → "subject" (mots-clés, optionnel), "sender" (nom ou email, optionnel)
  reply_email   → "body" (texte de la réponse, obligatoire), "sender" (expéditeur, optionnel), "subject" (mots-clés, optionnel)
  forward_email → "to" (adresse de destination, obligatoire), "sender" (expéditeur original, optionnel),
                  "subject" (mots-clés, optionnel), "comment" (message d'accompagnement, optionnel)
  trash_email   → "subject" (mots-clés, optionnel), "sender" (nom ou email, optionnel)
  get_email     → "subject" (mots-clés, optionnel), "sender" (nom ou email, optionnel)
  flag_email    → "subject" (mots-clés, optionnel), "sender" (nom ou email, optionnel), "flagged" (bool, défaut true)${accountField}

Réponds UNIQUEMENT avec du JSON valide, sans texte supplémentaire.
Exemples :
  "montre mes emails non lus"                    → {"action":"list_inbox","unread_only":true,"max":5}
  "checke mes mails"                             → {"action":"list_inbox","unread_only":true,"max":5}
  "cherche les emails de Jean"                   → {"action":"search_emails","query":"from:Jean","max":5}
  "envoie un mail à alice@exemple.com"           → {"action":"send_email","to":"alice@exemple.com","subject":"...","body":"..."}
  "marque tous les emails comme lus"             → {"action":"mark_read"}
  "marque l'email de Pierre comme non lu"        → {"action":"mark_unread","sender":"Pierre"}
  "réponds à Jean que je serai là demain"        → {"action":"reply_email","sender":"Jean","body":"Je serai là demain."}
  "transfère l'email de la réunion à bob@co.fr"  → {"action":"forward_email","to":"bob@co.fr","subject":"réunion"}
  "supprime l'email de spam"                     → {"action":"trash_email","subject":"spam"}
  "lis l'email de Marie"                         → {"action":"get_email","sender":"Marie"}
  "flagge l'email de la banque"                  → {"action":"flag_email","sender":"banque"}
`.trim();
}

function normalizeMailText(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .trim();
}

function preclassifyMailAction(text: string): MailAction | { clarification: string } | null {
  const t = normalizeMailText(text);

  const senderMatch = t.match(/(?:cherche|recherche|trouve|retrouve)\s+(?:mes\s+)?(?:emails?|mails?)\s+de\s+([a-z0-9._%+-]+(?:\s+[a-z0-9._%+-]+){0,3})/i);
  if (senderMatch?.[1]) {
    const sender = senderMatch[1].trim();
    if (sender.length > 0) {
      return { action: 'search_emails', query: `from:${sender}`, max: 5 };
    }
  }

  const sendIntent = /\b(envoie|envoyer|envoi|expedie|expedier|mail\s+a|email\s+a)\b/i.test(t);
  if (sendIntent) {
    const hasRecipient = /\b[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}\b/i.test(t) || /\b(a|à)\s+[\p{L}0-9._%+-]{2,}/iu.test(t);
    if (!hasRecipient) {
      return {
        clarification: 'Pour envoyer un email, précise au moins le destinataire, puis le sujet et le message.',
      };
    }
  }

  return null;
}

async function planMailAction(
  text: string,
  openAiApiKey: string,
  openAiBaseUrl: string,
  timeoutMs: number,
  accountLabels: string[] = [],
): Promise<MailAction> {
  const _PLANNER_SYSTEM = buildPlannerSystem(accountLabels);
  const resp = await fetch(`${openAiBaseUrl.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${openAiApiKey}`,
    },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      temperature: 0,
      max_tokens: 300,
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
    throw new Error(`mail_planner_llm_failed:${resp.status}:${raw.slice(0, 200)}`);
  }

  const data = await resp.json() as { choices?: Array<{ message?: { content?: string } }> };
  const content = data.choices?.[0]?.message?.content?.trim() ?? '{}';

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error(`mail_planner_invalid_json:${content.slice(0, 100)}`);
  }

  if (typeof parsed !== 'object' || parsed === null || !('action' in parsed)) {
    throw new Error(`mail_planner_missing_action:${content.slice(0, 100)}`);
  }

  return parsed as MailAction;
}

// ─── Gmail executor ───────────────────────────────────────────────────────────

const GMAIL_BASE = 'https://gmail.googleapis.com/gmail/v1/users/me';

interface GmailMessageRef    { id: string; threadId: string }
interface GmailMessageHeader { name: string; value: string }
interface GmailMessagePart   { mimeType: string; body?: { data?: string } }
interface GmailMessage {
  id: string;
  payload?: {
    headers?: GmailMessageHeader[];
    body?: { data?: string };
    parts?: GmailMessagePart[];
  };
  snippet?: string;
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

function gmailHeader(msg: GmailMessage, name: string): string {
  const raw = msg.payload?.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? '';
  return decodeMimeHeader(raw);
}

async function gmailGet<T>(path: string, token: string): Promise<T> {
  const resp = await fetch(`${GMAIL_BASE}${path}`, {
    headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
    signal: AbortSignal.timeout(8_000),
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    throw new Error(`mail_gmail_get_failed:${resp.status}:${body.slice(0, 200)}`);
  }
  return resp.json() as Promise<T>;
}

async function gmailPost<T>(path: string, token: string, body: object): Promise<T> {
  const resp = await fetch(`${GMAIL_BASE}${path}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(8_000),
  });
  if (!resp.ok) {
    const raw = await resp.text().catch(() => '');
    throw new Error(`mail_gmail_post_failed:${resp.status}:${raw.slice(0, 200)}`);
  }
  return resp.json() as Promise<T>;
}

interface MimeOpts {
  to: string;
  subject: string;
  body: string;
  cc?: string;
  inReplyTo?: string;
  references?: string;
}

function buildRawMime(opts: MimeOpts): string {
  const lines = [
    `To: ${opts.to}`,
    `Subject: =?UTF-8?B?${Buffer.from(opts.subject).toString('base64')}?=`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: base64',
  ];
  if (opts.cc)          lines.push(`Cc: ${opts.cc}`);
  if (opts.inReplyTo)   lines.push(`In-Reply-To: ${opts.inReplyTo}`);
  if (opts.references)  lines.push(`References: ${opts.references}`);
  lines.push('', Buffer.from(opts.body).toString('base64'));
  return Buffer.from(lines.join('\r\n')).toString('base64url');
}

async function findGmailMessages(token: string, q: string, max = 5): Promise<GmailMessageRef[]> {
  const list = await gmailGet<{ messages?: GmailMessageRef[] }>(
    `/messages?q=${encodeURIComponent(q)}&maxResults=${max}`,
    token,
  );
  return list.messages ?? [];
}

async function summarizeGmailMatches(token: string, refs: GmailMessageRef[]): Promise<string[]> {
  const detailed = await Promise.all(
    refs.slice(0, 3).map((m) =>
      gmailGet<GmailMessage>(`/messages/${m.id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject`, token)
        .catch(() => null),
    ),
  );
  return detailed
    .filter((m): m is GmailMessage => m !== null)
    .map((m) => {
      const from = gmailHeader(m, 'From').replace(/<[^>]+>/g, '').trim() || 'Inconnu';
      const subject = gmailHeader(m, 'Subject') || '(sans objet)';
      return `${from} : ${subject}`;
    });
}

function decodeGmailBody(msg: GmailMessage): string {
  const data =
    msg.payload?.body?.data ??
    msg.payload?.parts?.find((p) => p.mimeType === 'text/plain')?.body?.data;
  if (!data) return msg.snippet ?? '(contenu non disponible)';
  return Buffer.from(data, 'base64').toString('utf-8');
}

async function executeGmail(action: MailAction, token: string): Promise<string> {
  switch (action.action) {
    case 'list_inbox': {
      const max = Math.min(action.max ?? 5, 20);
      const q = action.unread_only !== false ? 'in:inbox is:unread' : 'in:inbox';
      const msgs = await findGmailMessages(token, q, max);
      if (msgs.length === 0) return action.unread_only !== false
        ? 'Aucun email non lu dans ta boîte de réception.'
        : 'Ta boîte de réception est vide.';

      const detailed = await Promise.all(
        msgs.slice(0, 5).map((m) =>
          gmailGet<GmailMessage>(`/messages/${m.id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject`, token)
            .catch(() => null),
        ),
      );
      const summaries = detailed
        .filter((m): m is GmailMessage => m !== null)
        .map((m) => {
          const from = gmailHeader(m, 'From').replace(/<[^>]+>/g, '').trim() || 'Inconnu';
          const subject = gmailHeader(m, 'Subject') || '(sans objet)';
          return `${from} : ${subject}`;
        });
      const count = msgs.length;
      const label = action.unread_only !== false ? 'non lus' : '';
      const top = summaries.slice(0, 3);
      const remaining = Math.max(0, count - top.length);
      const tail = remaining > 0 ? ` ; +${remaining} autre${remaining > 1 ? 's' : ''}` : '';
      return `Tu as ${count} email${count > 1 ? 's' : ''} ${label} : ${top.join(' ; ')}${tail}.`;
    }

    case 'search_emails': {
      const max = Math.min(action.max ?? 5, 20);
      const msgs = await findGmailMessages(token, action.query, max);
      if (msgs.length === 0) return `Aucun email trouvé pour "${action.query}".`;

      const detailed = await Promise.all(
        msgs.slice(0, 3).map((m) =>
          gmailGet<GmailMessage>(`/messages/${m.id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject`, token)
            .catch(() => null),
        ),
      );
      const summaries = detailed
        .filter((m): m is GmailMessage => m !== null)
        .map((m) => {
          const from = gmailHeader(m, 'From').replace(/<[^>]+>/g, '').trim() || 'Inconnu';
          const subject = gmailHeader(m, 'Subject') || '(sans objet)';
          return `${from} : ${subject}`;
        });
      return `${msgs.length} résultat${msgs.length > 1 ? 's' : ''} pour "${action.query}" : ${summaries.join(' ; ')}.`;
    }

    case 'send_email': {
      const raw = buildRawMime({ to: action.to, subject: action.subject, body: action.body, cc: action.cc });
      await gmailPost('/messages/send', token, { raw });
      return `Confirmation: email envoyé à ${action.to} avec l'objet "${action.subject}".`;
    }

    case 'mark_read': {
      const parts: string[] = ['is:unread'];
      if (action.subject) parts.push(`subject:${action.subject}`);
      if (action.sender)  parts.push(`from:${action.sender}`);
      const msgs = await findGmailMessages(token, parts.join(' '), 20);
      if (msgs.length === 0) return 'Aucun email non lu correspondant trouvé.';
      const ids = msgs.map((m) => m.id);
      await gmailPost('/messages/batchModify', token, { ids, removeLabelIds: ['UNREAD'] });
      return `${ids.length} email${ids.length > 1 ? 's' : ''} marqué${ids.length > 1 ? 's' : ''} comme lu.`;
    }

    case 'mark_unread': {
      const parts: string[] = ['is:read'];
      if (action.subject) parts.push(`subject:${action.subject}`);
      if (action.sender)  parts.push(`from:${action.sender}`);
      const msgs = await findGmailMessages(token, parts.join(' '), 20);
      if (msgs.length === 0) return 'Aucun email lu correspondant trouvé.';
      const ids = msgs.map((m) => m.id);
      await gmailPost('/messages/batchModify', token, { ids, addLabelIds: ['UNREAD'] });
      return `${ids.length} email${ids.length > 1 ? 's' : ''} marqué${ids.length > 1 ? 's' : ''} comme non lu.`;
    }

    case 'reply_email': {
      const parts: string[] = [];
      if (action.sender)  parts.push(`from:${action.sender}`);
      if (action.subject) parts.push(`subject:${action.subject}`);
      const msgs = await findGmailMessages(token, parts.length > 0 ? parts.join(' ') : 'in:inbox', 5);
      if (msgs.length === 0) return 'Aucun email trouvé pour répondre.';
      if (msgs.length > 1 && action.sender && !action.subject) {
        const options = await summarizeGmailMatches(token, msgs);
        return `J'ai trouvé plusieurs emails possibles de ${action.sender}. Dis-moi lequel tu veux traiter : ${options.join(' ; ')}.`;
      }

      const msg = await gmailGet<GmailMessage>(
        `/messages/${msgs[0].id}?format=metadata&metadataHeaders=Message-ID&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=References`,
        token,
      );
      const origMessageId = gmailHeader(msg, 'Message-ID');
      const origSubject   = gmailHeader(msg, 'Subject');
      const origFrom      = gmailHeader(msg, 'From');
      const toAddr = origFrom.match(/<([^>]+)>/)?.[1] ?? origFrom;
      const references = [gmailHeader(msg, 'References'), origMessageId].filter(Boolean).join(' ');
      const replySubject = origSubject.startsWith('Re:') ? origSubject : `Re: ${origSubject}`;

      const raw = buildRawMime({ to: toAddr, subject: replySubject, body: action.body, inReplyTo: origMessageId, references });
      await gmailPost('/messages/send', token, { raw, threadId: msgs[0].threadId });
      return `Confirmation: réponse envoyée à ${toAddr} concernant "${origSubject || '(sans objet)'}".`;
    }

    case 'forward_email': {
      const parts: string[] = [];
      if (action.sender)  parts.push(`from:${action.sender}`);
      if (action.subject) parts.push(`subject:${action.subject}`);
      const msgs = await findGmailMessages(token, parts.length > 0 ? parts.join(' ') : 'in:inbox', 5);
      if (msgs.length === 0) return 'Aucun email trouvé pour transférer.';
      if (msgs.length > 1 && action.sender && !action.subject) {
        const options = await summarizeGmailMatches(token, msgs);
        return `J'ai trouvé plusieurs emails possibles de ${action.sender}. Dis-moi lequel tu veux transférer : ${options.join(' ; ')}.`;
      }

      const msg = await gmailGet<GmailMessage>(
        `/messages/${msgs[0].id}?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=Date`,
        token,
      );
      const origSubject = gmailHeader(msg, 'Subject');
      const origFrom    = gmailHeader(msg, 'From');
      const origDate    = gmailHeader(msg, 'Date');
      const fwdSubject  = origSubject.startsWith('Fwd:') ? origSubject : `Fwd: ${origSubject}`;
      const fwdBody = [
        action.comment ?? '',
        '',
        '---------- Message transféré ----------',
        `De : ${origFrom}`,
        `Date : ${origDate}`,
        `Objet : ${origSubject}`,
        '',
        msg.snippet ?? '',
      ].join('\n');

      const raw = buildRawMime({ to: action.to, subject: fwdSubject, body: fwdBody });
      await gmailPost('/messages/send', token, { raw });
      return `Confirmation: email "${origSubject || '(sans objet)'}" transféré à ${action.to}.`;
    }

    case 'trash_email': {
      if (!action.sender && !action.subject) return 'Précise l\'expéditeur ou l\'objet de l\'email à supprimer.';
      const parts: string[] = [];
      if (action.sender)  parts.push(`from:${action.sender}`);
      if (action.subject) parts.push(`subject:${action.subject}`);
      const msgs = await findGmailMessages(token, parts.join(' '), 5);
      if (msgs.length === 0) return 'Aucun email trouvé.';
      if (msgs.length > 1) {
        const options = await summarizeGmailMatches(token, msgs);
        return `J'ai trouvé plusieurs emails possibles. Dis-moi lequel tu veux supprimer : ${options.join(' ; ')}.`;
      }
      const toTrash = msgs.slice(0, 1);
      const details = await Promise.all(
        toTrash.map((m) =>
          gmailGet<GmailMessage>(
            `/messages/${m.id}?format=metadata&metadataHeaders=Subject&metadataHeaders=From`,
            token,
          ).catch(() => null),
        ),
      );
      await Promise.all(toTrash.map((m) => gmailPost(`/messages/${m.id}/trash`, token, {})));
      const first = details.find((d): d is GmailMessage => d !== null);
      const firstSubject = first ? (gmailHeader(first, 'Subject') || '(sans objet)') : '(sans objet)';
      return `Confirmation: ${toTrash.length} email${toTrash.length > 1 ? 's' : ''} déplacé${toTrash.length > 1 ? 's' : ''} à la corbeille (ex: "${firstSubject}").`;
    }

    case 'get_email': {
      const parts: string[] = [];
      if (action.sender)  parts.push(`from:${action.sender}`);
      if (action.subject) parts.push(`subject:${action.subject}`);
      const msgs = await findGmailMessages(token, parts.length > 0 ? parts.join(' ') : 'in:inbox', 5);
      if (msgs.length === 0) return 'Aucun email trouvé.';
      if (msgs.length > 1 && action.sender && !action.subject) {
        const options = await summarizeGmailMatches(token, msgs);
        return `J'ai trouvé plusieurs emails possibles de ${action.sender}. Dis-moi lequel tu veux lire : ${options.join(' ; ')}.`;
      }

      const msg = await gmailGet<GmailMessage>(`/messages/${msgs[0].id}?format=full`, token);
      const subject = gmailHeader(msg, 'Subject') || '(sans objet)';
      const from    = gmailHeader(msg, 'From').replace(/<[^>]+>/g, '').trim() || 'Inconnu';
      const body    = cleanMailDetailText(decodeGmailBody(msg)).replace(/\s+/g, ' ').trim().slice(0, 400);
      return `Email de ${from}, objet "${subject}" : ${body}`;
    }

    case 'flag_email': {
      if (!action.sender && !action.subject) return 'Précise l\'expéditeur ou l\'objet de l\'email à flaguer.';
      const parts: string[] = [];
      if (action.sender)  parts.push(`from:${action.sender}`);
      if (action.subject) parts.push(`subject:${action.subject}`);
      const msgs = await findGmailMessages(token, parts.join(' '), 5);
      if (msgs.length === 0) return 'Aucun email trouvé.';
      const ids = msgs.map((m) => m.id);
      const isFlagged = action.flagged !== false;
      await gmailPost('/messages/batchModify', token, {
        ids,
        ...(isFlagged ? { addLabelIds: ['STARRED'] } : { removeLabelIds: ['STARRED'] }),
      });
      const verb = isFlagged ? 'marqué' : 'déflagué';
      return `${ids.length} email${ids.length > 1 ? 's' : ''} ${verb}${ids.length > 1 ? 's' : ''} comme important.`;
    }

    default:
      return 'Action email non reconnue.';
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Returns true for HA_AGENT_MAP keys that should be handled by this mail agent.
 * Mirrors isSearchAgentKey() from search/agents.ts.
 */
export function isMailAgentKey(key: string | undefined): key is string {
  if (!key) return false;
  return key === 'mail' || key.startsWith('mail.');
}

/**
 * Main entry point — call from ingest.ts specialized task pipeline.
 *
 * Mirrors callSearchAgent(): takes user text + env subset → returns TTS string.
 */
export async function callMailAgent(
  text: string,
  env: MailEnv,
  log?: MinLogger,
): Promise<string> {
  const accounts = env.mailAccounts?.length ? env.mailAccounts : buildMailAccounts(env);
  if (accounts.length === 0) {
    return 'La gestion des emails n\'est pas configurée (identifiants Gmail ou Outlook manquants).';
  }
  if (!env.OPENAI_API_KEY) {
    return 'Agent mail non disponible : clé OpenAI manquante.';
  }

  const labels = accounts.map(a => a.label);
  const preclassified = preclassifyMailAction(text);
  if (preclassified && 'clarification' in preclassified) {
    log?.info({ reason: 'preclassified_clarification' }, 'mail_agent_clarification');
    return preclassified.clarification;
  }

  const action = preclassified && !('clarification' in preclassified)
    ? preclassified
    : await planMailAction(text, env.OPENAI_API_KEY, env.OPENAI_BASE_URL, env.OPENAI_TIMEOUT_MS, labels);
  log?.info({ action: action.action, accounts: labels.length }, 'mail_agent_planned');

  // list_inbox and search_emails aggregate across all accounts (unless a specific account is requested)
  if ((action.action === 'list_inbox' || action.action === 'search_emails') && accounts.length > 1 && !action.account) {
    const results = await Promise.allSettled(
      accounts.map(async (acc) => {
        const token = await getAccountTokenWithStore(acc, env.OAUTH_REFRESH_TOKEN_STORE_PATH);
          const result = await executeGmail(action, token);
        return accounts.length > 1 ? `[${acc.label}] ${result}` : result;
      }),
    );
    const successful = results
      .filter((r): r is PromiseFulfilledResult<string> => r.status === 'fulfilled')
      .map(r => r.value);
    if (successful.length === 0) {
      const failures = results
        .filter((r): r is PromiseRejectedResult => r.status === 'rejected')
        .map(r => r.reason instanceof Error ? r.reason.message : String(r.reason));
      log?.warn({ action: action.action, failures }, 'mail_agent_all_accounts_failed');
      return 'Impossible de récupérer les emails pour le moment.';
    }
    const combined = successful.join(' | ');
    const synthesized = await synthesizeMailReplyWithOpenAi({
      openAiApiKey: env.OPENAI_API_KEY!,
      openAiBaseUrl: env.OPENAI_BASE_URL,
      model: env.OPENAI_MODEL_SUMMARY ?? 'gpt-4o-mini',
      timeoutMs: env.OPENAI_TIMEOUT_MS,
      userText: text,
      executorResult: combined,
    });
    log?.info({ action: action.action, result_len: synthesized.length }, 'mail_agent_done');
    return synthesized;
  }

  // Single-account action — match by requested label or use first configured account
  const target = action.account
    ? (accounts.find(a => a.label.toLowerCase() === (action.account as string).toLowerCase()) ?? accounts[0])
    : accounts[0];

  const token = await getAccountTokenWithStore(target, env.OAUTH_REFRESH_TOKEN_STORE_PATH);
  const rawResult = await executeGmail(action, token);
  const synthesized = await synthesizeMailReplyWithOpenAi({
    openAiApiKey: env.OPENAI_API_KEY!,
    openAiBaseUrl: env.OPENAI_BASE_URL,
    model: env.OPENAI_MODEL_SUMMARY ?? 'gpt-4o-mini',
    timeoutMs: env.OPENAI_TIMEOUT_MS,
    userText: text,
    executorResult: rawResult,
  });
  log?.info({ action: action.action, account: target.label, result_len: synthesized.length }, 'mail_agent_done');
  return synthesized;
}
