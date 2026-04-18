/**
 * Mail agent — Gmail (Google) + Outlook (Microsoft Graph) sub-agent.
 *
 * Architecture mirrors todo/todoAgent.ts:
 *   1. LLM planner (gpt-4o-mini, structured JSON) translates voice → MailAction
 *   2. Token refresher acquires a short-lived access token for the active provider
 *   3. Executor calls the provider API
 *   4. Returns a human-readable French string suitable for TTS
 *
 * Provider selection (auto-detected from env vars):
 *   - GOOGLE_REFRESH_TOKEN set      → Gmail API (googleapis.com)
 *   - MICROSOFT_REFRESH_TOKEN set   → Outlook via Microsoft Graph
 *   - Both set                      → Gmail takes priority (configure MAIL_PROVIDER=outlook to override)
 *
 * Routing keys: "mail" | "mail.*"
 * Detected by isMailAgentKey() — mirrors isSearchAgentKey() from search/agents.ts.
 *
 * Required env vars (choose one provider):
 *   Gmail:   GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN
 *   Outlook: MICROSOFT_CLIENT_ID, MICROSOFT_CLIENT_SECRET, MICROSOFT_REFRESH_TOKEN
 *   Common:  OPENAI_API_KEY, OPENAI_BASE_URL, OPENAI_TIMEOUT_MS
 *
 * Optional: MICROSOFT_TENANT_ID (default: "common"), MAIL_PROVIDER ("gmail" | "outlook")
 */

// ─── Action types ─────────────────────────────────────────────────────────────

type ListInboxAction  = { action: 'list_inbox';        max?: number; unread_only?: boolean };
type SearchAction     = { action: 'search_emails';     query: string; max?: number };
type SendAction       = { action: 'send_email';        to: string; subject: string; body: string; cc?: string; bcc?: string; importance?: 'low' | 'normal' | 'high' };
type MarkReadAction   = { action: 'mark_read';         subject?: string; sender?: string };
type MarkUnreadAction = { action: 'mark_unread';       subject?: string; sender?: string };
type ReplyAction      = { action: 'reply_email';       sender?: string; subject?: string; body: string };
type ForwardAction    = { action: 'forward_email';     to: string; sender?: string; subject?: string; comment?: string };
type TrashAction      = { action: 'trash_email';       subject?: string; sender?: string };
type GetEmailAction   = { action: 'get_email';         subject?: string; sender?: string };
type FlagAction       = { action: 'flag_email';        subject?: string; sender?: string; flagged?: boolean };

type MailAction = ListInboxAction | SearchAction | SendAction | MarkReadAction |
  MarkUnreadAction | ReplyAction | ForwardAction | TrashAction | GetEmailAction | FlagAction;

// ─── Minimal env surface ──────────────────────────────────────────────────────

export type MailEnv = {
  // Google Gmail
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  GOOGLE_REFRESH_TOKEN?: string;
  // Microsoft Outlook
  MICROSOFT_CLIENT_ID?: string;
  MICROSOFT_CLIENT_SECRET?: string;
  MICROSOFT_REFRESH_TOKEN?: string;
  MICROSOFT_TENANT_ID?: string;
  // Provider override
  MAIL_PROVIDER?: string;
  // OpenAI planner
  OPENAI_API_KEY?: string;
  OPENAI_BASE_URL: string;
  OPENAI_TIMEOUT_MS: number;
};

type MinLogger = {
  info: (obj: Record<string, unknown>, msg: string) => void;
  warn: (obj: Record<string, unknown>, msg: string) => void;
};

// ─── Provider selection ───────────────────────────────────────────────────────

type MailProvider = 'gmail' | 'outlook';

