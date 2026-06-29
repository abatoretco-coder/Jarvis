import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import {
  type CalendarAction,
  callCalendarAgent,
  executeCalendarAgentAction,
  formatCalendarProposal,
  isCalendarAgentKey,
  isCalendarMutation,
  planCalendarAgentAction,
  prepareCalendarMutationAction,
} from '../calendar/calendarAgent';
import {
  type CapabilityAgent,
  type CapabilityEffect,
  findCapabilityByRouteKey,
  requiresCapabilityConfirmation,
} from '../capabilities/capabilityRegistry';
import { enrichWithContextNote } from '../conversation/contextNote';
import { ConversationService } from '../conversation/ConversationService';
import { detectEffectiveThreadId } from '../conversation/conversationWindow';
import {
  type AgentRouteEntry,
  parseAgentMap,
  type RouterResult,
  type RouterTarget,
  routeUserRequest,
  SPOTIFY_AGENT_ID,
  synthesizeAgentResponses,
} from '../conversation/orchestratorRouter';
import { toSingleParagraphPlainText } from '../conversation/plainText';
import {
  createConversationDb,
  SqliteMessageRepository,
  SqliteThreadRepository,
} from '../conversation/repositories/SqliteRepositories';
import { SummarizationService } from '../conversation/SummarizationService';
import {
  buildLastMailSummaryFromState,
  extractMailStateFromReply,
  formatVoiceResponse,
  isLastMailSummaryRequest,
  isLikelyTruncatedVoiceUtterance,
  isVoiceRequest,
  resolveVoiceResponseMode,
  sanitizeResponseAttribution,
  type VoiceResponseDomain,
  type VoiceThreadState,
} from '../conversation/voiceUx';
import {
  buildMailAccounts,
  callMailAgent,
  executeMailAgentAction,
  formatMailActionPreview,
  isMailAgentKey,
  type MailAction,
  planMailAgentAction,
} from '../mail/mailAgent';
import { formatNasStatus, isNasStatusQuery } from '../nas/nasStatusFormat';
import { type PendingMutationRecord,PendingMutationRepository } from '../pendingMutations/PendingMutationRepository';
import {
  INGEST_ACK_CONFIG,
  INGEST_RUNTIME_TUNING_CONFIG,
  ROUTING_CONFIG_HASH,
  ROUTING_CONFIG_VERSION,
  SEMANTIC_ROUTER_CONFIG_HASH,
} from '../routing/deterministic/config/routingDeterministicConfig';
import { dispatchAcceptedE1Route } from '../routing/e1RouteDispatcher';
import { evaluateHighRiskE1Activation } from '../routing/highRiskE1Activation';
import { analyzeMultiIntentLikelihood } from '../routing/multiIntentLikelihood';
import { dispatchAcceptedSearchE2Route } from '../routing/routeDispatcher';
import { warmupRouteEmbeddings } from '../routing/routeScoring';
import { SEMANTIC_ROUTES } from '../routing/semanticRouteCatalog';
import { trySemanticRouter } from '../routing/semanticRouter';
import type { EmbeddingClientConfig, SemanticRouterInput } from '../routing/semanticRouter.types';
import { getSearchAgentConfig, isSearchAgentKey } from '../search/agents';
import type { AppDeps } from '../server';
import { ingestSpotifyRequestSchema, spotifyActionSchema } from '../spotify/contracts';
import { planSpotifyActionFromTextWithOpenAi } from '../spotify/musicAgentPlanner';
import { executeSpotifyCapability } from '../spotify/spotifyExecutor';
import {
  callTodoAgent,
  executeTodoAgentAction,
  formatTodoActionPreview,
  isTodoAgentKey,
  planTodoAgentAction,
  type TodoAction,
} from '../todo/todoAgent';
import {
  isClearlyExternalWeather,
  isClearlyLocalWeather,
  synthesizeDeterministicWeatherReply,
} from '../weather/deterministicWeatherReply';
import { buildWeatherSystemPrompt } from '../weather/prompts/weatherSystemPrompt';
import { buildWeatherUserPrompt } from '../weather/prompts/weatherUserTemplate';
import { buildWeatherSnapshotFromStates, type WeatherSnapshot } from '../weather/weatherSnapshot';
import {
  audioExtensionFromContentType,
  bufferToWebBytes,
  buildFfmpegFilters,
  hasHaTtsConfig,
  pipeStreamThroughFfmpeg,
  resolveOpenAiTtsRuntimeConfig,
  resolveRequestedTtsMode,
  type TtsRouteMode,
} from './ingest/audioRuntime';
import {
  buildSpotifyIngestPayload,
  inferSpotifyRoutingPath,
  type SpotifyResponseShape,
} from './ingest/spotifyResponse';

const threadIdSchema = z.string().trim().min(1).max(128).regex(/^[A-Za-z0-9._:-]+$/u);

const ingestSchema = z.object({
  threadId: threadIdSchema,
  text: z.string().min(1).max(32_000).optional(),
  contextNote: z.string().max(8_000).optional(),
  clientContext: z.record(z.string(), z.unknown()).optional(),
  correlation_id: z.string().optional(),
  user_id: z.string().optional(),
  domain: z.literal('spotify').optional(),
  action: spotifyActionSchema.optional(),
  slots: z.record(z.string(), z.unknown()).optional(),
  context: z.record(z.string(), z.unknown()).optional(),
  understanding: z
    .object({
      entities: z.record(z.string(), z.unknown()).optional(),
    })
    .passthrough()
    .optional(),
});

const responseSchema = z.object({
  threadId: z.string().min(1),
  responseText: z.string().min(1),
  usedSummaryVersion: z.string().min(1).optional(),
  sources: z.array(z.string().url()).optional(),
  replyMeta: z.object({
    kind: z.string().min(1),
    source: z.string().min(1),
    routeKey: z.string().min(1).optional(),
    semanticDecision: z.string().min(1).optional(),
    fallbackReason: z.string().min(1).optional(),
    proposalId: z.string().min(1).optional(),
    pendingAction: z.string().min(1).optional(),
  }).optional(),
});

const historyQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(500).optional(),
});

const sttParamsSchema = z.object({
  engineId: z.string().trim().min(1).max(128).regex(/^[A-Za-z0-9._:-]+$/u),
});

const ttsRequestSchema = z.object({
  text: z.string().min(1).max(5_000),
  language: z.string().min(1).max(32).optional(),
  provider: z.enum(['auto', 'ha', 'openai']).optional(),
});

type EntityStateLike = {
  entity_id: string;
  attributes?: Record<string, unknown>;
};

function uniqueNonEmpty(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const normalized = value.trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

function isLikelyLocalWeatherQuery(text: string): boolean {
  return isClearlyLocalWeather(text) && !isClearlyExternalWeather(text);
}

function normalizeIntentText(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[’']/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isLikelyCalendarIntent(text: string): boolean {
  const t = normalizeIntentText(text);
  if (!t) return false;
  const hasCalendarObject = /\b(agenda|calendrier|evenements?|evenments?|evenemnts?|event|rdv|rendez vous|rendez-vous|reunion|meeting)\b/.test(t);
  if (!hasCalendarObject) return false;
  return /\b(cree|creer|ajoute|ajouter|planifie|programme|mets|mettre|bloque|reserve|liste|montre|cherche|retrouve|recherche|supprime|supprimer|annule|annuler|efface|effacer|modifie|modifier|change|changer|deplace|deplacer|decale|decaler|retire|retirer|enleve|enlever)\b/.test(t)
    || /\b(planning|prochains? evenements?|qu est ce que j ai)\b/.test(t);
}

function inferCalendarRouteKey(text: string): string {
  const t = normalizeIntentText(text);
  if (/\b(retire|retirer|enleve|enlever)\b/.test(t) || /\b(supprime|supprimer|efface|effacer)\b.*\b(description|lieu|rappel|rappels|invite|invites|participant|participants)\b/.test(t)) {
    return 'calendar.remove_from_event';
  }
  if (/\b(supprime|supprimer|annule|annuler|efface|effacer)\b/.test(t)) {
    return 'calendar.delete_event';
  }
  if (/\b(modifie|modifier|change|changer|deplace|deplacer|decale|decaler)\b/.test(t)) {
    return 'calendar.update_event';
  }
  if (/\b(cree|creer|ajoute|ajouter|planifie|programme|mets|mettre|bloque|reserve)\b/.test(t)) {
    return 'calendar.create_event';
  }
  if (/\b(cherche|retrouve|recherche)\b/.test(t)) return 'calendar.search_events';
  return 'calendar.list_upcoming';
}

function normalizeClientChannel(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toLowerCase().replace(/\s+/g, '-');
  if (!normalized) return undefined;
  if (!/^[a-z0-9._-]{2,64}$/.test(normalized)) return undefined;
  return normalized;
}

function applyFrenchVoiceHubGuard(text: string, clientChannel?: string): string {
  if (!clientChannel?.includes('voice-hub')) return text;
  return `${text}\n\nInstruction: Réponds strictement en français.`;
}

const SEMANTIC_E1_LIVE_SUPPORTED_ROUTE_KEYS = new Set(
  SEMANTIC_ROUTES.filter((route) => route.level === 'E1').map((route) => route.key),
);

function resolveExecutorsEntry(agentEntries: AgentRouteEntry[], generalAgentId: string): AgentRouteEntry | null {
  // Preferred explicit mapping: key=executors or direct pseudo-agent id.
  const explicit = agentEntries.find((entry) => entry.key === 'executors' || entry.agentId === 'executors');
  if (explicit) return explicit;

  // Compatibility fallback: if there is exactly one remaining HA specialized target,
  // treat it as the executors route sink.
  const candidates = agentEntries.filter((entry) => {
    if (entry.agentId === generalAgentId) return false;
    if (entry.key === 'weather') return false;
    if (isSearchAgentKey(entry.key)) return false;
    if (isTodoAgentKey(entry.key)) return false;
    if (isMailAgentKey(entry.key)) return false;
    if (isCalendarAgentKey(entry.key)) return false;
    if (entry.agentId === SPOTIFY_AGENT_ID) return false;
    return true;
  });
  return candidates.length === 1 ? candidates[0] : null;
}

async function synthesizeWeatherReplyWithOpenAi(params: {
  openAiApiKey: string;
  openAiBaseUrl: string;
  model: string;
  timeoutMs: number;
  userText: string;
  weather: WeatherSnapshot;
  log?: { info: (obj: Record<string, unknown>, msg: string) => void; warn: (obj: Record<string, unknown>, msg: string) => void };
}): Promise<string> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), params.timeoutMs);

  const systemPrompt = buildWeatherSystemPrompt();

  const userPrompt = buildWeatherUserPrompt(params.userText, params.weather);

  try {
    const response = await fetch(`${params.openAiBaseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${params.openAiApiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: params.model,
        temperature: 0.2,
        max_tokens: 220,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
      }),
      signal: controller.signal,
    });

    const raw = await response.text();
    if (!response.ok) {
      throw new Error(`weather_openai_failed:${response.status}:${raw.slice(0, 500)}`);
    }

    const parsed = raw ? JSON.parse(raw) as Record<string, unknown> : {};
    const choices = Array.isArray(parsed.choices) ? parsed.choices as Array<{ message?: { content?: string } }> : [];
    const content = choices[0]?.message?.content?.trim() ?? '';
    if (!content) {
      throw new Error('weather_openai_empty_response');
    }

    params.log?.info({ model: params.model, content_len: content.length }, 'weather_openai_done');
    return toSingleParagraphPlainText(content);
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Calls the appropriate Perplexity/OpenAI search agent based on a SearchAgentConfig.
 * Bypasses HA entirely — config controls model, prompt, and filters per agent type.
 */
type SearchAgentResponse = {
  text: string;
  sources: string[];
};

async function callSearchAgent(
  agentKey: string,
  params: {
    text: string;
    openAiApiKey: string;
    openAiBaseUrl: string;
    perplexityApiKey?: string;
    perplexityBaseUrl?: string;
    timeoutMs: number;
    log?: { info: (obj: Record<string, unknown>, msg: string) => void };
  },
): Promise<SearchAgentResponse> {
  const config = getSearchAgentConfig(agentKey);
  const now = new Date();
  const tz = 'Europe/Paris';
  const dateStr = now.toLocaleDateString('fr-FR', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: tz,
  });
  const dayStr = now.toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric', timeZone: tz });

  const systemPrompt = config.buildSystemPrompt(dateStr);
  const userQuery = config.buildUserQuery(params.text, dayStr);

  const usePerplexity = Boolean(params.perplexityApiKey);
  const apiKey = usePerplexity ? params.perplexityApiKey! : params.openAiApiKey;
  const baseUrl = usePerplexity
    ? (params.perplexityBaseUrl ?? 'https://api.perplexity.ai')
    : params.openAiBaseUrl;
  const model = usePerplexity ? config.model : config.openAiModel;

  params.log?.info({ provider: usePerplexity ? 'perplexity' : 'openai', model, agentKey }, 'search_agent_provider');

  const body: Record<string, unknown> = {
    model,
    temperature: config.temperature,
    top_p: config.topP,
    max_tokens: config.maxTokens,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userQuery },
    ],
  };

  if (usePerplexity) {
    body['return_related_questions'] = false;
    let hasAbsoluteDateFilter = false;
    if (config.searchAfterDays != null) {
      const cutoff = new Date(Date.now() - config.searchAfterDays * 24 * 3600 * 1000);
      const mm = String(cutoff.getMonth() + 1).padStart(2, '0');
      const dd = String(cutoff.getDate()).padStart(2, '0');
      body['search_after_date_filter'] = `${mm}/${dd}/${cutoff.getFullYear()}`;
      hasAbsoluteDateFilter = true;
    }
    if (!hasAbsoluteDateFilter && config.searchRecencyFilter) {
      body['search_recency_filter'] = config.searchRecencyFilter;
    }
    if (config.searchLanguageFilter) body['search_language_filter'] = config.searchLanguageFilter;
    if (config.languagePreference) body['language_preference'] = config.languagePreference;
  } else {
    body['web_search_options'] = { search_context_size: 'high' };
  }

  // Both Perplexity and OpenAI use /chat/completions — model name selects search capability.
  const chatPath = '/chat/completions';
  const resp = await fetch(
    `${baseUrl.replace(/\/$/, '')}${chatPath}`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(params.timeoutMs),
    },
  );

  if (!resp.ok) {
    const rawBody = await resp.text().catch(() => '');
    throw new Error(`search_direct_http_${resp.status}: ${rawBody.slice(0, 200)}`);
  }

  const data = await resp.json() as { choices?: Array<{ message?: { content?: string } }> };
  const raw = data.choices?.[0]?.message?.content?.trim();
  const content = raw ? sanitizeSearchAgentContent(raw) : '';
  const sources = raw ? extractSearchSources(raw) : [];
  params.log?.info({ provider: usePerplexity ? 'perplexity' : 'openai', model, agentKey, content_len: content?.length ?? 0, content_preview: content?.slice(0, 120) }, 'search_agent_raw_response');
  return { text: content || "Je n'ai pas obtenu cette information.", sources };
}

function extractSearchSources(raw: string): string[] {
  const urls = new Set<string>();
  for (const match of raw.matchAll(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/giu)) {
    if (match[2]) urls.add(match[2].replace(/[.,;:]+$/u, ''));
  }
  for (const match of raw.matchAll(/https?:\/\/[^\s)\]]+/giu)) {
    urls.add(match[0].replace(/[.,;:]+$/u, ''));
  }
  return [...urls].slice(0, 10);
}

function sanitizeSearchAgentContent(raw: string): string {
  const withoutMarkdown = raw
    .replace(/\[\d+\]/g, '')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/\*(.+?)\*/g, '$1')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/gi, '$1');

  const filteredLines = withoutMarkdown
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => {
      if (/^(sources?|references?|références?)\s*[:-]/iu.test(line)) return false;
      if (/^(?:[-*]\s*)?https?:\/\/\S+$/iu.test(line)) return false;
      return true;
    });

  const compact = filteredLines.join(' ')
    .replace(/(?:^|\s)\((?:source|sources|reference|references|référence|références)\s*:[^)]+\)/giu, ' ')
    .replace(/\b(?:sources?|references?|références?)\s*:\s*(?:https?:\/\/\S+\s*)+/giu, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();

  return toSingleParagraphPlainText(compact);
}


function isElevenLabsEngine(engineId: string): boolean {
  return /elevenlabs/i.test(engineId);
}

function shouldFallbackFromElevenLabs(status: number, bodyText: string): boolean {
  if (status === 429 || status >= 500) return true;
  return /(quota|capacity|limit|credit|insufficient|exceed|plan)/i.test(bodyText);
}

async function transcribeWithOpenAi(params: {
  env: AppDeps['env'];
  body: Buffer;
  incomingContentType: string;
}): Promise<{ text: string; model: string }> {
  const openAiApiKey = params.env.OPENAI_API_KEY?.trim();
  if (!openAiApiKey) {
    throw new Error('openai_api_key_missing');
  }

  const model = params.env.OPENAI_STT_MODEL.trim();
  const form = new FormData();
  form.set('model', model);
  if (params.env.OPENAI_STT_LANGUAGE?.trim()) {
    form.set('language', params.env.OPENAI_STT_LANGUAGE.trim());
  }

  const fileExt = audioExtensionFromContentType(params.incomingContentType);
  form.set('file', new Blob([bufferToWebBytes(params.body)], { type: params.incomingContentType }), `audio.${fileExt}`);

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), params.env.OPENAI_STT_TIMEOUT_MS);
  const response = await fetch(`${params.env.OPENAI_BASE_URL.replace(/\/$/, '')}/audio/transcriptions`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${openAiApiKey}`,
    },
    body: form,
    signal: controller.signal,
  }).finally(() => clearTimeout(timeoutId));

  const raw = await response.text();
  if (!response.ok) {
    throw new Error(`openai_stt_failed:${response.status}:${raw.slice(0, 500)}`);
  }

  let parsed: unknown;
  try {
    parsed = raw ? (JSON.parse(raw) as unknown) : {};
  } catch {
    parsed = {};
  }

  const root = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  const text = toSingleParagraphPlainText(typeof root.text === 'string' ? root.text : '');
  if (!text) {
    throw new Error('openai_stt_empty_transcript');
  }

  return { text, model };
}



function toEntityStates(input: unknown): EntityStateLike[] {
  if (!Array.isArray(input)) return [];

  return input.filter((item): item is EntityStateLike => {
    if (!item || typeof item !== 'object') return false;
    const entityId = (item as { entity_id?: unknown }).entity_id;
    return typeof entityId === 'string' && entityId.length > 0;
  });
}



/**
 * Pick a short TTS-safe ack phrase based on the slow-agent keys that were selected.
 * Returns null when no ack is appropriate (e.g. no slow agents).
 */
function getIngestAckText(keys: (string | undefined)[]): string | null {
  if (keys.length === 0) return null;
  const cfg = INGEST_ACK_CONFIG;
  const ks = keys.map((k) => k ?? '');
  const hasMail = ks.some((k) => k === 'mail' || cfg.mailPrefixes.some((prefix) => k.startsWith(prefix)));
  const hasTodo = ks.some((k) => k === 'todo' || cfg.todoPrefixes.some((prefix) => k.startsWith(prefix)));
  const hasCalendar = ks.some((k) => k === 'calendar' || cfg.calendarPrefixes.some((prefix) => k.startsWith(prefix)));
  const hasSearch = ks.some((k) => k.startsWith(cfg.searchPrefix));
  const hasWeather = ks.some((k) => k === 'weather' || cfg.weatherPrefixes.some((prefix) => k.startsWith(prefix)));
  if (hasMail && !hasTodo && !hasCalendar && !hasSearch) return cfg.responses.mailOnly;
  if (hasTodo && !hasMail && !hasCalendar && !hasSearch) return cfg.responses.todoOnly;
  if (hasCalendar && !hasMail && !hasTodo && !hasSearch) return cfg.responses.calendarOnly;
  if (hasWeather && !hasMail && !hasTodo && !hasCalendar && !hasSearch) return cfg.responses.weatherOnly;
  if (hasSearch && !hasMail && !hasTodo && !hasCalendar && ks.length === 1) return cfg.responses.searchOnly;
  return cfg.responses.default;
}