function selectProvider(env: MailEnv): MailProvider | null {
  const override = env.MAIL_PROVIDER?.trim().toLowerCase();
  if (override === 'outlook' && env.MICROSOFT_CLIENT_ID && env.MICROSOFT_CLIENT_SECRET && env.MICROSOFT_REFRESH_TOKEN) {
    return 'outlook';
  }
  if (env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET && env.GOOGLE_REFRESH_TOKEN) {
    return 'gmail';
  }
  if (env.MICROSOFT_CLIENT_ID && env.MICROSOFT_CLIENT_SECRET && env.MICROSOFT_REFRESH_TOKEN) {
    return 'outlook';
  }
  return null;
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
const _msTokenCache             = new Map<string, CachedToken>();
const _googleLiveRefreshToken   = new Map<string, string>(); // captures rotated tokens
const _msLiveRefreshToken       = new Map<string, string>();
const _googleKeepaliveScheduled = new Set<string>();
const _msKeepaliveScheduled     = new Set<string>();
const TOKEN_EXPIRY_BUFFER_MS    = 60_000;           // refresh access token 60 s before expiry
const KEEPALIVE_INTERVAL_MS     = 30 * 24 * 3_600_000; // 30 days

// ─── Google — token refresh ───────────────────────────────────────────────────

async function refreshGoogleToken(env: {
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  GOOGLE_REFRESH_TOKEN: string;
}): Promise<string> {
  const cacheKey = env.GOOGLE_CLIENT_ID;
  const cached = _googleTokenCache.get(cacheKey);
  if (cached && Date.now() < cached.expiresAt) return cached.accessToken;

  const refreshToken = _googleLiveRefreshToken.get(cacheKey) ?? env.GOOGLE_REFRESH_TOKEN;
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

  if (data.refresh_token) _googleLiveRefreshToken.set(cacheKey, data.refresh_token);

  const expiresIn = typeof data.expires_in === 'number' ? data.expires_in : 3600;
  _googleTokenCache.set(cacheKey, {
    accessToken: data.access_token,
    expiresAt:   Date.now() + expiresIn * 1_000 - TOKEN_EXPIRY_BUFFER_MS,
  });

  if (!_googleKeepaliveScheduled.has(cacheKey)) {
    _googleKeepaliveScheduled.add(cacheKey);
    const timer = setInterval(() => {
      _googleTokenCache.delete(cacheKey);
      refreshGoogleToken(env).catch(() => {});
    }, KEEPALIVE_INTERVAL_MS);
    if (timer.unref) timer.unref();
  }

  return data.access_token;
}

// ─── Microsoft — token refresh ────────────────────────────────────────────────

async function refreshMicrosoftToken(env: {
  MICROSOFT_TENANT_ID?: string;
  MICROSOFT_CLIENT_ID: string;
  MICROSOFT_CLIENT_SECRET: string;
  MICROSOFT_REFRESH_TOKEN: string;
}): Promise<string> {
  const cacheKey = env.MICROSOFT_CLIENT_ID;
  const cached = _msTokenCache.get(cacheKey);
  if (cached && Date.now() < cached.expiresAt) return cached.accessToken;

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
        scope:         'Mail.ReadWrite Mail.Send offline_access',
      }),
      signal: AbortSignal.timeout(8_000),
    },
  );
  if (!resp.ok) {
    _msTokenCache.delete(cacheKey);
    const body = await resp.text().catch(() => '');
    throw new Error(`mail_ms_token_refresh_failed:${resp.status}:${body.slice(0, 200)}`);
  }
  const data = await resp.json() as { access_token?: string; expires_in?: number; refresh_token?: string };
  if (!data.access_token) throw new Error('mail_ms_token_refresh_no_token');

  if (data.refresh_token) _msLiveRefreshToken.set(cacheKey, data.refresh_token);

  const expiresIn = typeof data.expires_in === 'number' ? data.expires_in : 3600;
  _msTokenCache.set(cacheKey, {
    accessToken: data.access_token,
    expiresAt:   Date.now() + expiresIn * 1_000 - TOKEN_EXPIRY_BUFFER_MS,
  });

  if (!_msKeepaliveScheduled.has(cacheKey)) {
    _msKeepaliveScheduled.add(cacheKey);
    const timer = setInterval(() => {
      _msTokenCache.delete(cacheKey);
      refreshMicrosoftToken(env).catch(() => {});
    }, KEEPALIVE_INTERVAL_MS);
    if (timer.unref) timer.unref();
  }

  return data.access_token;
}