function getContextualFallbackAck(text: string): string {
  const normalized = text.toLocaleLowerCase('fr-FR');
  if (/\b(mail|email|courriel|boite de reception)\b/u.test(normalized)) {
    return 'Je consulte tes emails, un instant.';
  }
  if (/\b(nas|serveur|stockage|disque|temperature|memoire|ram|cpu)\b/u.test(normalized)) {
    return 'Je verifie le serveur, un instant.';
  }
  if (/\b(recherche|cherche|actualite|actualité|information|compare|analyse)\b/u.test(normalized)) {
    return 'Je regarde ca, un instant.';
  }
  if (/\b(pourquoi|explique|reflechis|réfléchis|raisonne)\b/u.test(normalized)) {
    return 'Je reflechis, laisse-moi un instant.';
  }
  return 'Je regarde, un instant.';
}

export function registerIngestRoute(app: FastifyInstance, deps: AppDeps): void {
  const runtimeCfg = INGEST_RUNTIME_TUNING_CONFIG;

  app.addContentTypeParser(/^audio\/.+$/u, { parseAs: 'buffer' }, (_req, body, done) => {
    done(null, body);
  });

  app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer' }, (_req, body, done) => {
    done(null, body);
  });

  const db = createConversationDb(deps.env.CONVERSATION_DB_PATH);
  const threadRepository = new SqliteThreadRepository(db);
  const messageRepository = new SqliteMessageRepository(db);
  const pendingMutationRepository = new PendingMutationRepository(db);

  // ─── Retention cleanup: purge threads inactive for more than 7 days ───────
  const RETENTION_MS = runtimeCfg.conversationRetentionMs; // default: 7 days
  const CLEANUP_INTERVAL_MS = runtimeCfg.retentionCleanupIntervalMs; // default: once per day
  const runRetentionCleanup = async () => {
    try {
      const cutoff = Date.now() - RETENTION_MS;
      const deleted = await threadRepository.purgeThreadsOlderThan(cutoff);
      if (deleted > 0) {
        app.log.info({ deleted }, 'conversation_retention_purge');
      }
    } catch (err) {
      app.log.warn({ err }, 'conversation_retention_purge_error');
    }
  };
  void runRetentionCleanup();
  const retentionTimer = setInterval(() => { void runRetentionCleanup(); }, CLEANUP_INTERVAL_MS);
  retentionTimer.unref();
  app.addHook('onClose', async () => {
    clearInterval(retentionTimer);
    db.close();
  });

  const summarizationService = new SummarizationService(threadRepository, messageRepository, {
    hotWindowK: deps.env.LIMIT_K,
    minDeltaM: deps.env.LIMIT_M,
    triggerEveryInteractions: 10,
    openAiApiKey: deps.env.OPENAI_API_KEY,
    openAiBaseUrl: deps.env.OPENAI_BASE_URL,
    openAiModelSummary: deps.env.OPENAI_MODEL_SUMMARY,
    openAiTimeoutMs: deps.env.OPENAI_TIMEOUT_MS,
  });

  const conversationService = new ConversationService(threadRepository, messageRepository, {
    haBaseUrl: deps.env.HA_BASE_URL ?? '',
    haToken: deps.env.HA_TOKEN ?? '',
    requestTimeoutMs: deps.env.HA_TIMEOUT_MS,
    minIntervalMs: deps.env.HA_CONVERSATION_MIN_INTERVAL_MS,
    retryCount: deps.env.HA_CONVERSATION_RETRY_COUNT,
    retryDelayMs: deps.env.HA_CONVERSATION_RETRY_DELAY_MS,
    onFirstInteractionPersisted: (threadId, userText, assistantText) => {
      summarizationService.startTitleGeneration(threadId, userText, assistantText);
    },
  });

  const semanticEmbeddingCfg: EmbeddingClientConfig = {
    baseUrl: deps.env.OPENAI_BASE_URL,
    model: deps.env.SEMANTIC_ROUTER_EMBEDDING_MODEL,
    timeoutMs: deps.env.SEMANTIC_ROUTER_TIMEOUT_MS,
    apiKey: deps.env.OPENAI_API_KEY,
  };

  if (
    process.env.NODE_ENV !== 'test'
    && deps.env.SEMANTIC_ROUTER_ENABLED
    && deps.env.SEMANTIC_ROUTER_WARMUP_ON_STARTUP
    && Boolean(deps.env.OPENAI_API_KEY?.trim())
  ) {
    void warmupRouteEmbeddings({
      routes: SEMANTIC_ROUTES,
      config: semanticEmbeddingCfg,
      batchSize: deps.env.SEMANTIC_ROUTER_WARMUP_BATCH_SIZE,
    })
      .then((summary) => {
        app.log.info(
          {
            model: semanticEmbeddingCfg.model,
            warmed: summary.warmed,
            skipped: summary.skipped,
            failed: summary.failed,
            batchSize: deps.env.SEMANTIC_ROUTER_WARMUP_BATCH_SIZE,
          },
          'semantic_router_embedding_warmup_done',
        );
      })
      .catch((err) => {
        app.log.warn({ err }, 'semantic_router_embedding_warmup_failed');
      });
  }

  // Warm up dedicated OpenAI-compatible TTS backend (for example Kokoro)
  // to reduce first-request latency after a fresh container restart.
  if (process.env.NODE_ENV !== 'test') {
    const startupTtsCfg = resolveOpenAiTtsRuntimeConfig(deps.env);
    const hasDedicatedTtsBackend =
      Boolean(startupTtsCfg)
      && typeof deps.env.OPENAI_TTS_BASE_URL === 'string'
      && deps.env.OPENAI_TTS_BASE_URL.trim().length > 0;

    if (startupTtsCfg && hasDedicatedTtsBackend) {
      setTimeout(() => {
        const t0 = Date.now();
        const ctrl = new AbortController();
        const timeoutId = setTimeout(() => ctrl.abort(), startupTtsCfg.timeoutMs);
        void fetch(`${startupTtsCfg.baseUrl.replace(/\/$/, '')}/audio/speech`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${startupTtsCfg.apiKey}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            model: startupTtsCfg.model,
            voice: startupTtsCfg.voice,
            input: 'warmup',
            response_format: startupTtsCfg.format,
            speed: startupTtsCfg.speed,
            ...(startupTtsCfg.instructions ? { instructions: startupTtsCfg.instructions } : {}),
          }),
          signal: ctrl.signal,
        })
          .then(async (res) => {
            if (!res.ok) {
              const body = await res.text();
              app.log.warn({ status: res.status, body: body.slice(0, 200) }, 'tts_openai_startup_warmup_failed');
              return;
            }
            await res.arrayBuffer();
            app.log.info({ elapsed_ms: Date.now() - t0 }, 'tts_openai_startup_warmup_done');
          })
          .catch((err) => {
            app.log.warn({ err }, 'tts_openai_startup_warmup_failed');
          })
          .finally(() => {
            clearTimeout(timeoutId);
          });
      }, 1_000);
    }
  }

  let ttsProviderCache: { providers: Set<string>; at: number } | null = null;
  let ttsProviderRefreshPromise: Promise<void> | null = null;
  const TTS_PROVIDER_CACHE_TTL_MS = runtimeCfg.ttsProviderCacheTtlMs;

  const refreshTtsProviderCache = (): Promise<void> => {
    if (!deps.ha) return Promise.resolve();
    if (ttsProviderRefreshPromise) return ttsProviderRefreshPromise;
    ttsProviderRefreshPromise = deps.ha.getStates()
      .then((statesRaw) => {
        const providers = new Set(
          toEntityStates(statesRaw)
            .map((item) => item.entity_id)
            .filter((entityId) => entityId.startsWith('tts.'))
        );
        ttsProviderCache = { providers, at: Date.now() };
      })
      .catch((err) => {
        app.log.warn({ err }, 'tts_provider_discovery_failed');
      })
      .finally(() => {
        ttsProviderRefreshPromise = null;
      });
    return ttsProviderRefreshPromise;
  };

  // ─── TTS circuit breaker ─────────────────────────────────────────────────
  const ttsCb = new Map<string, { failures: number; openUntil: number }>();
  const CB_THRESHOLD = runtimeCfg.ttsCircuitBreakerThreshold;
  const CB_OPEN_MS = runtimeCfg.ttsCircuitBreakerOpenMs;

  function isTtsCbOpen(engineId: string): boolean {
    const state = ttsCb.get(engineId);
    if (!state) return false;
    if (Date.now() > state.openUntil) { ttsCb.delete(engineId); return false; }
    return state.failures >= CB_THRESHOLD;
  }

  function recordTtsFailure(engineId: string): void {
    const state = ttsCb.get(engineId) ?? { failures: 0, openUntil: 0 };
    state.failures += 1;
    if (state.failures >= CB_THRESHOLD) state.openUntil = Date.now() + CB_OPEN_MS;
    ttsCb.set(engineId, state);
  }

  function recordTtsSuccess(engineId: string): void {
    ttsCb.delete(engineId);
  }

  // ─── TTS pre-warm cache (populated by ingest, consumed by /v1/tts) ────────
  const TTS_WARM_TTL_MS = 30_000;
  type TtsWarmEntry = { bytes: Buffer; contentType: string; at: number };
  const ttsWarmCache = new Map<string, TtsWarmEntry>();
  const ttsWarmInFlight = new Map<string, Promise<TtsWarmEntry | null>>();

  /** Fire-and-forget: generates TTS audio for `text` using the primary engine
   *  and stores it in `ttsWarmCache` so the Desktop's subsequent /v1/tts call
   *  returns immediately without waiting for HA/OpenAI. */
  function warmTtsInBackground(text: string): void {
    const key = text.trim().slice(0, 512);
    const existing = ttsWarmCache.get(key);
    if (existing && Date.now() - existing.at < TTS_WARM_TTL_MS) return;
    if (ttsWarmInFlight.has(key)) return;

    const openAiTtsCfg = resolveOpenAiTtsRuntimeConfig(deps.env);
    const useDedicatedOpenAiTts =
      Boolean(openAiTtsCfg)
      && typeof deps.env.OPENAI_TTS_BASE_URL === 'string'
      && deps.env.OPENAI_TTS_BASE_URL.trim().length > 0;

    if (!useDedicatedOpenAiTts && (!deps.env.HA_BASE_URL || !deps.env.HA_TOKEN)) return;

    const work = (async (): Promise<TtsWarmEntry | null> => {
      try {
        if (useDedicatedOpenAiTts && openAiTtsCfg) {
          const response = await Promise.race([
            fetch(`${openAiTtsCfg.baseUrl.replace(/\/$/, '')}/audio/speech`, {
              method: 'POST',
              headers: {
                authorization: `Bearer ${openAiTtsCfg.apiKey}`,
                'content-type': 'application/json',
              },
              body: JSON.stringify({
                model: openAiTtsCfg.model,
                voice: openAiTtsCfg.voice,
                input: text,
                response_format: openAiTtsCfg.format,
                speed: openAiTtsCfg.speed,
                ...(openAiTtsCfg.instructions ? { instructions: openAiTtsCfg.instructions } : {}),
              }),
            }),
            new Promise<never>((_, rej) => setTimeout(() => rej(new Error('warm_openai_timeout')), openAiTtsCfg.timeoutMs)),
          ]);
          if (!response.ok) return null;

          const contentType = response.headers.get('content-type') ?? 'audio/mpeg';
          const openAiFilters = buildFfmpegFilters({ speed: deps.env.TTS_SPEED, pitchSemitones: 0, clarity: false }, true);
          const openAiBody = response.body;
          const bytes = openAiFilters.length > 0 && openAiBody
            ? await pipeStreamThroughFfmpeg(openAiBody, openAiFilters)
            : Buffer.from(await response.arrayBuffer());

          const entry: TtsWarmEntry = { bytes, contentType, at: Date.now() };
          ttsWarmCache.set(key, entry);
          if (ttsWarmCache.size > 40) {
            const now = Date.now();
            for (const [k, v] of ttsWarmCache) { if (now - v.at > TTS_WARM_TTL_MS) ttsWarmCache.delete(k); }
          }
          app.log.info({ text_chars: text.length }, 'tts_warm_cached');
          return entry;
        }

        const haBase = deps.env.HA_BASE_URL!.replace(/\/$/, '');
        const engineId = deps.env.HA_TTS_ENTITY_ID?.trim() || 'tts.elevenlabs_text_to_speech';
        if (isTtsCbOpen(engineId)) return null;

        // Step 1: get TTS URL (HA caches by text, so this is cheap on repeat)
        const urlRes = await Promise.race([
          fetch(`${haBase}/api/tts_get_url`, {
            method: 'POST',
            headers: { authorization: `Bearer ${deps.env.HA_TOKEN}`, 'content-type': 'application/json' },
            body: JSON.stringify({ engine_id: engineId, message: text, cache: true }),
          }),
          new Promise<never>((_, rej) => setTimeout(() => rej(new Error('warm_url_timeout')), deps.env.HA_TIMEOUT_MS)),
        ]);
        if (!urlRes.ok) { recordTtsFailure(engineId); return null; }

        const urlPayload = (await urlRes.json()) as { path?: string; url?: string };
        const audioUrl = typeof urlPayload.path === 'string' ? `${haBase}${urlPayload.path}` : urlPayload.url;
        if (!audioUrl) return null;

        // Step 2: fetch audio bytes
        const audioRes = await Promise.race([
          fetch(audioUrl, { headers: { authorization: `Bearer ${deps.env.HA_TOKEN}` } }),
          new Promise<never>((_, rej) => setTimeout(() => rej(new Error('warm_audio_timeout')), deps.env.HA_TIMEOUT_MS)),
        ]);
        if (!audioRes.ok) { recordTtsFailure(engineId); return null; }

        const contentType = audioRes.headers.get('content-type') ?? 'audio/mpeg';
        const haFilters = buildFfmpegFilters({
          speed: deps.env.TTS_SPEED,
          pitchSemitones: deps.env.TTS_PITCH_SEMITONES,
          clarity: deps.env.TTS_CLARITY,
        });
        const body = audioRes.body;
        const bytes = haFilters.length > 0 && body
          ? await pipeStreamThroughFfmpeg(body, haFilters)
          : Buffer.from(await audioRes.arrayBuffer());

        recordTtsSuccess(engineId);
        const entry: TtsWarmEntry = { bytes, contentType, at: Date.now() };
        ttsWarmCache.set(key, entry);
        // Simple GC: prune stale entries when cache grows
        if (ttsWarmCache.size > 40) {
          const now = Date.now();
          for (const [k, v] of ttsWarmCache) { if (now - v.at > TTS_WARM_TTL_MS) ttsWarmCache.delete(k); }
        }
        app.log.info({ text_chars: text.length }, 'tts_warm_cached');
        return entry;
      } catch {
        return null;
      } finally {
        ttsWarmInFlight.delete(key);
      }
    })();

    ttsWarmInFlight.set(key, work);
  }

  // ─── Per-endpoint perf samples (rolling window 200) ──────────────────────
  const PERF_MAX = runtimeCfg.perfMaxSamples;
  const perfSamples = new Map<string, number[]>();
  const voiceThreadState = new Map<string, VoiceThreadState>();
  type PendingMutation =
    | {
        agent: 'calendar';
        action: 'create_event' | 'delete_event' | 'update_event' | 'remove_from_event' | 'disambiguate_event';
        effect: CapabilityEffect;
        preview: string;
        payload: { plan?: CalendarAction; disambiguation?: { action: Extract<CalendarAction, { action: 'delete_event' | 'update_event' | 'remove_from_event' }>; candidates: Array<{ index: number; eventId: string; calendarId: string; title: string; start: string }> } };
        proposalId: string;
        threadId: string;
        clientChannel?: string;
        expiresAtMs: number;
        routeKey: 'calendar.create_event' | 'calendar.delete_event' | 'calendar.update_event' | 'calendar.remove_from_event';
      }
    | {
        agent: Extract<CapabilityAgent, 'mail' | 'todo'>;
        action: string;
        effect: CapabilityEffect;
        preview: string;
        payload: { routeKey?: string; text: string; plan?: MailAction | TodoAction };
        proposalId: string;
        threadId: string;
        clientChannel?: string;
        expiresAtMs: number;
        routeKey?: string;
      };
  type PendingCalendarMutation = Extract<PendingMutation, { agent: 'calendar' }>;
  type PendingCalendarAction = PendingCalendarMutation['action'];
  type ExecutableCalendarAction = Exclude<PendingCalendarAction, 'disambiguate_event'>;
  type PendingCalendarRouteKey = PendingCalendarMutation['routeKey'];
  const PENDING_MUTATION_TTL_MS = 10 * 60_000;

  const buildCalendarEnv = () => ({
    GOOGLE_CLIENT_ID:             deps.env.GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET:         deps.env.GOOGLE_CLIENT_SECRET,
    GOOGLE_REFRESH_TOKEN:         deps.env.GOOGLE_REFRESH_TOKEN,
    OAUTH_REFRESH_TOKEN_STORE_PATH: deps.env.OAUTH_REFRESH_TOKEN_STORE_PATH,
    GOOGLE_CALENDAR_CALENDAR_IDS: deps.env.GOOGLE_CALENDAR_CALENDAR_IDS,
    GOOGLE_CALENDAR_DEFAULT_CREATE_CALENDAR_ID: deps.env.GOOGLE_CALENDAR_DEFAULT_CREATE_CALENDAR_ID,
    GOOGLE_CALENDAR_DEFAULT_CREATE_CALENDAR_LABEL: deps.env.GOOGLE_CALENDAR_DEFAULT_CREATE_CALENDAR_LABEL,
    OPENAI_API_KEY:               deps.env.OPENAI_API_KEY,
    OPENAI_BASE_URL:              deps.env.OPENAI_BASE_URL,
    OPENAI_TIMEOUT_MS:            deps.env.OPENAI_TIMEOUT_MS,
  });

  const normalizeConfirmationText = (value: string): string => (
    value
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/gu, '')
      .toLowerCase()
      .replace(/[^\p{Letter}\p{Number}\s'-]/gu, ' ')
      .replace(/\s+/gu, ' ')
      .trim()
  );

  const isClearCalendarConfirmation = (value: string, proposalId?: string): boolean => {
    const normalized = normalizeConfirmationText(value);
    const normalizedProposal = proposalId ? normalizeConfirmationText(proposalId) : '';
    return Boolean(normalizedProposal && normalized.includes(normalizedProposal))
      || /^(confirme|je confirme|valide|cree|ajoute).*(agenda|calendrier|evenement|rdv)/u.test(normalized)
      || /^(confirme|valide|cree|ajoute) (l'|le |cet |cette )?(evenement|rdv)/u.test(normalized);
  };

  const isClearMutationConfirmation = (value: string, mutation: PendingMutation): boolean => {
    const normalized = normalizeConfirmationText(value);
    if (isClearCalendarConfirmation(value, mutation.proposalId)) return true;
    if (/^(je )?confirm(?:e|er|r)?$/u.test(normalized)) return true;
    if (/^(oui|ok|d accord|vas y|c est bon)( je )?confirm(?:e|er|r)?$/u.test(normalized)) return true;
    if (/^(valide|je valide|tu peux|vas y|c est bon)( l action| la suppression| la modification| l envoi| la tache| l evenement| le rdv)?$/u.test(normalized)) return true;
    if (mutation.agent === 'calendar' && /^(supprime|annule|modifie|retire)( l evenement| le rdv| ca)?$/u.test(normalized)) return true;
    return false;
  };

  const isLikelyMutationConfirmationAttempt = (value: string): boolean => {
    const normalized = normalizeConfirmationText(value);
    return /\b(confirm|confirme|confirmation|valide|oui|ok|vas y|c est bon)\b/u.test(normalized);
  };

  const isClearCalendarRejection = (value: string): boolean => {
    const normalized = normalizeConfirmationText(value);
    return /^(non|annule|annuler|stop|laisse tomber|pas maintenant|ne fais rien)( merci)?$/u.test(normalized);
  };

  const buildMutationProposalText = (mutation: PendingMutation): string => {
    return `${mutation.preview} Tu confirmes ?`;
  };

  const createPendingMutationProposal = async (input: {
    threadId: string;
    clientChannel?: string;
    agent: Extract<CapabilityAgent, 'mail' | 'todo'>;
    action: string;
    effect: CapabilityEffect;
    payload: { routeKey?: string; text: string; plan?: MailAction | TodoAction };
    preview?: string;
    routeKey?: string;
  }): Promise<PendingMutation> => {
    const prefix = input.agent === 'mail' ? 'mail' : 'todo';
    const proposalId = `${prefix}${randomUUID().slice(0, 8)}`;
    const mutation = await pendingMutationRepository.create({
      agent: input.agent,
      action: input.action,
      effect: input.effect,
      preview: input.preview ?? `Cette action ${input.agent}.${input.action} modifie des donnees et attend une confirmation.`,
      payload: input.payload,
      proposalId,
      threadId: input.threadId,
      clientChannel: input.clientChannel,
      expiresAtMs: Date.now() + PENDING_MUTATION_TTL_MS,
      routeKey: input.routeKey,
    });
    return mutation as PendingMutation;
  };

  const planPendingMailOrTodoMutation = async (input: {
    agent: Extract<CapabilityAgent, 'mail' | 'todo'>;
    threadId: string;
    clientChannel?: string;
    text: string;
    routeKey?: string;
  }): Promise<string | null> => {
    const routeCapability = findCapabilityByRouteKey(input.routeKey ?? '');
    const planned = input.agent === 'mail'
      ? await planMailAgentAction(input.text, buildMailEnv(), app.log)
      : await planTodoAgentAction(input.text, buildTodoEnv(), app.log);
    if ('clarification' in planned) {
      if (routeCapability && requiresCapabilityConfirmation(routeCapability)) {
        const mutation = await createPendingMutationProposal({
          threadId: input.threadId,
          clientChannel: input.clientChannel,
          agent: input.agent,
          action: routeCapability.action,
          effect: routeCapability.effect,
          payload: { routeKey: input.routeKey, text: input.text },
          routeKey: input.routeKey ?? routeCapability.routeKey,
        });
        return buildMutationProposalText(mutation);
      }
      return planned.clarification;
    }
    const capability = routeCapability ?? findCapabilityByRouteKey(`${input.agent}.${planned.action}`);
    if (!capability || !requiresCapabilityConfirmation(capability)) return null;
    const preview = input.agent === 'mail'
      ? formatMailActionPreview(planned as MailAction)
      : formatTodoActionPreview(planned as TodoAction);
    const mutation = await createPendingMutationProposal({
      threadId: input.threadId,
      clientChannel: input.clientChannel,
      agent: input.agent,
      action: planned.action,
      effect: capability.effect,
      preview,
      payload: { routeKey: input.routeKey, text: input.text, plan: planned },
      routeKey: input.routeKey ?? capability.routeKey,
    });
    return buildMutationProposalText(mutation);
  };

  const isCalendarMutationRouteKey = (routeKey: string): routeKey is PendingCalendarRouteKey => (
    routeKey === 'calendar.create_event'
    || routeKey === 'calendar.delete_event'
    || routeKey === 'calendar.update_event'
    || routeKey === 'calendar.remove_from_event'
  );

  const routeKeyForCalendarMutation = (action: ExecutableCalendarAction): PendingCalendarRouteKey => {
    switch (action) {
      case 'delete_event': return 'calendar.delete_event';
      case 'update_event': return 'calendar.update_event';
      case 'remove_from_event': return 'calendar.remove_from_event';
      case 'create_event':
      default: return 'calendar.create_event';
    }
  };

  const effectForCalendarMutation = (action: ExecutableCalendarAction): CapabilityEffect => (
    action === 'delete_event' ? 'destructive' : 'write'
  );

  const createPendingCalendarMutation = async (input: {
    threadId: string;
    clientChannel?: string;
    plan: Extract<CalendarAction, { action: 'create_event' | 'delete_event' | 'update_event' | 'remove_from_event' }>;
    preview: string;
  }): Promise<PendingMutation> => {
    const proposalId = `cal${randomUUID().slice(0, 8)}`;
    return await pendingMutationRepository.create({
      agent: 'calendar',
      action: input.plan.action,
      effect: effectForCalendarMutation(input.plan.action),
      preview: input.preview,
      payload: { plan: input.plan },
      routeKey: routeKeyForCalendarMutation(input.plan.action),
      proposalId,
      threadId: input.threadId,
      clientChannel: input.clientChannel,
      expiresAtMs: Date.now() + PENDING_MUTATION_TTL_MS,
    }) as PendingMutation;
  };

  const parseCalendarCandidateSelection = (value: string, candidates: Array<{ index: number; start: string }>): number | null => {
    const normalized = normalizeConfirmationText(value);
    if (/\b(premier|premiere|1|numero 1)\b/u.test(normalized)) return 1;
    if (/\b(deuxieme|second|seconde|2|numero 2)\b/u.test(normalized)) return 2;
    if (/\b(troisieme|3|numero 3)\b/u.test(normalized)) return 3;
    const hour = normalized.match(/\b(?:celui de |a |de )?(\d{1,2})h\b/u)?.[1];
    if (hour) {
      const wanted = Number(hour);
      const match = candidates.find((candidate) => {
        const d = new Date(candidate.start);
        return Number.isFinite(d.getTime()) && d.getHours() === wanted;
      });
      return match?.index ?? null;
    }
    return null;
  };

  const createCalendarMutationFromDisambiguation = async (mutation: PendingMutation, selectionText: string, selection?: { candidateIndex?: number; candidateEventId?: string }): Promise<string | null> => {
    if (mutation.agent !== 'calendar' || mutation.action !== 'disambiguate_event' || !mutation.payload.disambiguation) return null;
    const selectedIndex = selection?.candidateIndex ?? parseCalendarCandidateSelection(selectionText, mutation.payload.disambiguation.candidates);
    const candidate = mutation.payload.disambiguation.candidates.find((item) => (
      selection?.candidateEventId ? item.eventId === selection.candidateEventId : item.index === selectedIndex
    ));
    if (!candidate) return mutation.preview;
    await pendingMutationRepository.cancel(mutation.proposalId, 'disambiguation_selected');
    const plan = {
      ...mutation.payload.disambiguation.action,
      eventId: candidate.eventId,
      calendarId: candidate.calendarId,
    };
    const preview = `Je peux appliquer cette modification sur "${candidate.title}", ${candidate.start}.`;
    const finalMutation = await createPendingCalendarMutation({
      threadId: mutation.threadId,
      clientChannel: mutation.clientChannel,
      plan,
      preview,
    });
    return buildMutationProposalText(finalMutation);
  };

  const planPendingCalendarMutation = async (threadId: string, inputText: string, channel?: string): Promise<string> => {
    const plan = await planCalendarAgentAction(inputText, buildCalendarEnv());
    if (!isCalendarMutation(plan)) {
      return executeCalendarAgentAction(plan, buildCalendarEnv());
    }

    let preparedPlan = plan;
    let preview: string;
    if (plan.action === 'create_event') {
      preview = formatCalendarProposal(plan);
    } else {
      const prepared = await prepareCalendarMutationAction(plan, buildCalendarEnv());
      if (prepared.status === 'ambiguous' && prepared.action && prepared.candidates?.length) {
        const proposalId = `cal${randomUUID().slice(0, 8)}`;
        await pendingMutationRepository.create({
          agent: 'calendar',
          action: 'disambiguate_event',
          effect: effectForCalendarMutation(plan.action),
          preview: prepared.message,
          payload: { disambiguation: { action: prepared.action, candidates: prepared.candidates } },
          routeKey: routeKeyForCalendarMutation(plan.action),
          proposalId,
          threadId,
          clientChannel: channel,
          expiresAtMs: Date.now() + PENDING_MUTATION_TTL_MS,
        });
        return `${prepared.message} Tu peux dire "le premier", "le deuxieme", "celui de 18h", ou utiliser le bouton de selection.`;
      }
      if (prepared.status !== 'ready') return prepared.message;
      preparedPlan = prepared.action;
      preview = prepared.proposal;
    }

    const mutation = await createPendingCalendarMutation({ threadId, clientChannel: channel, plan: preparedPlan, preview });
    return buildMutationProposalText(mutation);
  };

  function recordPerf(key: string, elapsedMs: number): void {
    let arr = perfSamples.get(key);
    if (!arr) { arr = []; perfSamples.set(key, arr); }
    arr.push(elapsedMs);
    if (arr.length > PERF_MAX) arr.shift();
  }

  function computePercentiles(key: string): { count: number; avg: number; p50: number; p95: number } {
    const arr = perfSamples.get(key) ?? [];
    if (arr.length === 0) return { count: 0, avg: 0, p50: 0, p95: 0 };
    const sorted = [...arr].sort((a, b) => a - b);
    const avg = Math.round(sorted.reduce((s, v) => s + v, 0) / sorted.length);
    const p50 = sorted[Math.floor(sorted.length * 0.5)]!;
    const p95 = sorted[Math.floor(sorted.length * 0.95)]!;
    return { count: sorted.length, avg, p50, p95 };
  }

  const buildMailEnv = () => ({
    mailAccounts: buildMailAccounts(deps.env),
    OAUTH_REFRESH_TOKEN_STORE_PATH: deps.env.OAUTH_REFRESH_TOKEN_STORE_PATH,
    OPENAI_API_KEY: deps.env.OPENAI_API_KEY,
    OPENAI_BASE_URL: deps.env.OPENAI_BASE_URL,
    OPENAI_TIMEOUT_MS: deps.env.OPENAI_TIMEOUT_MS,
    OPENAI_MODEL_SUMMARY: deps.env.OPENAI_MODEL_SUMMARY,
  });

  const buildTodoEnv = () => ({
    MICROSOFT_CLIENT_ID:      deps.env.MICROSOFT_CLIENT_ID,
    MICROSOFT_CLIENT_SECRET:  deps.env.MICROSOFT_CLIENT_SECRET,
    MICROSOFT_REFRESH_TOKEN:  deps.env.MICROSOFT_REFRESH_TOKEN,
    MICROSOFT_TENANT_ID:      deps.env.MICROSOFT_TENANT_ID,
    OAUTH_REFRESH_TOKEN_STORE_PATH: deps.env.OAUTH_REFRESH_TOKEN_STORE_PATH,
    OPENAI_API_KEY:           deps.env.OPENAI_API_KEY,
    OPENAI_BASE_URL:          deps.env.OPENAI_BASE_URL,
    OPENAI_TIMEOUT_MS:        deps.env.OPENAI_TIMEOUT_MS,
    OPENAI_MODEL_SUMMARY:     deps.env.OPENAI_MODEL_SUMMARY,
  });

  const executePendingMutation = async (mutation: PendingMutation): Promise<string> => {
    if (mutation.agent === 'calendar') {
      if (!mutation.payload.plan) throw new Error('pending_calendar_missing_plan');
      return executeCalendarAgentAction(mutation.payload.plan, buildCalendarEnv());
    }
    if (mutation.agent === 'mail') {
      const plan = mutation.payload.plan as MailAction | undefined;
      if (!plan) throw new Error('pending_mail_missing_plan');
      return executeMailAgentAction(plan, buildMailEnv(), { userText: mutation.payload.text, log: app.log });
    }
    if (mutation.agent === 'todo') {
      const plan = mutation.payload.plan as TodoAction | undefined;
      if (!plan) throw new Error('pending_todo_missing_plan');
      return executeTodoAgentAction(plan, buildTodoEnv(), { userText: mutation.payload.text, log: app.log });
    }
    throw new Error('pending_mutation_unknown_agent');
  };

  const pendingMutationBodySchema = z.object({
    threadId: z.string().trim().min(1),
    clientChannel: z.string().trim().min(1).optional(),
    candidateIndex: z.coerce.number().int().min(1).max(20).optional(),
    candidateEventId: z.string().trim().min(1).optional(),
  }).strict();

  const pendingMutationDto = (mutation: PendingMutationRecord | PendingMutation) => ({
    proposalId: mutation.proposalId,
    threadId: mutation.threadId,
    clientChannel: mutation.clientChannel,
    agent: mutation.agent,
    action: mutation.action,
    effect: mutation.effect,
    routeKey: mutation.routeKey,
    preview: mutation.preview,
    status: 'status' in mutation ? mutation.status : 'pending',
    expiresAtMs: mutation.expiresAtMs,
    createdAtMs: 'createdAtMs' in mutation ? mutation.createdAtMs : Date.now(),
    executedAtMs: 'executedAtMs' in mutation ? mutation.executedAtMs : undefined,
    payload: mutation.payload,
  });

  const routeClientChannel = (req: { headers: Record<string, unknown> }, bodyChannel?: string): string | undefined => (
    normalizeClientChannel(bodyChannel) ?? normalizeClientChannel(req.headers['x-client-channel'])
  );

  app.get('/v1/pending-mutations', async (req, reply) => {
    const query = z.object({ threadId: z.string().trim().min(1) }).safeParse(req.query);
    if (!query.success) return reply.code(400).send({ error: 'invalid_query', issues: query.error.issues });
    await pendingMutationRepository.expirePending();
    const items = await pendingMutationRepository.listPendingByThread(query.data.threadId);
    return reply.code(200).send({ status: 'ok', items: items.map(pendingMutationDto) });
  });

  app.post('/v1/pending-mutations/:proposalId/confirm', async (req, reply) => {
    const params = z.object({ proposalId: z.string().trim().min(1) }).safeParse(req.params);
    const body = pendingMutationBodySchema.safeParse(req.body);
    if (!params.success) return reply.code(400).send({ error: 'invalid_params', issues: params.error.issues });
    if (!body.success) return reply.code(400).send({ error: 'invalid_body', issues: body.error.issues });
    await pendingMutationRepository.expirePending();
    const mutation = await pendingMutationRepository.findByProposalId(params.data.proposalId) as PendingMutation | null;
    const channel = routeClientChannel(req, body.data.clientChannel);
    if (!mutation) return reply.code(404).send({ error: 'pending_mutation_not_found' });
    if (mutation.threadId !== body.data.threadId || (mutation.clientChannel && mutation.clientChannel !== channel)) {
      return reply.code(409).send({ error: 'pending_mutation_context_mismatch' });
    }
    if (mutation.agent === 'calendar' && mutation.action === 'disambiguate_event') {
      const responseText = await createCalendarMutationFromDisambiguation(mutation, '', {
        candidateIndex: body.data.candidateIndex,
        candidateEventId: body.data.candidateEventId,
      });
      const next = await pendingMutationRepository.findActiveByThread(mutation.threadId);
      if (!responseText || !next || next.proposalId === mutation.proposalId) {
        return reply.code(400).send({ error: 'calendar_candidate_required', item: pendingMutationDto(mutation) });
      }
      return reply.code(200).send({ status: 'pending', responseText, item: pendingMutationDto(next) });
    }
    const started = await pendingMutationRepository.tryStartExecution(mutation.proposalId);
    if (started === 'executed') return reply.code(200).send({ status: 'executed', item: pendingMutationDto(mutation) });
    if (started === 'executing') return reply.code(409).send({ error: 'pending_mutation_executing' });
    if (started !== 'started') return reply.code(409).send({ error: 'pending_mutation_not_pending', status: started });
    try {
      const responseText = await executePendingMutation(mutation);
      await pendingMutationRepository.markExecuted(mutation.proposalId);
      const updated = await pendingMutationRepository.findByProposalId(mutation.proposalId);
      return reply.code(200).send({ status: 'executed', responseText, item: updated ? pendingMutationDto(updated) : pendingMutationDto(mutation) });
    } catch (err) {
      await pendingMutationRepository.markFailed(mutation.proposalId, 'execution_failed');
      app.log.warn({ proposalId: mutation.proposalId, agent: mutation.agent, action: mutation.action, err }, 'pending_mutation_rest_execute_failed');
      return reply.code(500).send({ error: 'pending_mutation_execute_failed' });
    }
  });

  app.post('/v1/pending-mutations/:proposalId/cancel', async (req, reply) => {
    const params = z.object({ proposalId: z.string().trim().min(1) }).safeParse(req.params);
    const body = pendingMutationBodySchema.safeParse(req.body);
    if (!params.success) return reply.code(400).send({ error: 'invalid_params', issues: params.error.issues });
    if (!body.success) return reply.code(400).send({ error: 'invalid_body', issues: body.error.issues });
    const mutation = await pendingMutationRepository.findByProposalId(params.data.proposalId);
    const channel = routeClientChannel(req, body.data.clientChannel);
    if (!mutation) return reply.code(404).send({ error: 'pending_mutation_not_found' });
    if (mutation.threadId !== body.data.threadId || (mutation.clientChannel && mutation.clientChannel !== channel)) {
      return reply.code(409).send({ error: 'pending_mutation_context_mismatch' });
    }
    const cancelled = await pendingMutationRepository.cancel(params.data.proposalId, 'api_cancel');
    return reply.code(200).send({ status: cancelled?.status ?? 'cancelled', item: cancelled ? pendingMutationDto(cancelled) : pendingMutationDto(mutation) });
  });

  app.post('/v1/ingest', async (req, reply) => {
    const parsed = ingestSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_body', issues: parsed.error.issues });
    }

    if (!deps.env.HA_BASE_URL || !deps.env.HA_TOKEN) {
      return reply.code(503).send({ error: 'ha_not_configured' });
    }

    const threadId = parsed.data.threadId.trim();
    const text = toSingleParagraphPlainText(parsed.data.text ?? '');
    const contextNote = toSingleParagraphPlainText(parsed.data.contextNote ?? '');
    const clientContextChannel = normalizeClientChannel(parsed.data.clientContext?.['channel']);
    const headerChannel = normalizeClientChannel(req.headers['x-client-channel']);
    const clientChannel = clientContextChannel ?? headerChannel;
    const isVoiceHubChannel = Boolean(clientChannel?.includes('voice-hub'));
    const assistantInputText = toSingleParagraphPlainText(enrichWithContextNote(text, contextNote));
    const requestId = randomUUID();
    const t0 = Date.now();
    const voiceTurnId = typeof req.headers['x-voice-turn-id'] === 'string' ? req.headers['x-voice-turn-id'].trim() : '';
    const voiceEnabled = isVoiceRequest({ voiceTurnId, clientChannel });
    const voiceMode = resolveVoiceResponseMode({
      text,
      clientContext: (parsed.data.clientContext as Record<string, unknown> | undefined),
    });
    const correlationId = typeof parsed.data.correlation_id === 'string' ? parsed.data.correlation_id.trim() : '';

    // Vérifier si une fenêtre de conversation active existe (10s post-réponse)
    // Si oui, réutiliser le threadId actif pour maintenir le contexte
    const shouldReuseActiveThread = Boolean(clientChannel && isVoiceHubChannel);
    const activeThread = shouldReuseActiveThread
      ? await threadRepository.getActiveConversationThread(clientChannel)
      : null;
    const effectiveThreadId = detectEffectiveThreadId(threadId, activeThread);
    if (activeThread) {
      app.log.info(
        {
          requestedThreadId: threadId,
          activeThreadId: activeThread.threadId,
          windowExpiresInMs: Math.max(0, activeThread.conversationWindowExpiresAtMs - Date.now()),
        },
        'ingest_reusing_active_thread'
      );
    }

    await threadRepository.getOrCreate(effectiveThreadId, { channel: clientChannel ?? null });

    await pendingMutationRepository.expirePending();
    const activePendingMutation = await pendingMutationRepository.findActiveByThread(effectiveThreadId) as PendingMutation | null;
    const pendingChannelMatches = !activePendingMutation?.clientChannel || activePendingMutation.clientChannel === clientChannel;
    const mentionsKnownProposal = Boolean(activePendingMutation && normalizeConfirmationText(text).includes(normalizeConfirmationText(activePendingMutation.proposalId)));
    const mentionsWrongProposal = /\b(?:cal|mail|todo)[a-f0-9]{8}\b/iu.test(normalizeConfirmationText(text)) && !mentionsKnownProposal;
    if (activePendingMutation && text && pendingChannelMatches && mentionsWrongProposal) {
      return reply.code(409).send({
        error: 'proposal_id_mismatch',
        message: 'La confirmation ne correspond pas a la proposition active.',
        proposalId: activePendingMutation.proposalId,
      });
    }

    if (activePendingMutation && text && pendingChannelMatches && activePendingMutation.agent === 'calendar' && activePendingMutation.action === 'disambiguate_event') {
      const disambiguationText = await createCalendarMutationFromDisambiguation(activePendingMutation, text);
      if (disambiguationText) {
        const responseText = voiceEnabled
          ? formatVoiceResponse({ text: disambiguationText, domain: 'calendar', mode: voiceMode })
          : disambiguationText;
        await conversationService.persistMessages(effectiveThreadId, text, responseText);
        await threadRepository.updateResponseTime(effectiveThreadId, Date.now());
        const finalProposal = await pendingMutationRepository.findActiveByThread(effectiveThreadId);
        const payload = {
          threadId: effectiveThreadId,
          responseText: toSingleParagraphPlainText(responseText),
          replyMeta: {
            kind: 'calendar',
            source: 'pending_mutation',
            routeKey: finalProposal?.routeKey ?? activePendingMutation.routeKey,
            semanticDecision: finalProposal?.proposalId === activePendingMutation.proposalId ? 'clarification_required' : 'confirmation_required',
            ...(finalProposal ? { proposalId: finalProposal.proposalId } : {}),
          },
        };
        return reply.code(200).send(payload);
      }
    }

    if (activePendingMutation && text && pendingChannelMatches && activePendingMutation.action !== 'disambiguate_event' && (isClearMutationConfirmation(text, activePendingMutation) || isClearCalendarRejection(text))) {
      const confirmed = isClearMutationConfirmation(text, activePendingMutation);
      let mutationText = 'Ok, je n execute pas cette action.';
      if (confirmed) {
        const started = await pendingMutationRepository.tryStartExecution(activePendingMutation.proposalId);
        if (started === 'started') {
          try {
            mutationText = await executePendingMutation(activePendingMutation);
            await pendingMutationRepository.markExecuted(activePendingMutation.proposalId);
          } catch (err) {
            mutationText = 'La mutation a echoue pendant l execution. Elle est conservee en etat failed.';
            await pendingMutationRepository.markFailed(activePendingMutation.proposalId, 'execution_failed');
            app.log.warn({ threadId: effectiveThreadId, requestId, agent: activePendingMutation.agent, action: activePendingMutation.action, err }, 'pending_mutation_execute_failed');
          }
        } else if (started === 'executed') {
          mutationText = 'Cette proposition a deja ete executee.';
        } else if (started === 'executing') {
          mutationText = 'Cette proposition est deja en cours d execution.';
        } else {
          mutationText = 'Cette proposition n est plus disponible.';
        }
      } else {
        await pendingMutationRepository.cancel(activePendingMutation.proposalId, 'voice_rejected');
      }
      const responseDomain = activePendingMutation.agent;
      const responseText = voiceEnabled
        ? formatVoiceResponse({ text: mutationText, domain: responseDomain, mode: voiceMode })
        : mutationText;
      await conversationService.persistMessages(effectiveThreadId, text, responseText);
      await threadRepository.updateResponseTime(effectiveThreadId, Date.now());
      const payload = {
        threadId: effectiveThreadId,
        responseText: toSingleParagraphPlainText(responseText),
        replyMeta: {
          kind: activePendingMutation.agent,
          source: 'pending_mutation',
          routeKey: activePendingMutation.routeKey,
          semanticDecision: confirmed ? 'confirmed' : 'cancelled',
          proposalId: activePendingMutation.proposalId,
        },
      };
      const validated = responseSchema.safeParse(payload);
      if (!validated.success) {
        return reply.code(500).send({ error: 'response_validation_failed' });
      }
      app.log.info(
        { threadId: effectiveThreadId, requestId, confirmed, elapsed_ms: Date.now() - t0 },
        'pending_mutation_confirmation_resolved',
      );
      return reply.code(200).send(validated.data);
    }
    if (activePendingMutation && text && pendingChannelMatches && isLikelyMutationConfirmationAttempt(text)) {
      const clarification = activePendingMutation.action === 'disambiguate_event'
        ? 'Je dois d abord savoir quel evenement choisir. Dis par exemple "le premier" ou "celui de 18h".'
        : 'Je n ai pas bien compris la confirmation. Dis simplement "je confirme", ou utilise le bouton de confirmation.';
      await conversationService.persistMessages(effectiveThreadId, text, clarification);
      await threadRepository.updateResponseTime(effectiveThreadId, Date.now());
      return reply.code(200).send({
        threadId: effectiveThreadId,
        responseText: clarification,
        replyMeta: {
          kind: activePendingMutation.agent,
          source: 'pending_mutation',
          routeKey: activePendingMutation.routeKey,
          semanticDecision: 'clarification_required',
          proposalId: activePendingMutation.proposalId,
        },
      });
    }
    if (activePendingMutation && text && pendingChannelMatches) {
      await pendingMutationRepository.cancelActiveByThread(effectiveThreadId, 'new_intent');
      app.log.info(
        { threadId: effectiveThreadId, requestId, proposalId: activePendingMutation.proposalId, agent: activePendingMutation.agent },
        'pending_mutation_cancelled_by_new_intent',
      );
    }

    // Guard against truncated voice captures (e.g. "Démar...") that can trigger
    // wrong routing/action. Ask for a clean reformulation instead.
    if (isVoiceHubChannel && isLikelyTruncatedVoiceUtterance(text)) {
      const clarification = 'Je n\'ai pas bien entendu la commande. Peux-tu reformuler en une phrase complète ?';
      await conversationService.persistMessages(effectiveThreadId, text, clarification);
      await threadRepository.updateResponseTime(effectiveThreadId, Date.now());
      app.log.info(
        { threadId: effectiveThreadId, requestId, text_len: text.length, client_channel: clientChannel },
        'ingest_voice_hub_truncated_guard',
      );
      return reply.code(200).send({ threadId: effectiveThreadId, responseText: clarification });
    }

    if (voiceEnabled && isLastMailSummaryRequest(text)) {
      const mailState = voiceThreadState.get(effectiveThreadId);
      const hasStructuredMailState = Array.isArray(mailState?.lastMailTop) && mailState!.lastMailTop!.length > 0;
      const followup = hasStructuredMailState ? buildLastMailSummaryFromState(mailState) : null;
      if (followup) {
        await conversationService.persistMessages(effectiveThreadId, text, followup);
        await threadRepository.updateResponseTime(effectiveThreadId, Date.now());
        const followupPayload = {
          threadId: effectiveThreadId,
          responseText: toSingleParagraphPlainText(followup),
        };
        const followupValidated = responseSchema.safeParse(followupPayload);
        if (!followupValidated.success) {
          return reply.code(500).send({ error: 'response_validation_failed' });
        }
        app.log.info(
          { threadId: effectiveThreadId, requestId, elapsed_ms: Date.now() - t0, voice_turn_id: voiceTurnId || undefined },
          'ingest_complete',
        );
        return reply.code(200).send(followupPayload);
      }

      app.log.info(
        {
          threadId: effectiveThreadId,
          requestId,
          has_state: Boolean(mailState),
          has_top: Boolean(mailState?.lastMailTop && mailState.lastMailTop.length > 0),
        },
        'mail_followup_requires_refresh',
      );

      try {
        const refreshedMailText = await callMailAgent(
          'Détaille mes emails non lus: donne le top 5 avec expéditeur et objet, de façon concise.',
          {
            mailAccounts: buildMailAccounts(deps.env),
            OAUTH_REFRESH_TOKEN_STORE_PATH: deps.env.OAUTH_REFRESH_TOKEN_STORE_PATH,
            OPENAI_API_KEY: deps.env.OPENAI_API_KEY,
            OPENAI_BASE_URL: deps.env.OPENAI_BASE_URL,
            OPENAI_TIMEOUT_MS: deps.env.OPENAI_TIMEOUT_MS,
            OPENAI_MODEL_SUMMARY: deps.env.OPENAI_MODEL_SUMMARY,
          },
          app.log,
        );

        const parsedMail = extractMailStateFromReply(refreshedMailText);
        if (parsedMail) {
          const existing = voiceThreadState.get(effectiveThreadId) ?? {};
          voiceThreadState.set(effectiveThreadId, { ...existing, ...parsedMail });
        }

        const refreshedVoice = formatVoiceResponse({
          text: refreshedMailText,
          domain: 'mail',
          mode: voiceMode,
        });

        await conversationService.persistMessages(effectiveThreadId, text, refreshedVoice);
        await threadRepository.updateResponseTime(effectiveThreadId, Date.now());

        const followupPayload = {
          threadId: effectiveThreadId,
          responseText: toSingleParagraphPlainText(refreshedVoice),
        };
        const followupValidated = responseSchema.safeParse(followupPayload);
        if (!followupValidated.success) {
          return reply.code(500).send({ error: 'response_validation_failed' });
        }
        app.log.info(
          { threadId: effectiveThreadId, requestId, elapsed_ms: Date.now() - t0, voice_turn_id: voiceTurnId || undefined },
          'ingest_complete',
        );
        return reply.code(200).send(followupPayload);
      } catch (err) {
        app.log.warn({ threadId: effectiveThreadId, requestId, err }, 'mail_followup_refresh_failed');
      }
    }

    const toDeterministicHaFailureMessage = (): string => (
      'Je n’ai pas pu joindre l’agent Home Assistant pour cette requête. Réessaie dans quelques secondes ou formule une commande musique explicite (ex: « mets de la musique sur Spotify »).'
    );

    if (parsed.data.domain === 'spotify' && parsed.data.action) {
      const explicitSpotifyPayload = ingestSpotifyRequestSchema.safeParse({
        ...parsed.data,
        threadId: effectiveThreadId,
        text: text || undefined,
        correlation_id: correlationId || undefined,
        user_id: typeof parsed.data.user_id === 'string' ? parsed.data.user_id.trim() || undefined : undefined,
      });
      if (!explicitSpotifyPayload.success) {
        return reply.code(400).send({ error: 'invalid_spotify_contract', issues: explicitSpotifyPayload.error.issues });
      }

      const spotifyResp = await executeSpotifyCapability({
        request: explicitSpotifyPayload.data,
        spotifyWebApi: deps.spotifyWebApi,
        env: deps.env,
        log: app.log,
      });
      const spotifyVoiceText = voiceEnabled
        ? formatVoiceResponse({
            text: spotifyResp.tts,
            domain: 'spotify',
            mode: voiceMode,
          })
        : spotifyResp.tts;
      const persistedUserText = text || `spotify.${explicitSpotifyPayload.data.action}`;
      void conversationService.persistMessages(effectiveThreadId, persistedUserText, spotifyVoiceText).then(async () => {
        if (await summarizationService.shouldPresummarize(effectiveThreadId)) {
          summarizationService.startPresummarize(effectiveThreadId);
        }
      });
      await threadRepository.updateResponseTime(effectiveThreadId, Date.now());
      app.log.info(
        {
          threadId: effectiveThreadId,
          requestId,
          action: explicitSpotifyPayload.data.action,
          status: spotifyResp.status,
          correlation_id: correlationId || undefined,
        },
        'ingest_spotify_explicit_contract_done',
      );

      return reply.code(200).send(buildSpotifyIngestPayload({
        threadId: effectiveThreadId,
        responseText: spotifyVoiceText,
        spotify: {
          status: spotifyResp.status,
          ...(spotifyResp.data ? { data: spotifyResp.data } : {}),
          ...(spotifyResp.options ? { options: spotifyResp.options } : {}),
          ...(spotifyResp.error_code ? { error_code: spotifyResp.error_code } : {}),
        },
        action: explicitSpotifyPayload.data.action,
        routingPath: 'explicit_contract',
        correlationId: correlationId || undefined,
      }));
    }

    if (!text) {
      return reply.code(400).send({ error: 'invalid_body', message: 'text is required' });
    }

    app.log.info(
      {
        threadId,
        requestId,
        text_len: text.length,
        client_channel: clientChannel,
        voice_turn_id: voiceTurnId || undefined,
        correlation_id: correlationId || undefined,
        routing_mode: 'router_only',
        routing_config_version: ROUTING_CONFIG_VERSION,
        routing_config_hash: ROUTING_CONFIG_HASH,
        semantic_router_config_hash: SEMANTIC_ROUTER_CONFIG_HASH,
      },
      'ingest_start',
    );

    // SSE — open the event stream immediately so the client receives ack before agent results arrive
    const rawAccept = req.headers['accept'];
    const acceptHeader = typeof rawAccept === 'string' ? rawAccept : Array.isArray(rawAccept) ? (rawAccept as string[]).join(',') : '';
    // Tauri's fetch shim replaces Accept with "*/*" — use ?sse=1 query param as fallback
    const querySSE = (req.query as Record<string, string>)['sse'] === '1';
    const wantsSSE = acceptHeader.includes('text/event-stream') || querySSE;
    app.log.info({ threadId, requestId, wantsSSE, accept: acceptHeader.slice(0, 80) }, 'ingest_sse_check');
    let sseStream: Readable | null = null;
    if (wantsSSE) {
      sseStream = new Readable({ read() {} });
      void reply
        .header('Content-Type', 'text/event-stream; charset=utf-8')
        .header('Cache-Control', 'no-cache')
        .header('X-Accel-Buffering', 'no')
        .send(sseStream);
    }
    let sseAckSent = false;
    let sseSettled = false;
    const pushSseAck = (text: string): void => {
      if (sseAckSent || sseSettled || sseStream === null) return;
      sseAckSent = true;
      sseStream.push(`event: ack\ndata: ${JSON.stringify({ text })}\n\n`);
    };
    const fallbackAckTimer = sseStream === null
      ? undefined
      : setTimeout(() => pushSseAck(getContextualFallbackAck(assistantInputText)), 650);
    fallbackAckTimer?.unref();
    const pushSseResponse = (data: unknown): void => {
      sseSettled = true;
      if (fallbackAckTimer) clearTimeout(fallbackAckTimer);
      sseStream?.push(`event: response\ndata: ${JSON.stringify(data)}\n\n`);
      sseStream?.push(null);
    };

    if (deps.nasStatus?.isConfigured() && isNasStatusQuery(assistantInputText)) {
      pushSseAck(getContextualFallbackAck(assistantInputText));
      try {
        const nasStatus = await deps.nasStatus.getStatus();
        const responseText = voiceEnabled
          ? formatVoiceResponse({ text: formatNasStatus(nasStatus), domain: 'general', mode: voiceMode })
          : formatNasStatus(nasStatus);
        await conversationService.persistMessages(effectiveThreadId, text, responseText);
        await threadRepository.updateResponseTime(effectiveThreadId, Date.now());
        const payload = {
          threadId: effectiveThreadId,
          responseText: toSingleParagraphPlainText(responseText),
          replyMeta: {
            kind: 'nas_status',
            source: 'nas_status_cache',
          },
        };
        if (sseStream !== null) { pushSseResponse(payload); return reply; }
        return reply.code(200).send(payload);
      } catch (err) {
        app.log.warn({ threadId: effectiveThreadId, requestId, err }, 'nas_status_query_failed');
      }
    }

    if (isLikelyCalendarIntent(assistantInputText)) {
      const routeKey = inferCalendarRouteKey(assistantInputText);
      const ackMsg = getIngestAckText([routeKey]);
      if (ackMsg) pushSseAck(ackMsg);

      try {
        app.log.info({ threadId: effectiveThreadId, requestId, route: routeKey }, 'calendar_intent_fast_path');
        const calendarText = isCalendarMutationRouteKey(routeKey)
          ? await planPendingCalendarMutation(effectiveThreadId, assistantInputText, clientChannel ?? undefined)
          : await callCalendarAgent(assistantInputText, buildCalendarEnv(), app.log);
        const activeCalendarProposal = await pendingMutationRepository.findActiveByThread(effectiveThreadId) as PendingMutation | null;
        const hasActiveCalendarProposal = activeCalendarProposal?.agent === 'calendar' && activeCalendarProposal.routeKey === routeKey && activeCalendarProposal.action !== 'disambiguate_event';
        const responseText = voiceEnabled
          ? formatVoiceResponse({ text: calendarText, domain: 'calendar', mode: voiceMode })
          : calendarText;
        await conversationService.persistMessages(effectiveThreadId, text, responseText);
        await threadRepository.updateResponseTime(effectiveThreadId, Date.now());
        const payload = {
          threadId: effectiveThreadId,
          responseText: toSingleParagraphPlainText(responseText),
          replyMeta: {
            kind: 'calendar',
            source: 'calendar_agent',
            routeKey,
            ...(isCalendarMutationRouteKey(routeKey) ? { semanticDecision: hasActiveCalendarProposal ? 'confirmation_required' : 'clarification_required' } : {}),
            ...(activeCalendarProposal?.agent === 'calendar' ? { proposalId: activeCalendarProposal.proposalId } : {}),
          },
        };
        if (sseStream !== null) { pushSseResponse(payload); return reply; }
        return reply.code(200).send(payload);
      } catch (err) {
        app.log.warn({ threadId: effectiveThreadId, requestId, route: routeKey, err }, 'calendar_intent_fast_path_failed');
        const fallbackText = 'Je n arrive pas a acceder a ton agenda pour le moment.';
        const responseText = voiceEnabled
          ? formatVoiceResponse({ text: fallbackText, domain: 'calendar', mode: voiceMode })
          : fallbackText;
        await conversationService.persistMessages(effectiveThreadId, text, responseText);
        await threadRepository.updateResponseTime(effectiveThreadId, Date.now());
        const payload = {
          threadId: effectiveThreadId,
          responseText: toSingleParagraphPlainText(responseText),
          replyMeta: {
            kind: 'calendar',
            source: 'calendar_agent',
            routeKey,
            fallbackReason: 'calendar_unavailable',
          },
        };
        if (sseStream !== null) { pushSseResponse(payload); return reply; }
        return reply.code(200).send(payload);
      }
    }

    // ── Parallel initialization (performance optimization) ────────────────────
    // These 3 operations have no dependencies and can run concurrently
    // Estimated gain: 150-250ms per request
    const [committed, threadBefore, recentMessages_] = await Promise.all([
      summarizationService.commitCandidateIfReady(effectiveThreadId),
      threadRepository.getOrCreate(effectiveThreadId),
      // Pre-compute recentMessages for router use later (unless router is disabled)
      messageRepository.getRecentMessages(effectiveThreadId, 3),
    ]);

    const usedSummaryVersion =
      committed.usedSummaryVersion ?? (threadBefore.summaryVersion > 0 ? `v${threadBefore.summaryVersion}` : undefined);

    // ── Orchestrator layer ────────────────────────────────────────────────────
    // Router runs first (sequential). Targets can include spotify, search agents,
    // or HA specialized agents (executors/mail/todo). HA general is called ONLY
    // when no specialized result is produced (router failure, no valid targets,
    // or all specialized tasks returned null).
    //
    // Outcomes:
    //   - single spotify target   → music planner + executor, early return
    //   - spotify + HA targets    → run both, combine text parts
    //   - HA specialized only     → call those, combine
    //   - router fails / none     → HA general called as fallback

    const agentEntries = parseAgentMap(deps.env.HA_AGENT_MAP);
    const spotifyEntry = deps.spotifyWebApi.isConfigured()
      ? { agentId: SPOTIFY_AGENT_ID, hint: 'Musique streaming Spotify: jouer, pause, suivant, précédent, volume, recherche musicale', key: 'spotify' as const }
      : null;
    const weatherEntry = deps.ha
      ? { agentId: 'weather', hint: 'Meteo locale Home Assistant: etat actuel, temperature, humidite, precipitation, previsions courtes', key: 'weather' }
      : null;
    const generalAgentId = deps.env.HA_AGENT_GENERAL;
    const executorsEntry = resolveExecutorsEntry(agentEntries, generalAgentId);
    const allAgentEntries = [...(spotifyEntry ? [spotifyEntry] : []), ...(weatherEntry ? [weatherEntry] : []), ...agentEntries];
    const routerEnabled = allAgentEntries.length > 0 && Boolean(deps.env.OPENAI_API_KEY);
    const threshold = deps.env.ROUTER_CONFIDENCE_THRESHOLD;

    const recentMessages = routerEnabled ? recentMessages_ : [];
    let assistantText: string | undefined;
    let responseDomain: VoiceResponseDomain = 'general';
    let searchSources: string[] = [];
    let gracefulFallback = false;

    if (!routerEnabled) {
      app.log.info({ threadId, requestId, reason: allAgentEntries.length === 0 ? 'no_agents' : 'no_openai_key' }, 'ha_agent_router_disabled');
    }

    const semanticLiveModeEnabled =
      deps.env.SEMANTIC_ROUTER_ENABLED
      && !deps.env.SEMANTIC_ROUTER_SHADOW_MODE;
    const semanticE2ActivationEnabled =
      semanticLiveModeEnabled
      && deps.env.SEMANTIC_ROUTER_ACTIVATION_ENABLED;
    const semanticActivatedRouteKeys = new Set(
      uniqueNonEmpty((deps.env.SEMANTIC_ROUTER_ACTIVATED_E2_ROUTES ?? '').split(',')),
    );
    const semanticE1ActivationEnabled =
      semanticLiveModeEnabled
      && deps.env.SEMANTIC_ROUTER_E1_ACTIVATION_ENABLED === true;
    const semanticActivatedE1RouteKeys = new Set(
      uniqueNonEmpty((deps.env.SEMANTIC_ROUTER_ACTIVATED_E1_ROUTES ?? '').split(',')),
    );
    const semanticE1HighRiskActivationEnabled =
      semanticLiveModeEnabled
      && deps.env.SEMANTIC_ROUTER_E1_HIGH_RISK_ACTIVATION_ENABLED === true;
    const semanticActivatedE1HighRiskRouteKeys = new Set(
      uniqueNonEmpty((deps.env.SEMANTIC_ROUTER_ACTIVATED_E1_HIGH_RISK_ROUTES ?? '').split(',')),
    );

    const toSemanticActivationTarget = (candidate: {
      key: string;
      targetAgentId?: string;
      directRequest?: { action: string; slots?: Record<string, unknown> };
    }): RouterTarget | null => {
      if (!semanticActivatedRouteKeys.has(candidate.key)) return null;
      if (candidate.targetAgentId === SPOTIFY_AGENT_ID) {
        if (!spotifyEntry || !candidate.directRequest?.action) return null;
        return {
          agentId: SPOTIFY_AGENT_ID,
          confidence: 1,
          action: candidate.directRequest.action,
          slots: candidate.directRequest.slots ?? {},
        };
      }
      if (candidate.targetAgentId === 'weather') {
        if (!weatherEntry) return null;
        return { agentId: 'weather', confidence: 1 };
      }
      return null;
    };

    let semanticActivatedTarget: RouterTarget | null = null;
    let semanticActivatedRouteKey: string | undefined;
    type MusicAgentPlan = Awaited<ReturnType<typeof planSpotifyActionFromTextWithOpenAi>>;
    let semanticE1SpotifyPlan: MusicAgentPlan | undefined;

    if (deps.env.SEMANTIC_ROUTER_ENABLED) {
      const multiIntent = analyzeMultiIntentLikelihood(text);
      const multiIntentLikelihood = multiIntent.score;
      const multiIntentThreshold = deps.env.SEMANTIC_ROUTER_MULTI_INTENT_THRESHOLD;
      const runtimeMultiIntentGuard = multiIntentLikelihood > multiIntentThreshold;
      const semanticInput: SemanticRouterInput = {
        userText: text,
        embeddingConfig: semanticEmbeddingCfg,
        options: {
          acceptScore: deps.env.SEMANTIC_ROUTER_ACCEPT_SCORE,
          minMargin: deps.env.SEMANTIC_ROUTER_MIN_MARGIN,
          multiIntentThreshold,
          enableE2: true,
          enableE1: true,
          enableD0: true,
        },
        enabledLevels: ['D0', 'E2', 'E1'],
        multiIntentLikelihood,
        context: { threadId, requestId },
      };

      app.log.info(
        {
          threadId,
          requestId,
          text_len: text.length,
          multiIntentLikelihood,
          multiIntentThreshold,
          multi_intent_marker_count: multiIntent.markerCount,
          multi_intent_segment_count: multiIntent.segmentCount,
          multi_intent_verb_count: multiIntent.verbCount,
          multi_intent_marker_score: multiIntent.markerScore,
          multi_intent_segment_score: multiIntent.segmentScore,
          multi_intent_extra_verb_score: multiIntent.extraVerbScore,
          routing_config_version: ROUTING_CONFIG_VERSION,
          routing_config_hash: ROUTING_CONFIG_HASH,
          semantic_router_config_hash: SEMANTIC_ROUTER_CONFIG_HASH,
        },
        'semantic_router_start',
      );
      if (runtimeMultiIntentGuard) {
        app.log.info(
          {
            threadId,
            requestId,
            multiIntentLikelihood,
            multiIntentThreshold,
            multi_intent_marker_count: multiIntent.markerCount,
            multi_intent_segment_count: multiIntent.segmentCount,
            multi_intent_verb_count: multiIntent.verbCount,
          },
          'semantic_router_skip_multi_intent_runtime',
        );
      }
      if (!runtimeMultiIntentGuard && semanticLiveModeEnabled) {
        try {
          const semResult = await trySemanticRouter(semanticInput);
          app.log.info(
            {
              threadId,
              requestId,
              semanticTop1: semResult.top1Intent,
              semanticScore: semResult.top1Score,
              semanticTop2: semResult.top2Intent,
              margin: semResult.margin,
              decision: semResult.decision,
              accepted: semResult.accepted,
              elapsedMs: semResult.elapsedMs,
              cachedEmbedding: semResult.debug?.cachedEmbedding,
              shadow: false,
              activationEnabled: semanticE2ActivationEnabled,
              e1ActivationEnabled: semanticE1ActivationEnabled,
            },
            semResult.accepted ? 'semantic_router_result' : 'semantic_router_fallback_llm',
          );

          if (semResult.accepted && semResult.decision === 'accepted_e2' && semResult.matchedRoute) {
            const routeKey = semResult.matchedRoute.key;
            if (!semanticE2ActivationEnabled) {
              app.log.info({ threadId, requestId, routeKey }, 'semantic_router_activation_fallback_not_allowlisted');
            } else if (!semanticActivatedRouteKeys.has(routeKey)) {
              app.log.info({ threadId, requestId, routeKey }, 'semantic_router_activation_fallback_not_allowlisted');
            } else {
              if (semResult.matchedRoute.targetAgentId === 'search') {
                const tSearch = Date.now();
                app.log.info(
                  {
                    threadId,
                    requestId,
                    route: routeKey,
                    domain: semResult.matchedRoute.directRequest?.domain,
                    decision: semResult.decision,
                    handled: false,
                  },
                  'semantic_router_search_e2_live_attempt',
                );
                if (sseStream !== null) {
                  const ackMsg = getIngestAckText([routeKey]);
                  if (ackMsg) pushSseAck(ackMsg);
                }
                try {
                  const handledSearchResult = await dispatchAcceptedSearchE2Route({
                    route: semResult.matchedRoute,
                    text: assistantInputText,
                    callSearchAgent,
                    searchCallParams: {
                      openAiApiKey: deps.env.OPENAI_API_KEY ?? '',
                      openAiBaseUrl: deps.env.OPENAI_BASE_URL,
                      perplexityApiKey: deps.env.PERPLEXITY_API_KEY,
                      perplexityBaseUrl: deps.env.PERPLEXITY_BASE_URL,
                      timeoutMs: deps.env.OPENAI_TIMEOUT_MS,
                      log: app.log,
                    },
                  });
                  if (handledSearchResult) {
                    assistantText = handledSearchResult.responseText;
                    searchSources = handledSearchResult.sources ?? [];
                    responseDomain = 'search';
                    app.log.info(
                      {
                        threadId,
                        requestId,
                        route: handledSearchResult.routeKey,
                        domain: handledSearchResult.domain,
                        decision: semResult.decision,
                        handled: true,
                        elapsed_ms: Date.now() - tSearch,
                      },
                      'semantic_router_search_e2_live_handled',
                    );
                  } else {
                    app.log.info(
                      {
                        threadId,
                        requestId,
                        route: routeKey,
                        domain: semResult.matchedRoute.directRequest?.domain,
                        decision: semResult.decision,
                        handled: false,
                        elapsed_ms: Date.now() - tSearch,
                      },
                      'semantic_router_search_e2_live_fallback_llm',
                    );
                  }
                } catch (err) {
                  app.log.warn(
                    {
                      threadId,
                      requestId,
                      route: routeKey,
                      domain: semResult.matchedRoute.directRequest?.domain,
                      decision: semResult.decision,
                      elapsed_ms: Date.now() - tSearch,
                      err,
                    },
                    'semantic_router_search_e2_live_error',
                  );
                }
              }

              if (assistantText !== undefined) {
                semanticActivatedRouteKey = routeKey;
              } else {
              const candidate = toSemanticActivationTarget({
                key: routeKey,
                targetAgentId: semResult.matchedRoute.targetAgentId,
                directRequest: semResult.matchedRoute.directRequest
                  ? {
                    action: semResult.matchedRoute.directRequest.action,
                    slots: semResult.matchedRoute.directRequest.slots,
                  }
                  : undefined,
              });
              if (candidate) {
                semanticActivatedTarget = candidate;
                semanticActivatedRouteKey = routeKey;
                app.log.info(
                  { threadId, requestId, routeKey, targetAgentId: candidate.agentId },
                  'semantic_router_activated_e2',
                );
              } else {
                app.log.info({ threadId, requestId, routeKey }, 'semantic_router_activation_fallback_unsupported_target');
              }
            }
            }
          }
          if (semResult.accepted && semResult.decision === 'accepted_e1' && semResult.matchedRoute) {
            const routeKey = semResult.matchedRoute.key;
            const highRisk = semResult.matchedRoute.highRisk === true;
            app.log.info(
              {
                threadId,
                requestId,
                route: routeKey,
                routeLevel: 'E1',
                score: semResult.top1Score,
                margin: semResult.margin,
                decision: semResult.decision,
                activated: false,
                fallback: false,
                highRisk,
                elapsedMs: semResult.elapsedMs,
                targetAgentId: semResult.matchedRoute.targetAgentId,
                plannerRequired: semResult.matchedRoute.plannerRequired === true,
              },
              'semantic_router_e1_candidate',
            );

            if (!semanticE1ActivationEnabled) {
              app.log.info(
                {
                  threadId,
                  requestId,
                  route: routeKey,
                  routeLevel: 'E1',
                  score: semResult.top1Score,
                  margin: semResult.margin,
                  decision: semResult.decision,
                  activated: false,
                  fallback: true,
                  highRisk,
                  elapsedMs: semResult.elapsedMs,
                },
                'semantic_router_e1_activation_fallback_not_allowlisted',
              );
            } else if (!semanticActivatedE1RouteKeys.has(routeKey)) {
              app.log.info(
                {
                  threadId,
                  requestId,
                  route: routeKey,
                  routeLevel: 'E1',
                  score: semResult.top1Score,
                  margin: semResult.margin,
                  decision: semResult.decision,
                  activated: false,
                  fallback: true,
                  highRisk,
                  elapsedMs: semResult.elapsedMs,
                },
                'semantic_router_e1_activation_fallback_not_allowlisted',
              );
            } else {
              const targetAgentId = semResult.matchedRoute.targetAgentId;
              const expectedTargetAgentId = routeKey.startsWith('search.deep.')
                ? 'search'
                : routeKey.startsWith('spotify.')
                  ? SPOTIFY_AGENT_ID
                  : routeKey.startsWith('todo.')
                    ? 'todo'
                    : routeKey.startsWith('mail.')
                      ? 'mail'
                      : routeKey.startsWith('calendar.')
                        ? 'calendar'
                      : routeKey.startsWith('executor.')
                        ? 'executors'
                      : null;
              const safeRouteAllowed = SEMANTIC_E1_LIVE_SUPPORTED_ROUTE_KEYS.has(routeKey);
              const supportedTarget = expectedTargetAgentId !== null && targetAgentId === expectedTargetAgentId;
              const isSlowReadRoute = routeKey.startsWith('search.deep.')
                || routeKey.startsWith('todo.')
                || routeKey.startsWith('mail.')
                || routeKey.startsWith('calendar.')
                || routeKey.startsWith('executor.');

              if (!safeRouteAllowed || !supportedTarget) {
                app.log.info(
                  {
                    threadId,
                    requestId,
                    route: routeKey,
                    routeLevel: 'E1',
                    score: semResult.top1Score,
                    margin: semResult.margin,
                    decision: semResult.decision,
                    activated: false,
                    fallback: true,
                    highRisk,
                    elapsedMs: semResult.elapsedMs,
                    targetAgentId,
                  },
                  'semantic_router_e1_activation_fallback_unsupported_target',
                );
              } else {
                let highRiskAllowed = true;
                if (highRisk) {
                  const highRiskGate = evaluateHighRiskE1Activation({
                    enabled: semanticE1HighRiskActivationEnabled,
                    activatedRoutes: semanticActivatedE1HighRiskRouteKeys,
                    routeKey,
                    top1Score: semResult.top1Score,
                    margin: semResult.margin,
                    acceptScore: deps.env.SEMANTIC_ROUTER_HIGH_RISK_ACCEPT_SCORE,
                    minMargin: deps.env.SEMANTIC_ROUTER_HIGH_RISK_MIN_MARGIN,
                  });
                  if (!highRiskGate.allowed) {
                    highRiskAllowed = false;
                    if (highRiskGate.decision === 'blocked_activation_disabled') {
                      app.log.info(
                        {
                          threadId,
                          requestId,
                          route: routeKey,
                          routeLevel: 'E1',
                          score: semResult.top1Score,
                          margin: semResult.margin,
                          decision: semResult.decision,
                          activated: false,
                          fallback: true,
                          highRisk: true,
                          elapsedMs: semResult.elapsedMs,
                        },
                        'semantic_router_e1_high_risk_blocked_activation_disabled',
                      );
                    } else if (highRiskGate.decision === 'blocked_not_allowlisted') {
                      app.log.info(
                        {
                          threadId,
                          requestId,
                          route: routeKey,
                          routeLevel: 'E1',
                          score: semResult.top1Score,
                          margin: semResult.margin,
                          decision: semResult.decision,
                          activated: false,
                          fallback: true,
                          highRisk: true,
                          elapsedMs: semResult.elapsedMs,
                        },
                        'semantic_router_e1_high_risk_blocked_not_allowlisted',
                      );
                    } else {
                      app.log.info(
                        {
                          threadId,
                          requestId,
                          route: routeKey,
                          routeLevel: 'E1',
                          score: semResult.top1Score,
                          margin: semResult.margin,
                          decision: semResult.decision,
                          activated: false,
                          fallback: true,
                          highRisk: true,
                          elapsedMs: semResult.elapsedMs,
                          thresholdScore: deps.env.SEMANTIC_ROUTER_HIGH_RISK_ACCEPT_SCORE,
                          thresholdMargin: deps.env.SEMANTIC_ROUTER_HIGH_RISK_MIN_MARGIN,
                        },
                        'semantic_router_e1_high_risk_blocked_thresholds',
                      );
                    }
                  }
                }

                if (highRiskAllowed) {
                if (routeKey.startsWith('executor.')) {
                  if (!executorsEntry) {
                    app.log.info(
                      {
                        threadId,
                        requestId,
                        route: routeKey,
                        routeLevel: 'E1',
                        score: semResult.top1Score,
                        margin: semResult.margin,
                        decision: semResult.decision,
                        activated: false,
                        fallback: true,
                        highRisk,
                        elapsedMs: semResult.elapsedMs,
                        targetAgentId,
                      },
                      'semantic_router_e1_activation_fallback_unsupported_target',
                    );
                  } else {
                    semanticActivatedTarget = { agentId: executorsEntry.agentId, confidence: 1 };
                    semanticActivatedRouteKey = routeKey;
                    app.log.info(
                      {
                        threadId,
                        requestId,
                        route: routeKey,
                        routeLevel: 'E1',
                        score: semResult.top1Score,
                        margin: semResult.margin,
                        decision: semResult.decision,
                        activated: true,
                        fallback: false,
                        highRisk,
                        elapsedMs: semResult.elapsedMs,
                        targetAgentId,
                        handled: true,
                        mode: 'ha_executor_specialized',
                      },
                      'semantic_router_e1_live_handled',
                    );
                  }
                } else {
                const tE1 = Date.now();
                app.log.info(
                  {
                    threadId,
                    requestId,
                    route: routeKey,
                    routeLevel: 'E1',
                    score: semResult.top1Score,
                    margin: semResult.margin,
                    decision: semResult.decision,
                    activated: true,
                    fallback: false,
                    highRisk,
                    elapsedMs: semResult.elapsedMs,
                    targetAgentId,
                    handled: false,
                  },
                  highRisk ? 'semantic_router_e1_high_risk_live_attempt' : 'semantic_router_e1_live_attempt',
                );

                if (isSlowReadRoute && sseStream !== null) {
                  const ackMsg = getIngestAckText([routeKey]);
                  if (ackMsg) pushSseAck(ackMsg);
                }

                try {
                  const routeCapability = findCapabilityByRouteKey(routeKey);
                  if (
                    routeCapability
                    && routeCapability.agent !== 'calendar'
                    && requiresCapabilityConfirmation(routeCapability)
                  ) {
                    app.log.info(
                      { threadId: effectiveThreadId, requestId, route: routeKey, agent: routeCapability.agent, action: routeCapability.action },
                      'semantic_router_e1_mutation_blocked_pending_required',
                    );
                  }
                  const blockedMutationText = routeCapability
                    && (routeCapability.agent === 'mail' || routeCapability.agent === 'todo')
                    && requiresCapabilityConfirmation(routeCapability)
                    ? await planPendingMailOrTodoMutation({
                      threadId: effectiveThreadId,
                      clientChannel: clientChannel ?? undefined,
                      agent: routeCapability.agent,
                      text: assistantInputText,
                      routeKey,
                    }) ?? ''
                    : '';
                  const e1Result = blockedMutationText
                    ? routeCapability?.agent === 'mail'
                      ? { kind: 'mail_text' as const, routeKey, data: blockedMutationText }
                      : { kind: 'todo_text' as const, routeKey, data: blockedMutationText }
                    : await dispatchAcceptedE1Route({
                    route: semResult.matchedRoute,
                    text: assistantInputText,
                    deps: {
                      planSpotifyAction: async (plannerText: string) => (
                        planSpotifyActionFromTextWithOpenAi({
                          env: deps.env,
                          spotifyWebApi: deps.spotifyWebApi,
                          text: plannerText,
                          correlationId: correlationId || undefined,
                          userId: typeof parsed.data.user_id === 'string'
                            ? parsed.data.user_id.trim() || undefined
                            : undefined,
                          log: app.log,
                        })
                      ),
                      callSearchAgent: async (agentKey, params) => (
                        callSearchAgent(agentKey, {
                          text: params.text,
                          openAiApiKey: deps.env.OPENAI_API_KEY ?? '',
                          openAiBaseUrl: deps.env.OPENAI_BASE_URL,
                          perplexityApiKey: deps.env.PERPLEXITY_API_KEY,
                          perplexityBaseUrl: deps.env.PERPLEXITY_BASE_URL,
                          timeoutMs: deps.env.OPENAI_TIMEOUT_MS,
                          log: app.log,
                        })
                      ),
                      callTodoAgent: async () => {
                        return callTodoAgent(assistantInputText, {
                          MICROSOFT_CLIENT_ID:      deps.env.MICROSOFT_CLIENT_ID,
                          MICROSOFT_CLIENT_SECRET:  deps.env.MICROSOFT_CLIENT_SECRET,
                          MICROSOFT_REFRESH_TOKEN:  deps.env.MICROSOFT_REFRESH_TOKEN,
                          MICROSOFT_TENANT_ID:      deps.env.MICROSOFT_TENANT_ID,
                          OAUTH_REFRESH_TOKEN_STORE_PATH: deps.env.OAUTH_REFRESH_TOKEN_STORE_PATH,
                          OPENAI_API_KEY:           deps.env.OPENAI_API_KEY,
                          OPENAI_BASE_URL:          deps.env.OPENAI_BASE_URL,
                          OPENAI_TIMEOUT_MS:        deps.env.OPENAI_TIMEOUT_MS,
                          OPENAI_MODEL_SUMMARY:     deps.env.OPENAI_MODEL_SUMMARY,
                        }, app.log);
                      },
                      callMailAgent: async () => {
                        return callMailAgent(assistantInputText, {
                          mailAccounts:    buildMailAccounts(deps.env),
                          OAUTH_REFRESH_TOKEN_STORE_PATH: deps.env.OAUTH_REFRESH_TOKEN_STORE_PATH,
                          OPENAI_API_KEY:  deps.env.OPENAI_API_KEY,
                          OPENAI_BASE_URL: deps.env.OPENAI_BASE_URL,
                          OPENAI_TIMEOUT_MS: deps.env.OPENAI_TIMEOUT_MS,
                          OPENAI_MODEL_SUMMARY: deps.env.OPENAI_MODEL_SUMMARY,
                        }, app.log);
                      },
                      callCalendarAgent: async () => {
                        if (isCalendarMutationRouteKey(routeKey)) {
                          return planPendingCalendarMutation(effectiveThreadId, assistantInputText, clientChannel ?? undefined);
                        }
                        return callCalendarAgent(assistantInputText, buildCalendarEnv(), app.log);
                      },
                    },
                  });

                  if (!e1Result) {
                    app.log.info(
                      {
                        threadId,
                        requestId,
                        route: routeKey,
                        routeLevel: 'E1',
                        score: semResult.top1Score,
                        margin: semResult.margin,
                        decision: semResult.decision,
                        activated: true,
                        fallback: true,
                        highRisk,
                        elapsedMs: semResult.elapsedMs,
                        targetAgentId,
                        handled: false,
                        elapsed_ms: Date.now() - tE1,
                      },
                      highRisk ? 'semantic_router_e1_high_risk_live_fallback_llm' : 'semantic_router_e1_live_fallback_llm',
                    );
                  } else if (
                    e1Result.kind === 'search_text'
                    || e1Result.kind === 'todo_text'
                    || e1Result.kind === 'mail_text'
                    || e1Result.kind === 'calendar_text'
                  ) {
                    assistantText = e1Result.data;
                    if (e1Result.kind === 'search_text') searchSources = e1Result.sources ?? [];
                    responseDomain = e1Result.kind === 'search_text'
                      ? 'search'
                      : e1Result.kind === 'todo_text'
                        ? 'todo'
                        : e1Result.kind === 'calendar_text'
                          ? 'calendar'
                          : 'mail';
                    semanticActivatedRouteKey = e1Result.routeKey;
                    app.log.info(
                      {
                        threadId,
                        requestId,
                        route: e1Result.routeKey,
                        routeLevel: 'E1',
                        score: semResult.top1Score,
                        margin: semResult.margin,
                        decision: semResult.decision,
                        activated: true,
                        fallback: false,
                        highRisk,
                        elapsedMs: semResult.elapsedMs,
                        targetAgentId,
                        handled: true,
                        elapsed_ms: Date.now() - tE1,
                      },
                      highRisk ? 'semantic_router_e1_high_risk_live_handled' : 'semantic_router_e1_live_handled',
                    );
                  } else if (e1Result.kind === 'spotify_plan') {
                    const maybePlan = e1Result.data as MusicAgentPlan;
                    if (maybePlan.route !== 'spotify' || !maybePlan.request) {
                      app.log.info(
                        {
                          threadId,
                          requestId,
                          route: e1Result.routeKey,
                          routeLevel: 'E1',
                          score: semResult.top1Score,
                          margin: semResult.margin,
                          decision: semResult.decision,
                          activated: true,
                          fallback: true,
                          highRisk,
                          elapsedMs: semResult.elapsedMs,
                          targetAgentId,
                          handled: false,
                          elapsed_ms: Date.now() - tE1,
                        },
                        highRisk ? 'semantic_router_e1_high_risk_live_fallback_llm' : 'semantic_router_e1_live_fallback_llm',
                      );
                    } else {
                      semanticE1SpotifyPlan = maybePlan;
                      semanticActivatedTarget = { agentId: SPOTIFY_AGENT_ID, confidence: 1 };
                      semanticActivatedRouteKey = e1Result.routeKey;
                      app.log.info(
                        {
                          threadId,
                          requestId,
                          route: e1Result.routeKey,
                          routeLevel: 'E1',
                          score: semResult.top1Score,
                          margin: semResult.margin,
                          decision: semResult.decision,
                          activated: true,
                          fallback: false,
                          highRisk,
                          elapsedMs: semResult.elapsedMs,
                          targetAgentId,
                          planner: 'spotify_music_agent',
                          handled: true,
                          elapsed_ms: Date.now() - tE1,
                        },
                        highRisk ? 'semantic_router_e1_high_risk_live_handled' : 'semantic_router_e1_live_handled',
                      );
                    }
                  } else {
                    app.log.info(
                      {
                        threadId,
                        requestId,
                        route: routeKey,
                        routeLevel: 'E1',
                        score: semResult.top1Score,
                        margin: semResult.margin,
                        decision: semResult.decision,
                        activated: true,
                        fallback: true,
                        highRisk,
                        elapsedMs: semResult.elapsedMs,
                        targetAgentId,
                        handled: false,
                        elapsed_ms: Date.now() - tE1,
                      },
                      highRisk ? 'semantic_router_e1_high_risk_live_fallback_llm' : 'semantic_router_e1_live_fallback_llm',
                    );
                  }
                } catch (err) {
                  app.log.warn(
                    {
                      threadId,
                      requestId,
                      route: routeKey,
                      routeLevel: 'E1',
                      score: semResult.top1Score,
                      margin: semResult.margin,
                      decision: semResult.decision,
                      activated: true,
                      fallback: true,
                      highRisk,
                      elapsedMs: semResult.elapsedMs,
                      targetAgentId,
                      elapsed_ms: Date.now() - tE1,
                      err,
                    },
                    highRisk ? 'semantic_router_e1_high_risk_live_error' : 'semantic_router_e1_live_error',
                  );
                }
                }
                }
              }
            }
          }
        } catch (err) {
          app.log.warn({ threadId, requestId, err }, 'semantic_router_error');
        }
      } else {
        // Phase 1A shadow mode (observation only)
        trySemanticRouter(semanticInput).then((semResult) => {
          app.log.info(
            {
              threadId,
              requestId,
              semanticTop1: semResult.top1Intent,
              semanticScore: semResult.top1Score,
              semanticTop2: semResult.top2Intent,
              margin: semResult.margin,
              decision: semResult.decision,
              accepted: semResult.accepted,
              elapsedMs: semResult.elapsedMs,
              cachedEmbedding: semResult.debug?.cachedEmbedding,
              shadow: deps.env.SEMANTIC_ROUTER_SHADOW_MODE,
              activationEnabled: false,
              runtimeMultiIntentGuard,
              routing_config_hash: ROUTING_CONFIG_HASH,
              semantic_router_config_hash: SEMANTIC_ROUTER_CONFIG_HASH,
            },
            semResult.accepted ? 'semantic_router_result' : 'semantic_router_fallback_llm',
          );
          if (semResult.accepted && semResult.decision === 'accepted_e1' && semResult.matchedRoute) {
            app.log.info(
              {
                threadId,
                requestId,
                route: semResult.matchedRoute.key,
                decision: semResult.decision,
                targetAgentId: semResult.matchedRoute.targetAgentId,
                plannerRequired: semResult.matchedRoute.plannerRequired === true,
              },
              'semantic_router_e1_candidate',
            );
          }
        }).catch((err) => {
          app.log.warn({ threadId, requestId, err }, 'semantic_router_error');
        });
      }
    }

    const routerPromise: Promise<RouterResult> = assistantText !== undefined
      ? Promise.resolve({
          targets: [],
          reason: `semantic_router_live:${semanticActivatedRouteKey ?? 'handled'}`,
        })
      : semanticActivatedTarget
      ? Promise.resolve({
          targets: [semanticActivatedTarget],
          reason: `semantic_router_activated:${semanticActivatedRouteKey ?? semanticActivatedTarget.agentId}`,
        })
      : routerEnabled
        ? routeUserRequest({
            text: assistantInputText,
            agents: allAgentEntries,
            summary: threadBefore.summary?.trim() || undefined,
            recentMessages,
            options: {
              openAiApiKey: deps.env.OPENAI_API_KEY!,
              openAiBaseUrl: deps.env.OPENAI_BASE_URL,
              model: deps.env.OPENAI_MODEL_ROUTER,
              timeoutMs: deps.env.ROUTER_TIMEOUT_MS,
              confidenceThreshold: threshold,
              generalAgentId,
              log: app.log,
            },
          })
        : Promise.reject(new Error('router_disabled'));

    // Early SSE ack: fire as soon as the router decides, without waiting for HA general.
    // This gives the user immediate feedback ("Je cherche...") before Perplexity/todo/mail respond.
    if (sseStream !== null && routerEnabled) {
      const _earlyAckEntryMap = new Map(allAgentEntries.map((e) => [e.agentId, e]));
      routerPromise.then((routerRes) => {
        const validTargets = routerRes.targets.filter((t) => t.confidence >= threshold);
        const specTargets = validTargets.filter((t) => t.agentId !== SPOTIFY_AGENT_ID && t.agentId !== generalAgentId);
        if (specTargets.length > 0) {
          const ackText = getIngestAckText(specTargets.map((t) => _earlyAckEntryMap.get(t.agentId)?.key));
          if (ackText) pushSseAck(ackText);
        }
      }).catch(() => { /* ack is best-effort — main flow handles the real result */ });
    }

    const routerResult = await routerPromise.then(
      (value) => ({ status: 'fulfilled' as const, value }),
      (reason: unknown) => ({ status: 'rejected' as const, reason }),
    );

    if (routerResult.status === 'rejected' && routerEnabled) {
      const multiIntent = analyzeMultiIntentLikelihood(text);
      app.log.info(
        {
          threadId,
          requestId,
          router_status: 'rejected',
          router_error: String(routerResult.reason),
          local_weather_candidate: isLikelyLocalWeatherQuery(text),
          multi_intent_likelihood: multiIntent.score,
          multi_intent_marker_count: multiIntent.markerCount,
          multi_intent_segment_count: multiIntent.segmentCount,
          multi_intent_verb_count: multiIntent.verbCount,
          routing_config_version: ROUTING_CONFIG_VERSION,
          routing_config_hash: ROUTING_CONFIG_HASH,
          semantic_router_config_hash: SEMANTIC_ROUTER_CONFIG_HASH,
        },
        'ingest_routing_trace',
      );
      app.log.warn({ threadId, requestId, err: routerResult.reason }, 'ha_agent_router_failed_fallback_general');
      gracefulFallback = true;
    }

    // ── Resolve targets ───────────────────────────────────────────────────────

    if (routerResult.status === 'fulfilled') {
      const validTargets = routerResult.value.targets.filter((t) => t.confidence >= threshold);
      const externalWeatherCandidate = isClearlyExternalWeather(assistantInputText) && !isLikelyLocalWeatherQuery(assistantInputText);

      app.log.info(
        {
          threadId,
          requestId,
          router_status: 'fulfilled',
          router_reason: routerResult.value.reason,
          router_targets_raw: routerResult.value.targets.map((t) => `${t.agentId}:${t.confidence}`).join(','),
          router_targets_final: validTargets.map((t) => `${t.agentId}:${t.confidence}`).join(','),
          routing_config_version: ROUTING_CONFIG_VERSION,
          routing_config_hash: ROUTING_CONFIG_HASH,
          semantic_router_config_hash: SEMANTIC_ROUTER_CONFIG_HASH,
        },
        'ingest_routing_trace',
      );

      const spotifyTarget = validTargets.find((t) => t.agentId === SPOTIFY_AGENT_ID);
      const haSpecTargets = validTargets.filter(
        (t) => t.agentId !== SPOTIFY_AGENT_ID && t.agentId !== generalAgentId,
      );

      app.log.info(
        {
          threadId,
          requestId,
          router_targets: validTargets.map((t) => `${t.agentId}:${t.confidence}`).join(','),
          router_reason: routerResult.value.reason,
        },
        'ha_agent_router_result',
      );

      if (validTargets.length > 0) {
        type SpecializedResult =
          | {
              kind: 'spotify_tts';
              tts: string;
              action: z.infer<typeof spotifyActionSchema>;
              musicPlanRoute: string;
              musicPlanReason?: string;
              spotifyPayload: SpotifyResponseShape;
            }
          | { kind: 'ha_text'; agentId: string; text: string; sources?: string[] };

        const tasks: Promise<SpecializedResult | null>[] = [];

        // Spotify task
        if (spotifyTarget) {
          // When the router already resolved the Spotify action directly, use it —
          // EXCEPT for search_and_play without a query slot: the router reliably picks
          // the action but often omits the query. Fall through to the music planner
          // in that case so it can extract the proper search terms from the text.
          const routerActionParsed = spotifyTarget.action ? spotifyActionSchema.safeParse(spotifyTarget.action) : null;
          const routerHasUsableSearchAndPlay =
            routerActionParsed?.success &&
            routerActionParsed.data === 'search_and_play' &&
            typeof (spotifyTarget.slots as Record<string, unknown> | undefined)?.['query'] === 'string' &&
            ((spotifyTarget.slots as Record<string, unknown>)['query'] as string).trim().length > 0;
          const routerDirectUsable =
            routerActionParsed?.success &&
            (routerActionParsed.data !== 'search_and_play' || routerHasUsableSearchAndPlay);
          const resolveSpotifyPayload = semanticE1SpotifyPlan
            ? Promise.resolve(semanticE1SpotifyPlan)
            : routerDirectUsable
              ? Promise.resolve({
                  route: 'spotify' as const,
                  reason: `router_direct:${routerActionParsed!.data}`,
                  request: {
                    domain: 'spotify' as const,
                    action: routerActionParsed!.data,
                    slots: spotifyTarget.slots ?? {},
                    text,
                  },
                })
              : planSpotifyActionFromTextWithOpenAi({
                  env: deps.env,
                  spotifyWebApi: deps.spotifyWebApi,
                  text: assistantInputText,
                  correlationId: correlationId || undefined,
                  userId: typeof parsed.data.user_id === 'string' ? parsed.data.user_id.trim() || undefined : undefined,
                  log: app.log,
                });

          tasks.push(
            resolveSpotifyPayload
              .then(async (musicPlan): Promise<SpecializedResult | null> => {
                if (musicPlan.route !== 'spotify' || !musicPlan.request) {
                  app.log.info({ threadId, requestId, reason: musicPlan.reason }, 'music_agent_route_none_despite_router');
                  return null;
                }
                const spotifyPayload = ingestSpotifyRequestSchema.safeParse({
                  threadId,
                  correlation_id: correlationId || undefined,
                  user_id: typeof parsed.data.user_id === 'string' ? parsed.data.user_id.trim() || undefined : undefined,
                  ...musicPlan.request,
                  text,
                });
                if (!spotifyPayload.success) {
                  app.log.warn({ threadId, requestId, issues: spotifyPayload.error.issues }, 'music_agent_invalid_payload');
                  return null;
                }
                const spotifyResp = await executeSpotifyCapability({
                  request: spotifyPayload.data,
                  spotifyWebApi: deps.spotifyWebApi,
                  env: deps.env,
                  log: app.log,
                });
                app.log.info(
                  { threadId, requestId, action: spotifyPayload.data.action, status: spotifyResp.status },
                  'ingest_spotify_capability_done',
                );
                return {
                  kind: 'spotify_tts',
                  tts: spotifyResp.tts,
                  action: spotifyPayload.data.action,
                  musicPlanRoute: musicPlan.route,
                  musicPlanReason: musicPlan.reason,
                  spotifyPayload: {
                    status: spotifyResp.status,
                    ...(spotifyResp.data ? { data: spotifyResp.data } : {}),
                    ...(spotifyResp.options ? { options: spotifyResp.options } : {}),
                    ...(spotifyResp.error_code ? { error_code: spotifyResp.error_code } : {}),
                  },
                };
              })
              .catch((err) => {
                app.log.warn({ threadId, requestId, err }, 'spotify_task_failed');
                return null;
              }),
          );
        }

        // HA specialized tasks
        const agentEntryByAgentId = new Map(agentEntries.map((e) => [e.agentId, e]));
        if (weatherEntry) {
          agentEntryByAgentId.set(weatherEntry.agentId, weatherEntry);
        }
        for (const haTarget of haSpecTargets) {
          const agentEntry = agentEntryByAgentId.get(haTarget.agentId);
          const isSearchAgent   = isSearchAgentKey(agentEntry?.key);
          const isTodoAgent     = isTodoAgentKey(agentEntry?.key);
          const isMailAgent     = isMailAgentKey(agentEntry?.key);
          const isCalendarAgent = isCalendarAgentKey(agentEntry?.key);
          const isWeatherAgent = agentEntry?.key === 'weather';
          if (isSearchAgent) {
            // Search agents: dispatch to appropriate Perplexity/OpenAI strategy — bypass HA entirely.
            const searchAgentKey = externalWeatherCandidate && agentEntry?.key === 'search.news'
              ? 'search.news.external_weather'
              : agentEntry!.key ?? 'search';
            app.log.info({ threadId, requestId, agent: haTarget.agentId, searchAgentKey }, 'search_agent_direct');
            tasks.push(
              callSearchAgent(searchAgentKey, {
                text: assistantInputText,
                openAiApiKey: deps.env.OPENAI_API_KEY!,
                openAiBaseUrl: deps.env.OPENAI_BASE_URL,
                perplexityApiKey: deps.env.PERPLEXITY_API_KEY,
                perplexityBaseUrl: deps.env.PERPLEXITY_BASE_URL,
                timeoutMs: deps.env.OPENAI_TIMEOUT_MS,
                log: app.log,
              })
                .then((result): SpecializedResult | null => {
                  app.log.info({ threadId, requestId, agent: haTarget.agentId }, 'search_agent_direct_done');
                  return { kind: 'ha_text', agentId: haTarget.agentId, text: result.text, sources: result.sources };
                })
                .catch((err) => {
                  // Search agents bypass HA entirely — no HA entity exists for them.
                  app.log.warn({ threadId, requestId, agent: haTarget.agentId, searchAgentKey, err }, 'search_agent_direct_failed');
                  return null;
                }),
            );
          } else if (isTodoAgent) {
            // Todo agent: LLM planner → Microsoft Graph Tasks — bypass HA entirely.
            app.log.info({ threadId, requestId, agent: haTarget.agentId }, 'todo_agent_direct');
            const pendingText = await planPendingMailOrTodoMutation({
              threadId: effectiveThreadId,
              clientChannel: clientChannel ?? undefined,
              agent: 'todo',
              text: assistantInputText,
              routeKey: agentEntry?.key,
            });
            if (pendingText) {
              tasks.push(Promise.resolve({
                kind: 'ha_text' as const,
                agentId: haTarget.agentId,
                text: pendingText,
              }));
              continue;
            }
            tasks.push(
              callTodoAgent(assistantInputText, {
                MICROSOFT_CLIENT_ID:      deps.env.MICROSOFT_CLIENT_ID,
                MICROSOFT_CLIENT_SECRET:  deps.env.MICROSOFT_CLIENT_SECRET,
                MICROSOFT_REFRESH_TOKEN:  deps.env.MICROSOFT_REFRESH_TOKEN,
                MICROSOFT_TENANT_ID:      deps.env.MICROSOFT_TENANT_ID,
                OAUTH_REFRESH_TOKEN_STORE_PATH: deps.env.OAUTH_REFRESH_TOKEN_STORE_PATH,
                OPENAI_API_KEY:           deps.env.OPENAI_API_KEY,
                OPENAI_BASE_URL:          deps.env.OPENAI_BASE_URL,
                OPENAI_TIMEOUT_MS:        deps.env.OPENAI_TIMEOUT_MS,
                OPENAI_MODEL_SUMMARY:     deps.env.OPENAI_MODEL_SUMMARY,
              }, app.log)
                .then((txt): SpecializedResult | null => {
                  app.log.info({ threadId, requestId, agent: haTarget.agentId }, 'todo_agent_direct_done');
                  return { kind: 'ha_text', agentId: haTarget.agentId, text: txt };
                })
                .catch((err) => {
                  app.log.warn({ threadId, requestId, agent: haTarget.agentId, err }, 'todo_agent_direct_failed');
                  return null;
                }),
            );
          } else if (isMailAgent) {
            // Mail agent: LLM planner → Gmail / Outlook Graph — bypass HA entirely.
            app.log.info({ threadId, requestId, agent: haTarget.agentId }, 'mail_agent_direct');
            const pendingText = await planPendingMailOrTodoMutation({
              threadId: effectiveThreadId,
              clientChannel: clientChannel ?? undefined,
              agent: 'mail',
              text: assistantInputText,
              routeKey: agentEntry?.key,
            });
            if (pendingText) {
              tasks.push(Promise.resolve({
                kind: 'ha_text' as const,
                agentId: haTarget.agentId,
                text: pendingText,
              }));
              continue;
            }
            tasks.push(
              callMailAgent(assistantInputText, {
                mailAccounts:    buildMailAccounts(deps.env),
                OAUTH_REFRESH_TOKEN_STORE_PATH: deps.env.OAUTH_REFRESH_TOKEN_STORE_PATH,
                OPENAI_API_KEY:  deps.env.OPENAI_API_KEY,
                OPENAI_BASE_URL: deps.env.OPENAI_BASE_URL,
                OPENAI_TIMEOUT_MS: deps.env.OPENAI_TIMEOUT_MS,
                OPENAI_MODEL_SUMMARY: deps.env.OPENAI_MODEL_SUMMARY,
              }, app.log)
                .then((txt): SpecializedResult | null => {
                  app.log.info({ threadId, requestId, agent: haTarget.agentId }, 'mail_agent_direct_done');
                  return { kind: 'ha_text', agentId: haTarget.agentId, text: txt };
                })
                .catch((err) => {
                  app.log.warn({ threadId, requestId, agent: haTarget.agentId, err }, 'mail_agent_direct_failed');
                  return null;
                }),
            );
          } else if (isCalendarAgent) {
            // Calendar agent: LLM planner → Google Calendar API — bypass HA entirely.
            app.log.info({ threadId, requestId, agent: haTarget.agentId }, 'calendar_agent_direct');
            tasks.push(
              planPendingCalendarMutation(effectiveThreadId, assistantInputText, clientChannel ?? undefined)
                .then((txt): SpecializedResult | null => {
                  app.log.info({ threadId, requestId, agent: haTarget.agentId }, 'calendar_agent_direct_done');
                  return { kind: 'ha_text', agentId: haTarget.agentId, text: txt };
                })
                .catch((err) => {
                  app.log.warn({ threadId, requestId, agent: haTarget.agentId, err }, 'calendar_agent_direct_failed');
                  return null;
                }),
            );
          } else if (isWeatherAgent) {
            app.log.info({ threadId, requestId, agent: haTarget.agentId }, 'weather_agent_direct');
            tasks.push(
              deps.ha
                ? deps.ha.getStates()
                    .then((statesRaw) => {
                      const haStates = toEntityStates(statesRaw);
                      const weather = buildWeatherSnapshotFromStates(haStates);
                      if (!weather) return null;

                      // Try deterministic path first (current temp, humidity, condition, precipitation)
                      const deterministicReply = synthesizeDeterministicWeatherReply({
                        userText: assistantInputText,
                        weather,
                        log: app.log,
                      });
                      if (deterministicReply) {
                        app.log.info({ threadId, requestId, agent: haTarget.agentId }, 'weather_deterministic_used');
                        return deterministicReply;
                      }

                      // Fallback to OpenAI synthesis for complex queries
                      return synthesizeWeatherReplyWithOpenAi({
                        openAiApiKey: deps.env.OPENAI_API_KEY!,
                        openAiBaseUrl: deps.env.OPENAI_BASE_URL,
                        model: deps.env.OPENAI_MODEL_SUMMARY,
                        timeoutMs: deps.env.OPENAI_TIMEOUT_MS,
                        userText: assistantInputText,
                        weather,
                        log: app.log,
                      });
                    })
                    .then((txt): SpecializedResult | null => {
                      if (!txt) return null;
                      return { kind: 'ha_text', agentId: haTarget.agentId, text: txt };
                    })
                    .catch((err) => {
                      app.log.warn({ threadId, requestId, agent: haTarget.agentId, err }, 'weather_agent_direct_failed');
                      return null;
                    })
                : Promise.resolve(null),
            );
          } else {
            tasks.push(
              conversationService
                .callHomeAssistantConversation(
                  applyFrenchVoiceHubGuard(assistantInputText, clientChannel),
                  effectiveThreadId,
                  undefined,
                  haTarget.agentId,
                )
                .then((txt): SpecializedResult | null => {
                  if (/^\s*OUT_OF_SCOPE\s*$/i.test(txt)) {
                    app.log.info({ threadId, requestId, agent: haTarget.agentId }, 'ha_specialized_agent_out_of_scope');
                    return null;
                  }
                  app.log.info({ threadId, requestId, agent: haTarget.agentId }, 'ha_specialized_agent_done');
                  return { kind: 'ha_text', agentId: haTarget.agentId, text: txt };
                })
                .catch((err) => {
                  app.log.warn({ threadId, requestId, agent: haTarget.agentId, err }, 'ha_specialized_agent_failed');
                  return null;
                }),
            );
          }
        }

        const taskResults = await Promise.all(tasks);
        const goodResults = taskResults.filter((r): r is SpecializedResult => r !== null);
        const aggregatedSearchSources = Array.from(new Set(goodResults.flatMap((r) => (
          r.kind === 'ha_text' ? (r.sources ?? []) : []
        ))));
        if (aggregatedSearchSources.length > 0) searchSources = aggregatedSearchSources;

        if (goodResults.length > 0) {
          const spotifyRes = goodResults.find(
            (r): r is Extract<SpecializedResult, { kind: 'spotify_tts' }> => r.kind === 'spotify_tts',
          );

          // Single Spotify-only result → preserve full Spotify response shape (with planner metadata)
          if (spotifyRes && goodResults.length === 1) {
            const spotifyVoiceText = voiceEnabled
              ? formatVoiceResponse({
                  text: spotifyRes.tts,
                  domain: 'spotify',
                  mode: voiceMode,
                })
              : spotifyRes.tts;
            void conversationService.persistMessages(effectiveThreadId, text, spotifyVoiceText).then(async () => {
              if (await summarizationService.shouldPresummarize(effectiveThreadId)) {
                summarizationService.startPresummarize(effectiveThreadId);
              }
            });
            const spotifyOnlyPayload = buildSpotifyIngestPayload({
              threadId: effectiveThreadId,
              responseText: spotifyVoiceText,
              spotify: spotifyRes.spotifyPayload,
              action: spotifyRes.action,
              routingPath: inferSpotifyRoutingPath(spotifyRes.musicPlanReason),
              correlationId: correlationId || undefined,
              planner: { source: 'openai_music_agent', route: spotifyRes.musicPlanRoute, reason: spotifyRes.musicPlanReason },
            });
            if (sseStream !== null) { pushSseResponse(spotifyOnlyPayload); return reply; }
            return reply.code(200).send(spotifyOnlyPayload);
          }

          // Multi-target: LLM aggregation of all response parts
          const parts = goodResults.map((r) => ({
            agentId: r.kind === 'spotify_tts' ? SPOTIFY_AGENT_ID : r.agentId,
            text: r.kind === 'spotify_tts' ? r.tts : r.text,
          }));
          if (parts.length === 1) {
            // Single non-Spotify result — no synthesis needed
            assistantText = parts[0].text;
            if (parts[0].agentId === 'gmail' || parts[0].agentId === 'mail') responseDomain = 'mail';
            else if (parts[0].agentId === 'todo') responseDomain = 'todo';
            else if (parts[0].agentId === 'calendar') responseDomain = 'calendar';
            else if (parts[0].agentId.startsWith('search')) {
              responseDomain = 'search';
              const searchResult = goodResults[0];
              if (searchResult?.kind === 'ha_text') searchSources = searchResult.sources ?? [];
            }
            else if (parts[0].agentId === 'weather') responseDomain = 'weather';
            else responseDomain = 'executor';
          } else {
            app.log.info({ threadId, requestId, parts: parts.length }, 'multi_target_synthesizing');
            assistantText = await synthesizeAgentResponses({
              userText: assistantInputText,
              parts,
              options: {
                openAiApiKey: deps.env.OPENAI_API_KEY!,
                openAiBaseUrl: deps.env.OPENAI_BASE_URL,
                model: deps.env.OPENAI_MODEL_ROUTER,
                timeoutMs: deps.env.OPENAI_TIMEOUT_MS,
                log: app.log,
              },
            });
            app.log.info({ threadId, requestId, parts: parts.length }, 'multi_target_synthesized');
            responseDomain = 'general';
          }
        }
        // All tasks failed/OUT_OF_SCOPE → assistantText stays undefined → HA general fallback
      } else if (routerEnabled) {
        gracefulFallback = true;
      }
      // No valid targets above threshold → HA general fallback
    }

    // ── General HA fallback (only when router failed or produced no usable result) ─
    if (assistantText === undefined) {
      try {
        app.log.info({ threadId, requestId, agent: generalAgentId }, 'ingest_ha_general_fallback');
        const haText = await conversationService.callHomeAssistantConversation(
          applyFrenchVoiceHubGuard(assistantInputText, clientChannel),
          effectiveThreadId,
          undefined,
          generalAgentId,
        );
        if (/^\s*OUT_OF_SCOPE\s*$/i.test(haText)) {
          app.log.warn({ threadId, requestId, agent: generalAgentId }, 'ingest_ha_general_out_of_scope');
          assistantText = toDeterministicHaFailureMessage();
          gracefulFallback = true;
        } else {
          assistantText = haText;
        }
        responseDomain = 'general';
      } catch (err) {
        app.log.warn(
          { threadId, requestId, correlation_id: correlationId || undefined, err },
          'ingest_home_assistant_call_failed'
        );
        assistantText = toDeterministicHaFailureMessage();
        responseDomain = 'general';
        gracefulFallback = true;
      }
    }

    const assistantTextForClient = sanitizeResponseAttribution(assistantText, responseDomain);
    const assistantTextVoice = voiceEnabled
      ? formatVoiceResponse({
          text: assistantTextForClient,
          domain: responseDomain,
          mode: voiceMode,
        })
      : assistantTextForClient;

    if (responseDomain === 'mail') {
      const parsedMail = extractMailStateFromReply(assistantText);
      if (parsedMail) {
        const existing = voiceThreadState.get(effectiveThreadId) ?? {};
        voiceThreadState.set(effectiveThreadId, { ...existing, ...parsedMail });
      }
    }

    void conversationService.persistMessages(effectiveThreadId, text, assistantTextVoice).then(async () => {
      if (await summarizationService.shouldPresummarize(effectiveThreadId)) {
        summarizationService.startPresummarize(effectiveThreadId);
      }
    });

    // Pre-warm TTS: start audio generation in background so the Desktop's
    // subsequent /v1/tts call hits the cache instead of waiting for HA/OpenAI.
    if (voiceEnabled) {
      warmTtsInBackground(toSingleParagraphPlainText(assistantTextVoice));
    }

    const activeProposalForResponse = await pendingMutationRepository.findActiveByThread(effectiveThreadId) as PendingMutation | null;
    const payload = {
      threadId: effectiveThreadId,
      responseText: toSingleParagraphPlainText(assistantTextVoice),
      ...(usedSummaryVersion ? { usedSummaryVersion } : {}),
      ...(searchSources.length > 0 ? { sources: searchSources } : {}),
      replyMeta: {
        kind: responseDomain,
        source: semanticActivatedRouteKey ? 'semantic_router' : (gracefulFallback ? 'ha_general' : 'router_or_specialized'),
        ...(semanticActivatedRouteKey ? { routeKey: semanticActivatedRouteKey } : {}),
        semanticDecision: semanticActivatedRouteKey && isCalendarMutationRouteKey(semanticActivatedRouteKey)
          ? (activeProposalForResponse?.agent === 'calendar' && activeProposalForResponse.routeKey === semanticActivatedRouteKey && activeProposalForResponse.action !== 'disambiguate_event' ? 'confirmation_required' : 'clarification_required')
          : (semanticActivatedRouteKey ? 'activated' : (routerResult.status === 'rejected' ? 'rejected' : 'not_activated')),
        ...(activeProposalForResponse && activeProposalForResponse.agent === responseDomain ? {
          proposalId: activeProposalForResponse.proposalId,
          pendingAction: `${activeProposalForResponse.agent}.${activeProposalForResponse.action}`,
        } : {}),
        ...(gracefulFallback ? { fallbackReason: 'general_fallback' } : {}),
      },
    };

    const validated = responseSchema.safeParse(payload);
    if (!validated.success) {
      if (sseStream !== null) { sseStream.push(null); return reply; }
      return reply.code(500).send({ error: 'response_validation_failed' });
    }

    // Mettre à jour le temps de réponse pour activer la fenêtre de conversation (10s)
    await threadRepository.updateResponseTime(effectiveThreadId, Date.now());

    recordPerf('ingest', Date.now() - t0);
    app.log.info({ threadId: effectiveThreadId, requestId, elapsed_ms: Date.now() - t0, voice_turn_id: voiceTurnId || undefined }, 'ingest_complete');
    if (sseStream !== null) { pushSseResponse(payload); return reply; }
    return reply.code(200).send(payload);
  });

  app.post('/v1/stt/:engineId', async (req, reply) => {
    const params = sttParamsSchema.safeParse(req.params);
    if (!params.success) {
      return reply.code(400).send({ error: 'invalid_engine_id' });
    }

    const body = req.body;
    if (!Buffer.isBuffer(body) || body.length === 0) {
      return reply.code(400).send({ error: 'invalid_audio_body' });
    }

    const incomingContentType = typeof req.headers['content-type'] === 'string' ? req.headers['content-type'] : 'audio/wav';
    const incomingSpeechContent = typeof req.headers['x-speech-content'] === 'string'
      ? req.headers['x-speech-content'].trim()
      : '';
    const speechContent = incomingSpeechContent || 'format=wav; codec=pcm; sample_rate=16000; bit_rate=16; channel=1; language=fr';

    const requestedEngineId = params.data.engineId.trim();
    const t0 = Date.now();
    const voiceTurnId = typeof req.headers['x-voice-turn-id'] === 'string' ? req.headers['x-voice-turn-id'].trim() : '';

    // Helper: attempt HA local STT and return result or null on failure.
    const tryHaStt = async (): Promise<{ text: string; engineId: string } | null> => {
      if (!deps.env.HA_BASE_URL || !deps.env.HA_TOKEN) return null;
      const normalizedRequestedEngine = requestedEngineId.replace(/^stt\./u, '');
      const haController = new AbortController();
      const haTimeoutId = setTimeout(() => haController.abort(), deps.env.HA_TIMEOUT_MS);
      try {
        const candidateResponse = await fetch(`${deps.env.HA_BASE_URL.replace(/\/$/, '')}/api/stt/${encodeURIComponent(requestedEngineId)}`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${deps.env.HA_TOKEN}`,
            'content-type': incomingContentType,
            'x-speech-content': speechContent,
          },
          body: bufferToWebBytes(body),
          signal: haController.signal,
        }).finally(() => clearTimeout(haTimeoutId));
        if (!candidateResponse.ok) return null;
        const rawHa = await candidateResponse.text();
        let parsedHa: unknown = rawHa;
        try { parsedHa = rawHa ? JSON.parse(rawHa) : {}; } catch { parsedHa = { text: rawHa }; }
        const rootHa = parsedHa && typeof parsedHa === 'object' ? (parsedHa as Record<string, unknown>) : {};
        const haText = toSingleParagraphPlainText(
          typeof rootHa.text === 'string' ? rootHa.text : typeof rootHa.result === 'string' ? rootHa.result : ''
        );
        if (!haText) return null;
        return { text: haText, engineId: requestedEngineId };
      } catch {
        void normalizedRequestedEngine; // suppress unused warning
        return null;
      }
    };

    if (deps.env.STT_LOCAL_FIRST) {
      // Local-first mode: try HA STT before OpenAI cloud.
      const localResult = await tryHaStt();
      if (localResult) {
        recordPerf('stt', Date.now() - t0);
        app.log.info({ engineId: localResult.engineId, elapsed_ms: Date.now() - t0, voice_turn_id: voiceTurnId || undefined, local_first: true }, 'stt_complete');
        return reply.code(200).send({ text: localResult.text, result: localResult.text, engineId: localResult.engineId });
      }
      // Fall through to OpenAI if local failed.
    }

    try {
      const openAiResult = await transcribeWithOpenAi({
        env: deps.env,
        body,
        incomingContentType,
      });

      recordPerf('stt', Date.now() - t0);
      app.log.info({ engineId: `openai:${openAiResult.model}`, elapsed_ms: Date.now() - t0, voice_turn_id: voiceTurnId || undefined }, 'stt_complete');
      return reply.code(200).send({
        text: openAiResult.text,
        result: openAiResult.text,
        engineId: `openai:${openAiResult.model}`,
      });
    } catch (err) {
      // Empty transcript = silence/noise. Skip the HA fallback — HA will also return empty.
      // Only fall back to HA for real failures (network error, auth, etc.).
      if (err instanceof Error && err.message === 'openai_stt_empty_transcript') {
        app.log.info({ engineId: 'openai', voice_turn_id: voiceTurnId || undefined }, 'stt_openai_empty_silence_skip');
        return reply.code(422).send({ error: 'ha_stt_empty_transcript', engineId: 'openai' });
      }
      app.log.warn({ err }, 'stt_openai_failed_falling_back_to_ha');
    }

    if (!deps.env.HA_BASE_URL || !deps.env.HA_TOKEN) {
      return reply.code(503).send({
        error: 'stt_not_available',
        hint: 'Configure OPENAI_API_KEY for primary STT and/or HA STT engine for fallback.',
      });
    }
    const normalizedRequestedEngine = requestedEngineId.replace(/^stt\./u, '');
    const engineCandidates = [
      requestedEngineId,
      normalizedRequestedEngine,
      `stt.${normalizedRequestedEngine}`,
      normalizedRequestedEngine === 'whisper' ? 'stt.faster_whisper' : undefined,
      normalizedRequestedEngine === 'whisper' ? 'faster_whisper' : undefined,
    ]
      .filter((value): value is string => Boolean(value))
      .filter((value, idx, arr) => arr.indexOf(value) === idx);

    let response: Response | undefined;
    let selectedEngineId = requestedEngineId;
    for (const candidate of engineCandidates) {
      const sttHaController = new AbortController();
      const sttHaTimeoutId = setTimeout(() => sttHaController.abort(), deps.env.HA_TIMEOUT_MS);
      const candidateResponse = await fetch(`${deps.env.HA_BASE_URL.replace(/\/$/, '')}/api/stt/${encodeURIComponent(candidate)}`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${deps.env.HA_TOKEN}`,
          'content-type': incomingContentType,
          'x-speech-content': speechContent,
        },
        body: bufferToWebBytes(body),
        signal: sttHaController.signal,
      }).finally(() => clearTimeout(sttHaTimeoutId));

      if (candidateResponse.ok || candidateResponse.status !== 404) {
        response = candidateResponse;
        selectedEngineId = candidate;
        break;
      }

      response = candidateResponse;
    }

    if (!response) {
      return reply.code(500).send({ error: 'stt_unexpected_state' });
    }

    const raw = await response.text();
    let parsed: unknown;
    try {
      parsed = raw ? (JSON.parse(raw) as unknown) : {};
    } catch {
      parsed = { text: raw };
    }

    if (!response.ok) {
      if (response.status === 404) {
        return reply.code(404).send({
          error: 'ha_stt_engine_not_found',
          requestedEngineId,
          triedEngineIds: engineCandidates,
          hint: 'Configure un moteur STT Home Assistant (ex: faster_whisper) ou utilise un engineId valide.',
        });
      }

      return reply.code(response.status).send({ error: 'ha_stt_failed' });
    }

    const root = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
    const text = toSingleParagraphPlainText(
      typeof root.text === 'string'
        ? root.text
        : typeof root.result === 'string'
          ? root.result
          : ''
    );

    if (!text) {
      return reply.code(422).send({
        error: 'ha_stt_empty_transcript',
        engineId: selectedEngineId,
      });
    }

    recordPerf('stt', Date.now() - t0);
    app.log.info({ engineId: selectedEngineId, elapsed_ms: Date.now() - t0, voice_turn_id: voiceTurnId || undefined }, 'stt_complete');
    return reply.code(200).send({ text, result: text, engineId: selectedEngineId });
  });

  app.get('/v1/conversation-agent/screening', async (_req, reply) => {
    if (!deps.env.HA_BASE_URL || !deps.env.HA_TOKEN || !deps.ha) {
      return reply.code(503).send({ error: 'ha_not_configured' });
    }

    const configuredAgentId = 'conversation.openai_conversation';
    const preferredSecondaryAgentId = 'conversation.openai_conversation';

    try {
      const statesRaw = await deps.ha.getStates();
      const states = toEntityStates(statesRaw);
      const conversationAgents = states
        .map((item) => item.entity_id)
        .filter((entityId) => entityId.startsWith('conversation.'))
        .sort((a, b) => a.localeCompare(b));

      const configuredAgentAvailable = conversationAgents.includes(configuredAgentId);
      const secondaryAgentAvailable = conversationAgents.includes(preferredSecondaryAgentId);

      return reply.code(200).send({
        configuredAgentId,
        configuredAgentAvailable,
        preferredSecondaryAgentId,
        preferredSecondaryAgentAvailable: secondaryAgentAvailable,
        availableConversationAgents: conversationAgents,
        recommendation:
          !configuredAgentAvailable && secondaryAgentAvailable
            ? `Set HA_CONVERSATION_AGENT_ID=${preferredSecondaryAgentId} to use the secondary agent by default.`
            : undefined,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'unknown_error';
      return reply.code(502).send({ error: 'ha_screening_failed', message });
    }
  });

  const registerTtsRoute = (path: string, defaultMode: TtsRouteMode): void => {
    app.post(path, async (req, reply) => {
    const parsed = ttsRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_body', issues: parsed.error.issues });
    }

    const mode = resolveRequestedTtsMode(defaultMode, parsed.data.provider);
    const haEnabled = mode !== 'openai' && hasHaTtsConfig(deps.env);
    const openAiTtsCfg = resolveOpenAiTtsRuntimeConfig(deps.env);
    const preferOpenAiInAuto =
      mode === 'auto' &&
      Boolean(openAiTtsCfg) &&
      typeof deps.env.OPENAI_TTS_BASE_URL === 'string' &&
      deps.env.OPENAI_TTS_BASE_URL.trim().length > 0;

    if (!haEnabled && !openAiTtsCfg) {
      return reply.code(503).send({ error: 'tts_not_configured', provider: mode });
    }

    if (mode === 'ha' && !haEnabled) {
      return reply.code(503).send({ error: 'ha_not_configured' });
    }

    if (mode === 'openai' && !openAiTtsCfg) {
      return reply.code(503).send({ error: 'openai_tts_not_configured' });
    }

    const text = toSingleParagraphPlainText(parsed.data.text);
    const t0 = Date.now();
    const voiceTurnId = typeof req.headers['x-voice-turn-id'] === 'string' ? req.headers['x-voice-turn-id'].trim() : '';

    // ── Warm cache check ──────────────────────────────────────────────────────
    // ingest pre-warms TTS while building the response. If the Desktop calls
    // /v1/tts shortly after, we serve the pre-generated audio immediately.
    const ttsKey = text.trim().slice(0, 512);
    if (mode === 'auto') {
      const warmHit = ttsWarmCache.get(ttsKey);
      if (warmHit && Date.now() - warmHit.at < TTS_WARM_TTL_MS) {
        recordPerf('tts', Date.now() - t0);
        app.log.info({ elapsed_ms: Date.now() - t0, via: 'warm_cache', voice_turn_id: voiceTurnId || undefined }, 'tts_complete');
        return reply.code(200).header('content-type', warmHit.contentType).header('x-tts-provider', 'warm_cache').send(warmHit.bytes);
      }
      // If pre-warm is still in-flight, join it instead of racing a duplicate request
      const warmPending = ttsWarmInFlight.get(ttsKey);
      if (warmPending) {
        const prewarmed = await warmPending;
        if (prewarmed) {
          recordPerf('tts', Date.now() - t0);
          app.log.info({ elapsed_ms: Date.now() - t0, via: 'warm_inflight', voice_turn_id: voiceTurnId || undefined }, 'tts_complete');
          return reply.code(200).header('content-type', prewarmed.contentType).header('x-tts-provider', 'warm_inflight').send(prewarmed.bytes);
        }
      }
    }

    const configuredEntity = deps.env.HA_TTS_ENTITY_ID?.trim();
    const primaryEngineId = configuredEntity && configuredEntity.length > 0
      ? configuredEntity
      : 'tts.elevenlabs_text_to_speech';
    const fallbackFromEnv = (deps.env.HA_TTS_FALLBACK_ENTITY_IDS ?? '')
      .split(',')
      .map((value) => value.trim())
      .filter((value) => value.length > 0);
    let candidateEngineIds = uniqueNonEmpty([primaryEngineId, ...fallbackFromEnv]);
    const haBaseUrl = deps.env.HA_BASE_URL?.replace(/\/$/, '') ?? '';

    if (haEnabled && deps.ha) {
      const nowMs = Date.now();
      const hasFreshProviderCache = Boolean(ttsProviderCache) && nowMs - ttsProviderCache!.at <= TTS_PROVIDER_CACHE_TTL_MS;

      if (hasFreshProviderCache) {
        const discoveredProviders = Array.from(ttsProviderCache!.providers.values());
        const availableCandidates = candidateEngineIds.filter((engineId) => ttsProviderCache!.providers.has(engineId));
        if (availableCandidates.length > 0) {
          // Keep configured priority, then try other discovered HA TTS providers.
          candidateEngineIds = uniqueNonEmpty([...availableCandidates, ...discoveredProviders]);
        } else if (discoveredProviders.length > 0) {
          // Configured provider seems invalid/unavailable: try discovered providers instead.
          candidateEngineIds = discoveredProviders;
        }
      } else {
        if (mode === 'ha') {
          await refreshTtsProviderCache();
          if (ttsProviderCache?.providers?.size) {
            const discoveredProviders = Array.from(ttsProviderCache.providers.values());
            const availableCandidates = candidateEngineIds.filter((engineId) => ttsProviderCache!.providers.has(engineId));
            candidateEngineIds = availableCandidates.length > 0
              ? uniqueNonEmpty([...availableCandidates, ...discoveredProviders])
              : discoveredProviders;
          }
        } else {
          void refreshTtsProviderCache();
        }
      }
    }

    // ── Parallel race: ElevenLabs (HA TTS) vs OpenAI TTS ────────────────────
    // Both are launched simultaneously. First success wins; the loser is aborted.
    type TtsWin = { bytes: Buffer; contentType: string; engineId: string; via: string };
    const attempts: Array<{ engineId: string; stage: 'tts_get_url' | 'audio_proxy'; status: number; message?: string }> = [];

    const haAbort = new AbortController();
    const openAiAbort = new AbortController();

    // Abortable sleep: exits immediately when signal fires (so the losing coroutine doesn't linger)
    const sleepOrAbort = (ms: number, signal: AbortSignal): Promise<void> =>
      new Promise<void>((resolve, reject) => {
        if (signal.aborted) { reject(new Error('aborted')); return; }
        const t = setTimeout(resolve, ms);
        signal.addEventListener('abort', () => { clearTimeout(t); reject(new Error('aborted')); }, { once: true });
      });

    // ── HA TTS coroutine ──────────────────────────────────────────────────────
    const doHaTts = async (): Promise<TtsWin> => {
      if (!haEnabled) throw new Error('ha_not_configured');
      for (let index = 0; index < candidateEngineIds.length; index += 1) {
        if (haAbort.signal.aborted) throw new Error('ha_tts_aborted');
        const engineId = candidateEngineIds[index]!;

        if (isTtsCbOpen(engineId)) {
          app.log.warn({ engineId }, 'tts_circuit_open_skipping');
          attempts.push({ engineId, stage: 'tts_get_url', status: 0, message: 'circuit_open' });
          continue;
        }

        // Step 1 – get URL
        const urlCtrl = new AbortController();
        const urlTimeout = setTimeout(() => urlCtrl.abort(), deps.env.HA_TIMEOUT_MS);
        const onHaAbortUrl = () => urlCtrl.abort();
        haAbort.signal.addEventListener('abort', onHaAbortUrl, { once: true });
        let ttsUrlResponse: Response;
        try {
          ttsUrlResponse = await fetch(`${haBaseUrl}/api/tts_get_url`, {
            method: 'POST',
            headers: { authorization: `Bearer ${deps.env.HA_TOKEN}`, 'content-type': 'application/json' },
            body: JSON.stringify({ engine_id: engineId, message: text, cache: true }),
            signal: urlCtrl.signal,
          });
        } finally {
          clearTimeout(urlTimeout);
          haAbort.signal.removeEventListener('abort', onHaAbortUrl);
        }

        if (!ttsUrlResponse.ok) {
          const errorBody = await ttsUrlResponse.text();
          attempts.push({ engineId, stage: 'tts_get_url', status: ttsUrlResponse.status, message: errorBody.slice(0, 300) });
          recordTtsFailure(engineId);
          app.log.warn(
            { engineId, stage: 'tts_get_url', status: ttsUrlResponse.status, body: errorBody.slice(0, 300), voice_turn_id: voiceTurnId || undefined },
            'tts_ha_engine_failed'
          );
          const hasNext = index < candidateEngineIds.length - 1;
          const shouldTryNext = hasNext && (isElevenLabsEngine(engineId)
            ? shouldFallbackFromElevenLabs(ttsUrlResponse.status, errorBody)
            : ttsUrlResponse.status === 404 || ttsUrlResponse.status === 429 || ttsUrlResponse.status >= 500);
          if (!shouldTryNext) break;
          continue;
        }

        const ttsPayload = (await ttsUrlResponse.json()) as { path?: string; url?: string };
        const proxyUrl = typeof ttsPayload.path === 'string' && ttsPayload.path.length > 0
          ? `${haBaseUrl}${ttsPayload.path}` : ttsPayload.url;

        if (!proxyUrl) {
          attempts.push({ engineId, stage: 'audio_proxy', status: 502, message: 'invalid_tts_response' });
          if (index < candidateEngineIds.length - 1) continue;
          break;
        }

        // Step 2 – fetch audio bytes (single attempt — OpenAI races in parallel so retries are pointless here)
        const proxyDelays = [0];
        let upstream: Response;
        for (let proxyAttempt = 0; proxyAttempt < proxyDelays.length; proxyAttempt += 1) {
          if (proxyDelays[proxyAttempt]! > 0) await sleepOrAbort(proxyDelays[proxyAttempt]!, haAbort.signal);
          if (haAbort.signal.aborted) throw new Error('ha_tts_aborted');
          const proxyCtrl = new AbortController();
          const proxyTimeout = setTimeout(() => proxyCtrl.abort(), deps.env.HA_TIMEOUT_MS);
          const onHaAbortProxy = () => proxyCtrl.abort();
          haAbort.signal.addEventListener('abort', onHaAbortProxy, { once: true });
          try {
            upstream = await fetch(proxyUrl, {
              method: 'GET',
              headers: { authorization: `Bearer ${deps.env.HA_TOKEN}` },
              signal: proxyCtrl.signal,
            });
          } finally {
            clearTimeout(proxyTimeout);
            haAbort.signal.removeEventListener('abort', onHaAbortProxy);
          }
          if (upstream.ok || upstream.status !== 500) break;
          if (proxyAttempt < proxyDelays.length - 1) {
            app.log.warn({ engineId, stage: 'audio_proxy', status: 500, proxyAttempt, voice_turn_id: voiceTurnId || undefined }, 'tts_ha_proxy_500_retrying');
          }
        }

        if (!upstream!.ok) {
          const errorText = await upstream!.text();
          attempts.push({ engineId, stage: 'audio_proxy', status: upstream!.status, message: errorText.slice(0, 300) });
          recordTtsFailure(engineId);
          app.log.warn(
            { engineId, stage: 'audio_proxy', status: upstream!.status, body: errorText.slice(0, 300), voice_turn_id: voiceTurnId || undefined },
            'tts_ha_engine_failed'
          );
          const hasNext = index < candidateEngineIds.length - 1;
          const shouldTryNext = hasNext && (isElevenLabsEngine(engineId)
            ? shouldFallbackFromElevenLabs(upstream!.status, errorText)
            : upstream!.status === 404 || upstream!.status === 429 || upstream!.status >= 500);
          if (!shouldTryNext) break;
          continue;
        }

        const contentType = upstream!.headers.get('content-type') ?? 'audio/mpeg';
        const haFilters = buildFfmpegFilters({ speed: deps.env.TTS_SPEED, pitchSemitones: deps.env.TTS_PITCH_SEMITONES, clarity: deps.env.TTS_CLARITY });
        const body = upstream!.body;
        const bytes = haFilters.length > 0 && body
          ? await pipeStreamThroughFfmpeg(body, haFilters)
          : Buffer.from(await upstream!.arrayBuffer());
        recordTtsSuccess(engineId);
        return { bytes, contentType, engineId, via: `ha:${engineId}` };
      }
      throw new Error('ha_tts_all_failed');
    };

    // ── OpenAI TTS coroutine ──────────────────────────────────────────────────
    const doOpenAiTts = async (): Promise<TtsWin> => {
      if (!openAiTtsCfg) throw new Error('openai_tts_not_configured');
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), openAiTtsCfg.timeoutMs);
      const onExternal = () => controller.abort();
      openAiAbort.signal.addEventListener('abort', onExternal, { once: true });
      const response = await fetch(`${openAiTtsCfg.baseUrl.replace(/\/$/, '')}/audio/speech`, {
        method: 'POST',
        headers: { authorization: `Bearer ${openAiTtsCfg.apiKey}`, 'content-type': 'application/json' },
        // Speed is passed natively to OpenAI API (0.25–4.0); voice character via instructions if set
        body: JSON.stringify({
          model: openAiTtsCfg.model,
          voice: openAiTtsCfg.voice,
          input: text,
          response_format: openAiTtsCfg.format,
          speed: openAiTtsCfg.speed,
          ...(openAiTtsCfg.instructions ? { instructions: openAiTtsCfg.instructions } : {}),
        }),
        signal: controller.signal,
      }).finally(() => {
        clearTimeout(timeoutId);
        openAiAbort.signal.removeEventListener('abort', onExternal);
      });
      if (!response.ok) {
        const errBody = await response.text();
        throw new Error(`openai_tts_failed:${response.status}:${errBody.slice(0, 300)}`);
      }
      const contentType = response.headers.get('content-type') ?? 'audio/mpeg';
      // OpenAI: speed handled natively by API param, voice character via instructions.
      // NO ffmpeg processing — any filter stacks on top of already-processed audio and causes artifacts.
      const openAiFilters = buildFfmpegFilters({ speed: deps.env.TTS_SPEED, pitchSemitones: 0, clarity: false }, true);
      const openAiBody = response.body;
      const bytes = openAiFilters.length > 0 && openAiBody
        ? await pipeStreamThroughFfmpeg(openAiBody, openAiFilters)
        : Buffer.from(await response.arrayBuffer());
      return { bytes, contentType, engineId: `openai:${openAiTtsCfg.model}`, via: `openai:${openAiTtsCfg.model}` };
    };

    // ── Race: ElevenLabs vs OpenAI — first success wins, loser aborted ────────
    // Cache hit ElevenLabs → OpenAI aborted at ~0ms cost.
    // ElevenLabs quota/500 retries → OpenAI wins after ~1s, ElevenLabs sleep interrupted via haAbort.
    let winner: TtsWin;
    try {
      const activePromises: Promise<TtsWin>[] = [];
      if (mode !== 'openai' && !preferOpenAiInAuto) {
        const haPromise = doHaTts().then((v) => { openAiAbort.abort('race_winner_ha'); return v; });
        activePromises.push(haPromise);
      }
      if (mode !== 'ha' && openAiTtsCfg) {
        const openAiPromise = doOpenAiTts().then((v) => { haAbort.abort('race_winner_openai'); return v; });
        activePromises.push(openAiPromise);
      }
      winner = await new Promise<TtsWin>((resolve, reject) => {
        let remaining = activePromises.length;
        const onFail = () => { remaining -= 1; if (remaining === 0) reject(new Error('tts_all_failed')); };
        for (const p of activePromises) p.then(resolve, onFail);
      });
    } catch {
      if (mode === 'ha' && openAiTtsCfg) {
        try {
          winner = await doOpenAiTts();
          app.log.warn(
            { attempts, via: winner.via, voice_turn_id: voiceTurnId || undefined },
            'tts_ha_fallback_openai'
          );
          recordPerf('tts', Date.now() - t0);
          app.log.info({ engineId: winner.engineId, via: winner.via, elapsed_ms: Date.now() - t0, voice_turn_id: voiceTurnId || undefined }, 'tts_complete');
          return reply
            .code(200)
            .header('content-type', winner.contentType)
            .header('x-tts-provider', `${winner.via}:ha_fallback`)
            .send(winner.bytes);
        } catch {
          // keep existing failure response below
        }
      }
      app.log.warn({ attempts, voice_turn_id: voiceTurnId || undefined }, 'tts_all_failed');
      return reply.code(502).send({ error: 'tts_failed_all_candidates', attempts });
    }

    recordPerf('tts', Date.now() - t0);
    app.log.info({ engineId: winner.engineId, via: winner.via, elapsed_ms: Date.now() - t0, voice_turn_id: voiceTurnId || undefined }, 'tts_complete');
    // Store in warm cache so any duplicate call within 30s is instant
    if (mode === 'auto') {
      ttsWarmCache.set(ttsKey, { bytes: winner.bytes, contentType: winner.contentType, at: Date.now() });
    }
    return reply
      .code(200)
      .header('content-type', winner.contentType)
      .header('x-tts-provider', winner.via)
      .send(winner.bytes);
    });
  };

  registerTtsRoute('/v1/tts', 'auto');
  registerTtsRoute('/v1/tts/ha', 'ha');
  registerTtsRoute('/v1/tts/openai', 'openai');

  app.get('/v1/threads', async (req, reply) => {
    const listQuerySchema = z.object({
      limit: z.coerce.number().int().min(1).max(200).optional(),
      channel: z.string().min(2).max(64).optional(),
    });

    const parsedQuery = listQuerySchema.safeParse(req.query ?? {});
    if (!parsedQuery.success) {
      return reply.code(400).send({ error: 'invalid_query', issues: parsedQuery.error.issues });
    }

    const limit = parsedQuery.data.limit ?? 40;
    const channel = normalizeClientChannel(parsedQuery.data.channel);
    const items = await threadRepository.listRecent(limit, { channel: channel ?? null });

    return reply.code(200).send({ items });
  });

  app.get('/v1/threads/:threadId/history', async (req, reply) => {
    const params = z.object({ threadId: threadIdSchema }).safeParse(req.params);
    if (!params.success) {
      return reply.code(400).send({ error: 'invalid_thread_id' });
    }

    const parsedQuery = historyQuerySchema.safeParse(req.query ?? {});
    if (!parsedQuery.success) {
      return reply.code(400).send({ error: 'invalid_query', issues: parsedQuery.error.issues });
    }

    const threadId = params.data.threadId.trim();
    const limit = parsedQuery.data.limit ?? 200;

    const thread = await threadRepository.findById(threadId);
    if (!thread) {
      return reply.code(404).send({ error: 'thread_not_found' });
    }
    const recent = await messageRepository.getRecentMessages(threadId, limit);

    return reply.code(200).send({
      threadId,
      summary: thread.summary,
      summaryVersion: `v${thread.summaryVersion}`,
      summaryUptoSeq: thread.summaryUptoSeq,
      messages: recent.map((item) => ({
        seq: item.seq,
        role: item.role,
        text: item.content,
        createdAt: new Date(item.createdAtMs).toISOString(),
      })),
    });
  });

  app.delete('/v1/threads/:threadId', async (req, reply) => {
    const params = z.object({ threadId: threadIdSchema }).safeParse(req.params);
    if (!params.success) {
      return reply.code(400).send({ error: 'invalid_thread_id' });
    }

    const threadId = params.data.threadId.trim();

    try {
      const deleted = await threadRepository.deleteThread(threadId);

      return reply.code(200).send({
        threadId,
        deleted,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'unknown_error';
      return reply.code(500).send({ error: 'delete_failed', message });
    }
  });

  app.get('/v1/stats', async (_req, reply) => {
    const keys = ['stt', 'tts', 'ingest'];
    const stats: Record<string, ReturnType<typeof computePercentiles>> = {};
    for (const key of keys) {
      stats[key] = computePercentiles(key);
    }
    const cbState: Record<string, { failures: number; openUntil: string | null }> = {};
    for (const [engineId, state] of ttsCb.entries()) {
      cbState[engineId] = {
        failures: state.failures,
        openUntil: state.openUntil > 0 ? new Date(state.openUntil).toISOString() : null,
      };
    }
    return reply.code(200).send({ latency_ms: stats, tts_circuit_breaker: cbState });
  });

}