// ─── LLM planner ─────────────────────────────────────────────────────────────

const _PLANNER_SYSTEM = `Tu es un assistant de gestion des emails.
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
  flag_email    → "subject" (mots-clés, optionnel), "sender" (nom ou email, optionnel), "flagged" (bool, défaut true)

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

async function planMailAction(
  text: string,
  openAiApiKey: string,
  openAiBaseUrl: string,
  timeoutMs: number,
): Promise<MailAction> {
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

function gmailHeader(msg: GmailMessage, name: string): string {
  return msg.payload?.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? '';
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
          gmailGet<GmailMessage>(`/messages/${m.id}?format=metadata&metadataHeaders=From,Subject`, token)
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
      const label = action.unread_only !== false ? 'non lu' : '';
      return `Tu as ${count} email${count > 1 ? 's' : ''} ${label} : ${summaries.join(' ; ')}.`;
    }

    case 'search_emails': {
      const max = Math.min(action.max ?? 5, 20);
      const msgs = await findGmailMessages(token, action.query, max);
      if (msgs.length === 0) return `Aucun email trouvé pour "${action.query}".`;

      const detailed = await Promise.all(
        msgs.slice(0, 3).map((m) =>
          gmailGet<GmailMessage>(`/messages/${m.id}?format=metadata&metadataHeaders=From,Subject`, token)
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
      return `Email envoyé à ${action.to} avec l'objet "${action.subject}".`;
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
      const msgs = await findGmailMessages(token, parts.length > 0 ? parts.join(' ') : 'in:inbox', 1);
      if (msgs.length === 0) return 'Aucun email trouvé pour répondre.';

      const msg = await gmailGet<GmailMessage>(
        `/messages/${msgs[0].id}?format=metadata&metadataHeaders=Message-ID,Subject,From,References`,
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
      return `Réponse envoyée à ${toAddr}.`;
    }

    case 'forward_email': {
      const parts: string[] = [];
      if (action.sender)  parts.push(`from:${action.sender}`);
      if (action.subject) parts.push(`subject:${action.subject}`);
      const msgs = await findGmailMessages(token, parts.length > 0 ? parts.join(' ') : 'in:inbox', 1);
      if (msgs.length === 0) return 'Aucun email trouvé pour transférer.';

      const msg = await gmailGet<GmailMessage>(
        `/messages/${msgs[0].id}?format=metadata&metadataHeaders=Subject,From,Date`,
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
      return `Email transféré à ${action.to}.`;
    }

    case 'trash_email': {
      if (!action.sender && !action.subject) return 'Précise l\'expéditeur ou l\'objet de l\'email à supprimer.';
      const parts: string[] = [];
      if (action.sender)  parts.push(`from:${action.sender}`);
      if (action.subject) parts.push(`subject:${action.subject}`);
      const msgs = await findGmailMessages(token, parts.join(' '), 5);
      if (msgs.length === 0) return 'Aucun email trouvé.';
      const toTrash = msgs.slice(0, 3);
      await Promise.all(toTrash.map((m) => gmailPost(`/messages/${m.id}/trash`, token, {})));
      return `${toTrash.length} email${toTrash.length > 1 ? 's' : ''} déplacé${toTrash.length > 1 ? 's' : ''} à la corbeille.`;
    }

    case 'get_email': {
      const parts: string[] = [];
      if (action.sender)  parts.push(`from:${action.sender}`);
      if (action.subject) parts.push(`subject:${action.subject}`);
      const msgs = await findGmailMessages(token, parts.length > 0 ? parts.join(' ') : 'in:inbox', 1);
      if (msgs.length === 0) return 'Aucun email trouvé.';

      const msg = await gmailGet<GmailMessage>(`/messages/${msgs[0].id}?format=full`, token);
      const subject = gmailHeader(msg, 'Subject') || '(sans objet)';
      const from    = gmailHeader(msg, 'From').replace(/<[^>]+>/g, '').trim() || 'Inconnu';
      const body    = decodeGmailBody(msg).replace(/\s+/g, ' ').trim().slice(0, 400);
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

// ─── Outlook (MS Graph) executor ─────────────────────────────────────────────

const GRAPH_MAIL = 'https://graph.microsoft.com/v1.0/me';

interface GraphMailMessage {
  id: string;
  subject?: string;
  from?: { emailAddress?: { name?: string; address?: string } };
  bodyPreview?: string;
  receivedDateTime?: string;
  isRead?: boolean;
}

async function graphGet<T>(path: string, token: string): Promise<T> {
  const resp = await fetch(`${GRAPH_MAIL}${path}`, {
    headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
    signal: AbortSignal.timeout(8_000),
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    throw new Error(`mail_graph_get_failed:${resp.status}:${body.slice(0, 200)}`);
  }
  return resp.json() as Promise<T>;
}

async function graphPost<T>(path: string, token: string, body: object): Promise<T | null> {
  const resp = await fetch(`${GRAPH_MAIL}${path}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(8_000),
  });
  if (!resp.ok) {
    const raw = await resp.text().catch(() => '');
    throw new Error(`mail_graph_post_failed:${resp.status}:${raw.slice(0, 200)}`);
  }
  if (resp.status === 202 || resp.headers.get('content-length') === '0') return null;
  return resp.json() as Promise<T>;
}

async function graphPatch(path: string, token: string, body: object): Promise<void> {
  const resp = await fetch(`${GRAPH_MAIL}${path}`, {
    method: 'PATCH',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(8_000),
  });
  if (!resp.ok) {
    const raw = await resp.text().catch(() => '');
    throw new Error(`mail_graph_patch_failed:${resp.status}:${raw.slice(0, 200)}`);
  }
}

async function graphDelete(path: string, token: string): Promise<void> {
  const resp = await fetch(`${GRAPH_MAIL}${path}`, {
    method: 'DELETE',
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(8_000),
  });
  if (!resp.ok && resp.status !== 404) {
    const raw = await resp.text().catch(() => '');
    throw new Error(`mail_graph_delete_failed:${resp.status}:${raw.slice(0, 200)}`);
  }
}

async function findOutlookMessages(
  token: string,
  sender?: string,
  subject?: string,
  max = 5,
): Promise<GraphMailMessage[]> {
  const filters: string[] = [];
  if (sender) {
    const s = sender.replace(/'/g, '');
    filters.push(`(contains(from/emailAddress/name,'${s}') or contains(from/emailAddress/address,'${s}'))`);
  }
  if (subject) {
    filters.push(`contains(subject,'${subject.replace(/'/g, '')}')`);
  }
  const filterStr = filters.length > 0 ? `&$filter=${encodeURIComponent(filters.join(' and '))}` : '';
  const data = await graphGet<{ value: GraphMailMessage[] }>(
    `/messages?$top=${max}&$orderby=receivedDateTime desc&$select=id,subject,from,isRead,receivedDateTime,bodyPreview${filterStr}`,
    token,
  );
  return data.value ?? [];
}

async function executeOutlook(action: MailAction, token: string): Promise<string> {
  switch (action.action) {
    case 'list_inbox': {
      const max = Math.min(action.max ?? 5, 20);
      const filter = action.unread_only !== false ? '&$filter=isRead eq false' : '';
      const data = await graphGet<{ value: GraphMailMessage[] }>(
        `/messages?$orderby=receivedDateTime desc&$top=${max}&$select=subject,from,receivedDateTime,isRead${filter}`,
        token,
      );
      const msgs = data.value ?? [];
      if (msgs.length === 0) return action.unread_only !== false
        ? 'Aucun email non lu.'
        : 'Ta boîte de réception est vide.';
      const summaries = msgs.slice(0, 5).map((m) => {
        const from = m.from?.emailAddress?.name ?? m.from?.emailAddress?.address ?? 'Inconnu';
        return `${from} : ${m.subject ?? '(sans objet)'}`;
      });
      const label = action.unread_only !== false ? ' non lu' : '';
      return `Tu as ${msgs.length} email${msgs.length > 1 ? 's' : ''}${label} : ${summaries.join(' ; ')}.`;
    }

    case 'search_emails': {
      const max = Math.min(action.max ?? 5, 20);
      const data = await graphGet<{ value: GraphMailMessage[] }>(
        `/messages?$search="${encodeURIComponent(action.query)}"&$top=${max}&$select=subject,from`,
        token,
      );
      const msgs = data.value ?? [];
      if (msgs.length === 0) return `Aucun email trouvé pour "${action.query}".`;
      const summaries = msgs.slice(0, 3).map((m) => {
        const from = m.from?.emailAddress?.name ?? 'Inconnu';
        return `${from} : ${m.subject ?? '(sans objet)'}`;
      });
      return `${msgs.length} résultat${msgs.length > 1 ? 's' : ''} : ${summaries.join(' ; ')}.`;
    }

    case 'send_email': {
      const message: Record<string, unknown> = {
        subject: action.subject,
        body:    { contentType: 'Text', content: action.body },
        toRecipients: [{ emailAddress: { address: action.to } }],
      };
      if (action.cc)  message['ccRecipients']  = [{ emailAddress: { address: action.cc } }];
      if (action.bcc) message['bccRecipients'] = [{ emailAddress: { address: action.bcc } }];
      if (action.importance) {
        message['importance'] = action.importance.charAt(0).toUpperCase() + action.importance.slice(1);
      }
      await graphPost('/sendMail', token, { message, saveToSentItems: true });
      return `Email envoyé à ${action.to} avec l'objet "${action.subject}".`;
    }

    case 'mark_read': {
      const filterParts: string[] = ['isRead eq false'];
      if (action.subject) filterParts.push(`contains(subject,'${action.subject.replace(/'/g, '')}')`);
      if (action.sender)  filterParts.push(`contains(from/emailAddress/name,'${action.sender.replace(/'/g, '')}')`);
      const data = await graphGet<{ value: GraphMailMessage[] }>(
        `/messages?$filter=${encodeURIComponent(filterParts.join(' and '))}&$top=20&$select=id,subject`,
        token,
      );
      const msgs = data.value ?? [];
      if (msgs.length === 0) return 'Aucun email non lu correspondant trouvé.';
      await Promise.all(msgs.map((m) => graphPatch(`/messages/${m.id}`, token, { isRead: true })));
      return `${msgs.length} email${msgs.length > 1 ? 's' : ''} marqué${msgs.length > 1 ? 's' : ''} comme lu.`;
    }

    case 'mark_unread': {
      const filterParts: string[] = ['isRead eq true'];
      if (action.subject) filterParts.push(`contains(subject,'${action.subject.replace(/'/g, '')}')`);
      if (action.sender)  filterParts.push(`contains(from/emailAddress/name,'${action.sender.replace(/'/g, '')}')`);
      const data = await graphGet<{ value: GraphMailMessage[] }>(
        `/messages?$filter=${encodeURIComponent(filterParts.join(' and '))}&$top=20&$select=id,subject`,
        token,
      );
      const msgs = data.value ?? [];
      if (msgs.length === 0) return 'Aucun email lu correspondant trouvé.';
      await Promise.all(msgs.map((m) => graphPatch(`/messages/${m.id}`, token, { isRead: false })));
      return `${msgs.length} email${msgs.length > 1 ? 's' : ''} marqué${msgs.length > 1 ? 's' : ''} comme non lu.`;
    }

    case 'reply_email': {
      const msgs = await findOutlookMessages(token, action.sender, action.subject, 1);
      if (msgs.length === 0) return 'Aucun email trouvé pour répondre.';
      await graphPost(`/messages/${msgs[0].id}/reply`, token, { comment: action.body });
      const from = msgs[0].from?.emailAddress?.name ?? msgs[0].from?.emailAddress?.address ?? 'destinataire';
      return `Réponse envoyée à ${from}.`;
    }

    case 'forward_email': {
      const msgs = await findOutlookMessages(token, action.sender, action.subject, 1);
      if (msgs.length === 0) return 'Aucun email trouvé pour transférer.';
      await graphPost(`/messages/${msgs[0].id}/forward`, token, {
        toRecipients: [{ emailAddress: { address: action.to } }],
        comment: action.comment ?? '',
      });
      return `Email transféré à ${action.to}.`;
    }

    case 'trash_email': {
      const msgs = await findOutlookMessages(token, action.sender, action.subject, 3);
      if (msgs.length === 0) return 'Aucun email trouvé.';
      await Promise.all(msgs.map((m) => graphDelete(`/messages/${m.id}`, token)));
      return `${msgs.length} email${msgs.length > 1 ? 's' : ''} supprimé${msgs.length > 1 ? 's' : ''}.`;
    }

    case 'get_email': {
      const msgs = await findOutlookMessages(token, action.sender, action.subject, 1);
      if (msgs.length === 0) return 'Aucun email trouvé.';
      const msg = await graphGet<GraphMailMessage & { body?: { content?: string } }>(
        `/messages/${msgs[0].id}?$select=subject,from,body,receivedDateTime`,
        token,
      );
      const from    = msg.from?.emailAddress?.name ?? 'Inconnu';
      const subject = msg.subject ?? '(sans objet)';
      const bodyText = (msg.body?.content ?? msg.bodyPreview ?? '')
        .replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim().slice(0, 400);
      return `Email de ${from}, objet "${subject}" : ${bodyText}`;
    }

    case 'flag_email': {
      const msgs = await findOutlookMessages(token, action.sender, action.subject, 5);
      if (msgs.length === 0) return 'Aucun email trouvé.';
      const isFlagged = action.flagged !== false;
      await Promise.all(msgs.map((m) =>
        graphPatch(`/messages/${m.id}`, token, { flag: { flagStatus: isFlagged ? 'flagged' : 'notFlagged' } }),
      ));
      const verb = isFlagged ? 'marqué' : 'déflagué';
      return `${msgs.length} email${msgs.length > 1 ? 's' : ''} ${verb}${msgs.length > 1 ? 's' : ''} comme important.`;
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
  const provider = selectProvider(env);
  if (!provider) {
    return 'La gestion des emails n\'est pas configurée (identifiants Gmail ou Outlook manquants).';
  }
  if (!env.OPENAI_API_KEY) {
    return 'Agent mail non disponible : clé OpenAI manquante.';
  }

  const action = await planMailAction(
    text, env.OPENAI_API_KEY, env.OPENAI_BASE_URL, env.OPENAI_TIMEOUT_MS,
  );
  log?.info({ action: action.action, provider }, 'mail_agent_planned');

  if (provider === 'gmail') {
    const token = await refreshGoogleToken({
      GOOGLE_CLIENT_ID:     env.GOOGLE_CLIENT_ID!,
      GOOGLE_CLIENT_SECRET: env.GOOGLE_CLIENT_SECRET!,
      GOOGLE_REFRESH_TOKEN: env.GOOGLE_REFRESH_TOKEN!,
    });
    const result = await executeGmail(action, token);
    log?.info({ action: action.action, provider, result_len: result.length }, 'mail_agent_done');
    return result;
  }

  // provider === 'outlook'
  const token = await refreshMicrosoftToken({
    MICROSOFT_TENANT_ID:     env.MICROSOFT_TENANT_ID,
    MICROSOFT_CLIENT_ID:     env.MICROSOFT_CLIENT_ID!,
    MICROSOFT_CLIENT_SECRET: env.MICROSOFT_CLIENT_SECRET!,
    MICROSOFT_REFRESH_TOKEN: env.MICROSOFT_REFRESH_TOKEN!,
  });
  const result = await executeOutlook(action, token);
  log?.info({ action: action.action, provider, result_len: result.length }, 'mail_agent_done');
  return result;
}
