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
import type { ProactiveContextDomain } from '../context/ProactiveContextCache';
import { enrichWithContextNote } from '../conversation/contextNote';
import { ConversationService } from '../conversation/ConversationService';
import { detectEffectiveThreadId } from '../conversation/conversationWindow';
import {
  type AgentRouteEntry,
  LOCAL_WEATHER_ROUTER_AGENT_ID,
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
  type VoiceResponseMode,
  type VoiceThreadState,
} from '../conversation/voiceUx';
import { AgoraClientError } from '../culture/AgoraClient';
import { cultureActionSchema } from '../culture/contracts';
import { executeCulture, inferCultureRequest } from '../culture/cultureAgent';
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
import { completeOllamaChat, isOllamaBaseUrl } from '../ollamaChat';
import { type PendingMutationRecord,PendingMutationRepository } from '../pendingMutations/PendingMutationRepository';
import { ConversationResultSetRepository } from '../resultSets/ConversationResultSetRepository';
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
import { transcribeWithWyoming } from '../stt/wyomingClient';
import { formatParisTime } from '../time/parisTime';
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
import { buildWeatherSnapshotFromStates, type HaStateLike, type WeatherSnapshot } from '../weather/weatherSnapshot';
import {
  audioExtensionFromContentType,
  bufferToWebBytes,
  buildFfmpegFilters,
  pipeStreamThroughFfmpeg,
  resolveOpenAiTtsRuntimeConfig,
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
  domain: z.enum(['spotify', 'culture']).optional(),
  action: z.union([spotifyActionSchema, cultureActionSchema]).optional(),
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
  voiceAudio: z.object({
    contentType: z.string().min(1),
    base64Audio: z.string().min(1),
    source: z.enum(['inline_warm_cache', 'inline_warm_inflight']).optional(),
  }).optional(),
  replyMeta: z.object({
    kind: z.string().min(1),
    source: z.string().min(1),
    routeKey: z.string().min(1).optional(),
    semanticDecision: z.string().min(1).optional(),
    fallbackReason: z.string().min(1).optional(),
    llmProvider: z.enum(['ollama', 'openai']).optional(),
    llmModel: z.string().min(1).optional(),
    llmLatencyMs: z.number().int().nonnegative().optional(),
    llmFallbackReason: z.string().min(1).optional(),
    proposalId: z.string().min(1).optional(),
    pendingAction: z.string().min(1).optional(),
    contextCache: z.object({
      hit: z.boolean(),
      stale: z.boolean(),
      fetchedAt: z.string().min(1),
      domain: z.string().min(1),
      questionKey: z.string().min(1).optional(),
    }).optional(),
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

/**
 * Avoid spending an LLM routing pass on social small talk.  Besides being
 * deterministic, this keeps interactive voice latency low when Ollama is
 * temporarily busy with a longer Helix or conversation request.
 */
function simpleConversationalReply(text: string): string | undefined {
  const normalized = normalizeIntentText(text);
  const isGreeting = /\b(salut|bonjour|bonsoir|hello|coucou|hey)\b/.test(normalized);
  const asksWellbeing = /\b(comment ca va|ca va|tu vas bien|comment vas tu|quoi de neuf)\b/.test(normalized);
  if (isGreeting && asksWellbeing) return 'Salut ! Je vais bien, merci. Et toi, comment ça va ?';
  if (/^(salut|bonjour|bonsoir|hello|coucou|hey)(\s+jarvis)?[!., ]*$/u.test(normalized)) {
    return 'Salut ! Je suis là. Que puis-je faire pour toi ?';
  }
  return undefined;
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

/** Ordinary chat must stay local and must never depend on Home Assistant. */
async function answerGeneralConversationWithOllama(params: {
  text: string;
  baseUrl: string;
  model: string;
  timeoutMs: number;
}): Promise<string> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), params.timeoutMs);
  try {
    const content = await completeOllamaChat({
      baseUrl: params.baseUrl,
      model: params.model,
      temperature: 0.35,
      numPredict: 180,
      messages: [
          {
            role: 'system',
            content: 'Tu es Jarvis, un assistant personnel francophone. Réponds naturellement, brièvement et utilement. Ne mentionne jamais Home Assistant, les agents, les conteneurs ou le routage. N’invente aucune action sur des appareils.',
          },
          { role: 'user', content: params.text },
      ],
      signal: controller.signal,
    });
    if (!content) throw new Error('ollama_general_empty_response');
    return toSingleParagraphPlainText(content);
  } finally {
    clearTimeout(timeoutId);
  }
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
    if (isOllamaBaseUrl(params.openAiBaseUrl)) {
      const content = await completeOllamaChat({
        baseUrl: params.openAiBaseUrl, model: params.model, temperature: 0.2, numPredict: 220,
        messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }], signal: controller.signal,
      });
      if (!content) throw new Error('weather_ollama_empty_response');
      params.log?.info({ model: params.model, content_len: content.length }, 'weather_ollama_done');
      return toSingleParagraphPlainText(content);
    }
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
  const sttBaseUrl = params.env.OPENAI_STT_BASE_URL?.trim() || params.env.OPENAI_BASE_URL;
  const response = await fetch(`${sttBaseUrl.replace(/\/$/, '')}/audio/transcriptions`, {
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

type PreparedContextMatch = {
  domain: ProactiveContextDomain;
  questionKeys: string[];
  voiceDomain: VoiceResponseDomain;
};

const PROACTIVE_CONTEXT_ACTION_RE = /\b(mets?|met|joue|lance|pause|arrete|arrête|reprends?|suivant|precedent|pr[eé]c[eé]dent|ajoute|cree|cr[eé]e|supprime|efface|envoie|r[eé]ponds?|archive|marque|coche|d[eé]cale|modifie|ouvre|ferme|allume|eteins|[eé]teins|baisse|augmente|r[eé]gle)\b/iu;

function inferPreparedContextMatch(text: string): PreparedContextMatch | null {
  const normalized = text.toLocaleLowerCase('fr-FR');

  if (/\b(brief du jour|briefing du jour|brief matinal|brief du matin|resume ma journee|résume ma journée|programme de la journee|programme de la journée)\b/iu.test(normalized)) {
    return { domain: 'daily_brief', questionKeys: ['daily_brief.today'], voiceDomain: 'general' };
  }

  if (PROACTIVE_CONTEXT_ACTION_RE.test(normalized)) return null;

  if (/\b(nas|serveur|stockage|disque|memoire|m[eé]moire|ram|cpu)\b/iu.test(normalized)) {
    if (/\b(temp[eé]rature|chaud|thermal)\b/iu.test(normalized)) {
      return { domain: 'nas', questionKeys: ['nas.thermal', 'nas.health'], voiceDomain: 'general' };
    }
    if (/\b(place|stockage|disque|volume)\b/iu.test(normalized)) {
      return { domain: 'nas', questionKeys: ['nas.storage', 'nas.health'], voiceDomain: 'general' };
    }
    return { domain: 'nas', questionKeys: ['nas.health'], voiceDomain: 'general' };
  }

  if (/\b(actu|actus|actualit[eé]|news|quoi de neuf|nouvelles)\b/iu.test(normalized)) {
    return { domain: 'news', questionKeys: ['news.headlines'], voiceDomain: 'search' };
  }

  if (/\b(spotify|musique|titre|morceau|chanson|joue|lecture|appareil)\b/iu.test(normalized)) {
    if (/\b(appareil|device|enceinte|t[eé]l[eé]phone|ordi|ordinateur)\b/iu.test(normalized)) {
      return { domain: 'spotify', questionKeys: ['spotify.active_device', 'spotify.list_devices'], voiceDomain: 'spotify' };
    }
    if (/\b(pause|lecture)\b/iu.test(normalized)) {
      return { domain: 'spotify', questionKeys: ['spotify.playback_state', 'spotify.now_playing'], voiceDomain: 'spotify' };
    }
    return { domain: 'spotify', questionKeys: ['spotify.now_playing'], voiceDomain: 'spotify' };
  }

  if (/\b(mail|mails|email|emails|courriel|boite|boîte|inbox)\b/iu.test(normalized)) {
    if (/\b(dernier|r[eé]cent|resume|résume)\b/iu.test(normalized)) {
      return { domain: 'mail', questionKeys: ['mail.latest_summary', 'mail.unread_summary'], voiceDomain: 'mail' };
    }
    if (/\b(important|urgent|r[eé]pondre|repondre)\b/iu.test(normalized)) {
      return { domain: 'mail', questionKeys: ['mail.important_summary', 'mail.waiting_reply', 'mail.unread_summary'], voiceDomain: 'mail' };
    }
    return { domain: 'mail', questionKeys: ['mail.unread_summary', 'mail.latest_summary'], voiceDomain: 'mail' };
  }

  if (/\b(t[aâ]che|taches|todo|to-do|liste)\b/iu.test(normalized)) {
    if (/\b(retard|overdue)\b/iu.test(normalized)) {
      return { domain: 'todo', questionKeys: ['todo.overdue', 'todo.today'], voiceDomain: 'todo' };
    }
    if (/\b(prochaine|suivante|next)\b/iu.test(normalized)) {
      return { domain: 'todo', questionKeys: ['todo.next', 'todo.today'], voiceDomain: 'todo' };
    }
    return { domain: 'todo', questionKeys: ['todo.today', 'todo.overdue', 'todo.next'], voiceDomain: 'todo' };
  }

  if (/\b(agenda|calendrier|rdv|rendez-vous|rendez vous|planning|libre|dispo|disponible)\b/iu.test(normalized)) {
    if (/\b(demain)\b/iu.test(normalized)) {
      return { domain: 'calendar', questionKeys: ['calendar.tomorrow', 'calendar.next_event'], voiceDomain: 'calendar' };
    }
    if (/\b(libre|dispo|disponible)\b/iu.test(normalized)) {
      return { domain: 'calendar', questionKeys: ['calendar.free_busy', 'calendar.today'], voiceDomain: 'calendar' };
    }
    return { domain: 'calendar', questionKeys: ['calendar.next_event', 'calendar.today'], voiceDomain: 'calendar' };
  }

  if (/\b(m[eé]t[eé]o|temps|temp[eé]rature|degr[eé]|pluie|pleut|humidit[eé]|dehors)\b/iu.test(normalized)) {
    if (isClearlyExternalWeather(normalized)) return null;
    if (/\b(demain)\b/iu.test(normalized)) {
      return { domain: 'weather', questionKeys: ['weather.tomorrow', 'weather.weekly_trend'], voiceDomain: 'weather' };
    }
    if (/\b(semaine|tendance|prochains jours|prochains jours)\b/iu.test(normalized)) {
      return { domain: 'weather', questionKeys: ['weather.weekly_trend', 'weather.tomorrow'], voiceDomain: 'weather' };
    }
    if (/\b(max|maxi|maximale|plus chaud)\b/iu.test(normalized)) {
      return { domain: 'weather', questionKeys: ['weather.today_high', 'weather.today_outfit'], voiceDomain: 'weather' };
    }
    if (/\b(min|mini|minimale|plus froid)\b/iu.test(normalized)) {
      return { domain: 'weather', questionKeys: ['weather.today_low', 'weather.today_outfit'], voiceDomain: 'weather' };
    }
    if (/\b([01]?\d|2[0-3])\s*h\b|\bce matin\b|\bcet apres-midi\b|\bcet après-midi\b|\bce soir\b/iu.test(normalized)) {
      return { domain: 'weather', questionKeys: ['weather.today_by_hour', 'weather.conditions'], voiceDomain: 'weather' };
    }
    if (/\b(habill|m'habille|m habille|porter|veste|manteau)\b/iu.test(normalized)) {
      return { domain: 'weather', questionKeys: ['weather.today_outfit', 'weather.today_high', 'weather.today_low'], voiceDomain: 'weather' };
    }
    if (/\b(humidit[eé]|humide)\b/iu.test(normalized)) {
      return { domain: 'weather', questionKeys: ['weather.humidity', 'weather.conditions'], voiceDomain: 'weather' };
    }
    if (/\b(pluie|pleut|pleuvoir|averse)\b/iu.test(normalized)) {
      return { domain: 'weather', questionKeys: ['weather.precipitation', 'weather.conditions'], voiceDomain: 'weather' };
    }
    if (/\b(temp[eé]rature|degr[eé]|combien|fait)\b/iu.test(normalized)) {
      return { domain: 'weather', questionKeys: ['weather.temperature', 'weather.conditions'], voiceDomain: 'weather' };
    }
    return { domain: 'weather', questionKeys: ['weather.conditions', 'weather.temperature'], voiceDomain: 'weather' };
  }

  if (/\b(minuteur|timer|lumi[eè]re|lampe|volet|maison)\b/iu.test(normalized)) {
    if (/\b(minuteur|timer)\b/iu.test(normalized)) {
      return { domain: 'home', questionKeys: ['executor.timer_state'], voiceDomain: 'executor' };
    }
    if (/\b(lumi[eè]re|lampe)\b/iu.test(normalized)) {
      return { domain: 'home', questionKeys: ['executor.light_state'], voiceDomain: 'executor' };
    }
  }

  return null;
}

function buildPreparedContextUnavailableResponse(domain: ProactiveContextDomain): string | null {
  if (domain !== 'daily_brief') return null;
  return 'Je n ai pas encore de brief du jour fiable pret. Le cache de contexte est indisponible, donc je prefere ne pas inventer.';
}

function prepareContextAnswerForVoice(domain: ProactiveContextDomain, answerText: string): string {
  if (domain !== 'daily_brief') return answerText;
  return answerText.replace(/^Brief du jour\.\s+/iu, 'Brief du jour: ');
}

function formatPreparedContextVoiceResponse(
  match: PreparedContextMatch,
  answerText: string,
  voiceMode: VoiceResponseMode,
): string {
  if (match.domain === 'daily_brief') {
    return toSingleParagraphPlainText(sanitizeResponseAttribution(answerText, match.voiceDomain));
  }
  return formatVoiceResponse({
    text: answerText,
    domain: match.voiceDomain,
    mode: voiceMode,
  });
}

function isLocalTimeQuery(text: string): boolean {
  const normalized = normalizeIntentText(text);
  if (!normalized) return false;
  if (/\b(meteo|temps qu il fait|quel temps|temperature|degre|pluie|pleut)\b/u.test(normalized)) return false;
  return /\b(quelle heure|il est quelle heure|donne moi l heure|tu as l heure|heure actuelle|heure est il|heure est-il)\b/u.test(normalized)
    || /^l heure[ ?!]*$/u.test(normalized);
}

function isSalonLightCommand(text: string): boolean {
  const normalized = normalizeIntentText(text);
  return /\b(allume|eteins|active|desactive|ouvre|ferme|mets|met)\b/u.test(normalized)
    && /\b(lumiere|lumieres|lampe|lampes)\b/u.test(normalized)
    && /\b(salon|sejour|living)\b/u.test(normalized);
}

function isDailyRecapRequest(text: string): boolean {
  const normalized = normalizeIntentText(text);
  return /\b(resume|resumes|recap|recapitule|bilan)\b/u.test(normalized)
    && /\b(ma|notre|la|cette|aujourd hui|aujourdhui)\b/u.test(normalized)
    && /\b(journee|jour|aujourd hui|aujourdhui)\b/u.test(normalized);
}

function inferSimpleSpotifyControl(text: string, options: { voiceHub?: boolean } = {}): z.infer<typeof spotifyActionSchema> | null {
  const normalized = normalizeIntentText(text).replace(/[^\p{L}\p{N}\s-]/gu, ' ').replace(/\s+/gu, ' ').trim();
  const hasMusicNoun = /\b(musique|spotify|piste|titre|morceau|chanson|track|lecture)\b/u.test(normalized);
  if (options.voiceHub && /^(la |le |titre |piste |morceau |chanson )?(suivante?|next|skip)$/u.test(normalized)) {
    return 'next';
  }
  if (options.voiceHub && /^(la |le |titre |piste |morceau |chanson )?(precedente?|previous|retour)$/u.test(normalized)) {
    return 'previous';
  }
  if (/\b(piste|titre|morceau|chanson|track)\s+(suivante?|d apres|apres)\b/u.test(normalized)
    || /\b(suivante?|next|skip)\b/u.test(normalized) && hasMusicNoun) {
    return 'next';
  }
  if (/\b(piste|titre|morceau|chanson|track)\s+(precedente?|d avant|avant)\b/u.test(normalized)
    || /\b(precedente?|previous|retour)\b/u.test(normalized) && hasMusicNoun) {
    return 'previous';
  }
  if (/\b(pause|mets en pause|arrete|stop)\b/u.test(normalized) && hasMusicNoun) {
    return 'pause';
  }
  if (/\b(reprends|relance|continue|play|lecture)\b/u.test(normalized) && hasMusicNoun) {
    return 'play';
  }
  return null;
}

function hasRealSalonLight(states: EntityStateLike[]): boolean {
  return states.some((state) => {
    if (!state.entity_id.startsWith('light.')) return false;
    const friendlyName = typeof state.attributes?.friendly_name === 'string' ? state.attributes.friendly_name : '';
    const haystack = normalizeIntentText(`${state.entity_id} ${friendlyName}`);
    if (haystack.includes('led ring') || haystack.includes('home assistant voice') || haystack.includes('hub salon')) return false;
    return /\b(salon|sejour|living)\b/u.test(haystack);
  });
}

function findPreparedContextAnswer(
  answers: Array<{ questionKey: string; answerText: string }>,
  questionKeys: string[],
): { questionKey: string; answerText: string } | null {
  for (const key of questionKeys) {
    const found = answers.find((answer) => answer.questionKey === key && answer.answerText.trim());
    if (found) return found;
  }
  return null;
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
  const resultSetRepository = new ConversationResultSetRepository(db);

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
    llmApiKey: deps.env.OPENAI_API_KEY,
    llmBaseUrl: deps.env.OPENAI_BASE_URL,
    llmModel: deps.env.OPENAI_MODEL_SUMMARY,
    llmTimeoutMs: deps.env.OPENAI_TIMEOUT_MS,
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

  // ─── TTS pre-warm cache (populated by ingest, consumed by /v1/tts) ────────
  const TTS_WARM_TTL_MS = 30_000;
  const INLINE_TTS_WAIT_MS = 350;
  type TtsWarmEntry = { bytes: Buffer; contentType: string; at: number };
  const ttsWarmCache = new Map<string, TtsWarmEntry>();
  const ttsWarmInFlight = new Map<string, Promise<TtsWarmEntry | null>>();

  async function resolveInlineVoiceAudio(text: string): Promise<{
    contentType: string;
    base64Audio: string;
    source: 'inline_warm_cache' | 'inline_warm_inflight';
  } | null> {
    const key = text.trim().slice(0, 512);
    const warmHit = ttsWarmCache.get(key);
    if (warmHit && Date.now() - warmHit.at < TTS_WARM_TTL_MS) {
      return {
        contentType: warmHit.contentType,
        base64Audio: warmHit.bytes.toString('base64'),
        source: 'inline_warm_cache',
      };
    }

    const warmPending = ttsWarmInFlight.get(key);
    if (!warmPending) return null;

    try {
      const entry = await Promise.race([
        warmPending,
        new Promise<null>((resolve) => setTimeout(() => resolve(null), INLINE_TTS_WAIT_MS)),
      ]);
      if (!entry) return null;
      return {
        contentType: entry.contentType,
        base64Audio: entry.bytes.toString('base64'),
        source: 'inline_warm_inflight',
      };
    } catch {
      return null;
    }
  }

  /** Fire-and-forget: generates OpenAI TTS audio for `text` and stores it in
   *  `ttsWarmCache` so the Desktop's subsequent /v1/tts call returns
   *  immediately without another provider round trip. */
  function warmTtsInBackground(text: string): void {
    const key = text.trim().slice(0, 512);
    const existing = ttsWarmCache.get(key);
    if (existing && Date.now() - existing.at < TTS_WARM_TTL_MS) return;
    if (ttsWarmInFlight.has(key)) return;

    const openAiTtsCfg = resolveOpenAiTtsRuntimeConfig(deps.env);
    if (!openAiTtsCfg) return;

    const work = (async (): Promise<TtsWarmEntry | null> => {
      try {
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
    if (/^(oui|ouais|yep|yes|ok|d accord|vas y|c est bon|parfait|allez|go)( merci)?$/u.test(normalized)) return true;
    if (/^(oui|ok|d accord|vas y|c est bon) (je )?confirm(?:e|er|r)?$/u.test(normalized)) return true;
    if (/^(oui|ok|d accord|vas y|c est bon) (je )?confirm(?:e|er|r)?\b/u.test(normalized)) return true;
    if (/^(je )?confirm(?:e|er|r)?\b.*\b(ajoute|cree|valide|execute|lance|supprime|modifie|envoie)\b/u.test(normalized)) return true;
    if (/^(valide|je valide|tu peux|vas y|c est bon|fais le|lance|execute)( l action| la suppression| la modification| l envoi| la tache| l evenement| le rdv| ca)?$/u.test(normalized)) return true;
    if (mutation.agent === 'calendar' && /^(supprime|annule|modifie|retire)( l evenement| le rdv| ca)?$/u.test(normalized)) return true;
    return false;
  };

  const isLikelyMutationConfirmationAttempt = (value: string): boolean => {
    const normalized = normalizeConfirmationText(value);
    return /\b(confirm|confirme|confirmation|valide|oui|ok|vas y|c est bon)\b/u.test(normalized);
  };

  const isClearCalendarRejection = (value: string): boolean => {
    const normalized = normalizeConfirmationText(value);
    return /^(non|nope|nan|annule|annuler|stop|laisse tomber|pas maintenant|ne fais rien|surtout pas)( merci)?$/u.test(normalized);
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

    const rawText = parsed.data.text ?? '';
    const normalizedRawText = normalizeIntentText(rawText);
    const existingCultureResultSet = resultSetRepository.findActive(parsed.data.threadId)?.sourceAgent === 'culture';
    const resultSetFollowup = existingCultureResultSet
      && /\b(premier|premiere|deuxieme|second|seconde|troisieme|lui|celui la|celle la|parmi ceux la|lequel|laquelle)\b/u.test(normalizedRawText);
    const rawCultureRequest = parsed.data.domain === 'culture' || Boolean(inferCultureRequest(rawText)) || resultSetFollowup;
    if ((!deps.env.HA_BASE_URL || !deps.env.HA_TOKEN) && !rawCultureRequest) {
      return reply.code(503).send({ error: 'ha_not_configured' });
    }

    const threadId = parsed.data.threadId.trim();
    const text = toSingleParagraphPlainText(parsed.data.text ?? '');
    const contextNote = toSingleParagraphPlainText(parsed.data.contextNote ?? '');
    const clientContextChannel = normalizeClientChannel(parsed.data.clientContext?.['channel']);
    const headerChannel = normalizeClientChannel(req.headers['x-client-channel']);
    const clientChannel = clientContextChannel ?? headerChannel;
    const supportsInlineVoiceAudio = parsed.data.clientContext?.['supportsInlineVoiceAudio'] === true
      || parsed.data.clientContext?.['supportsInlineVoiceAudio'] === 'true';
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

    const preparedContextMatch = inferPreparedContextMatch(assistantInputText);
    if (preparedContextMatch && deps.contextCache) {
      try {
        let contextResult = await deps.contextCache.get(preparedContextMatch.domain);
        let preparedAnswer = contextResult
          ? findPreparedContextAnswer(contextResult.snapshot.preparedAnswers, preparedContextMatch.questionKeys)
          : null;
        if (!contextResult || !preparedAnswer || contextResult.stale) {
          const refreshedContextResult = await deps.contextCache.get(preparedContextMatch.domain, { force: true });
          const refreshedPreparedAnswer = refreshedContextResult
            ? findPreparedContextAnswer(refreshedContextResult.snapshot.preparedAnswers, preparedContextMatch.questionKeys)
            : null;
          if (refreshedContextResult && refreshedPreparedAnswer) {
            contextResult = refreshedContextResult;
            preparedAnswer = refreshedPreparedAnswer;
          }
        }
        if (contextResult && preparedAnswer) {
          const answerText = prepareContextAnswerForVoice(preparedContextMatch.domain, preparedAnswer.answerText);
          const responseText = voiceEnabled
            ? formatPreparedContextVoiceResponse(preparedContextMatch, answerText, voiceMode)
            : answerText;
          await conversationService.persistMessages(effectiveThreadId, text, responseText);
          await threadRepository.updateResponseTime(effectiveThreadId, Date.now());
          const payload = {
            threadId: effectiveThreadId,
            responseText: toSingleParagraphPlainText(responseText),
            replyMeta: {
              kind: preparedContextMatch.voiceDomain,
              source: 'proactive_context_cache',
              routeKey: `${preparedContextMatch.domain}.${preparedAnswer.questionKey}`,
              semanticDecision: 'not_activated',
              contextCache: {
                hit: true,
                stale: contextResult.stale,
                fetchedAt: contextResult.fetchedAt,
                domain: preparedContextMatch.domain,
                questionKey: preparedAnswer.questionKey,
              },
            },
          };
          const validated = responseSchema.safeParse(payload);
          if (!validated.success) {
            return reply.code(500).send({ error: 'response_validation_failed' });
          }
          app.log.info(
            {
              threadId: effectiveThreadId,
              requestId,
              domain: preparedContextMatch.domain,
              questionKey: preparedAnswer.questionKey,
              elapsed_ms: Date.now() - t0,
            },
            'ingest_prepared_context_cache_hit',
          );
          return reply.code(200).send(validated.data);
        }
      } catch (err) {
        app.log.warn(
          { threadId: effectiveThreadId, requestId, domain: preparedContextMatch.domain, err },
          'ingest_prepared_context_cache_failed',
        );
      }
      const unavailableText = buildPreparedContextUnavailableResponse(preparedContextMatch.domain);
      if (unavailableText) {
        const responseText = voiceEnabled
          ? formatVoiceResponse({
              text: unavailableText,
              domain: preparedContextMatch.voiceDomain,
              mode: voiceMode,
            })
          : unavailableText;
        await conversationService.persistMessages(effectiveThreadId, text, responseText);
        await threadRepository.updateResponseTime(effectiveThreadId, Date.now());
        recordPerf('ingest', Date.now() - t0);
        const payload = {
          threadId: effectiveThreadId,
          responseText: toSingleParagraphPlainText(responseText),
          replyMeta: {
            kind: preparedContextMatch.voiceDomain,
            source: 'proactive_context_cache',
            routeKey: `${preparedContextMatch.domain}.unavailable`,
            semanticDecision: 'not_activated',
            fallbackReason: 'prepared_context_unavailable',
          },
        };
        const validated = responseSchema.safeParse(payload);
        if (!validated.success) {
          return reply.code(500).send({ error: 'response_validation_failed' });
        }
        app.log.info(
          {
            threadId: effectiveThreadId,
            requestId,
            domain: preparedContextMatch.domain,
            elapsed_ms: Date.now() - t0,
          },
          'ingest_prepared_context_unavailable',
        );
        return reply.code(200).send(validated.data);
      }
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

    const inferredCulture = inferCultureRequest(assistantInputText);
    const referencedResult = resultSetRepository.resolveReference(effectiveThreadId, text);
    const activeResultSet = resultSetRepository.findActive(effectiveThreadId);
    const contextualCultureRequest = activeResultSet?.sourceAgent === 'culture'
      && /\b(parmi ceux[- ]la|lequel|laquelle|qu en penses|tu preferes|tu choisirais|compare|pitche)\b/u.test(normalizeIntentText(text));
    if (parsed.data.domain === 'culture' || inferredCulture || referencedResult?.entityType === 'agora.item' || contextualCultureRequest) {
      const parsedCultureAction = cultureActionSchema.safeParse(parsed.data.action);
      const requestedAction = parsed.data.domain === 'culture' && parsedCultureAction.success
        ? parsedCultureAction.data
        : referencedResult
          ? 'get_item'
          : contextualCultureRequest
            ? 'recommend_candidates'
            : inferredCulture?.action ?? 'discover';
      const requestedSlots = {
        ...(inferredCulture?.slots ?? {}),
        ...(parsed.data.slots ?? {}),
        ...(referencedResult ? { itemId: referencedResult.entityId } : {}),
        ...(contextualCultureRequest && activeResultSet ? { resultSetId: activeResultSet.id } : {}),
      };
      try {
        const culture = await executeCulture({
          action: requestedAction,
          slots: requestedSlots,
          text: assistantInputText,
          threadId: effectiveThreadId,
          clientContext: parsed.data.clientContext,
          env: deps.env,
          resultSets: resultSetRepository,
        });
        const responseText = voiceEnabled
          ? formatVoiceResponse({ text: culture.text, domain: 'general', mode: voiceMode })
          : culture.text;
        await conversationService.persistMessages(effectiveThreadId, text || `culture.${requestedAction}`, responseText);
        await threadRepository.updateResponseTime(effectiveThreadId, Date.now());
        return reply.code(200).send({
          threadId: effectiveThreadId,
          responseText: toSingleParagraphPlainText(responseText),
          replyMeta: {
            kind: 'culture',
            source: 'agora',
            routeKey: `culture.${requestedAction}`,
            semanticDecision: referencedResult ? 'deterministic_reference' : 'activated',
          },
        });
      } catch (error) {
        app.log.warn({ threadId: effectiveThreadId, requestId, error }, 'culture_agent_failed');
        if (error instanceof z.ZodError) {
          return reply.code(400).send({ error: 'invalid_culture_contract', issues: error.issues });
        }
        if (error instanceof Error && error.message === 'agora_not_configured') {
          return reply.code(503).send({ error: 'agora_not_configured' });
        }
        if (error instanceof AgoraClientError) {
          if (error.code === 'timeout') return reply.code(504).send({ error: 'agora_timeout' });
          if (error.code === 'unauthorized') return reply.code(502).send({ error: 'agora_unauthorized' });
          if (error.code === 'invalid_response') return reply.code(502).send({ error: 'agora_invalid_response' });
          if (error.code === 'unavailable') return reply.code(503).send({ error: 'agora_unavailable' });
        }
        return reply.code(502).send({ error: 'agora_unavailable' });
      }
    }

    const inferredCulture = inferCultureRequest(assistantInputText);
    const referencedResult = resultSetRepository.resolveReference(effectiveThreadId, text);
    const activeResultSet = resultSetRepository.findActive(effectiveThreadId);
    const contextualCultureRequest = activeResultSet?.sourceAgent === 'culture'
      && /\b(parmi ceux[- ]la|lequel|laquelle|qu en penses|tu preferes|tu choisirais|compare|pitche)\b/u.test(normalizeIntentText(text));
    const referencedCultureResult = referencedResult?.entityType.startsWith('agora.') ? referencedResult : null;
    if (parsed.data.domain === 'culture' || inferredCulture || referencedCultureResult || contextualCultureRequest) {
      const parsedCultureAction = cultureActionSchema.safeParse(parsed.data.action);
      const requestedAction = parsed.data.domain === 'culture' && parsedCultureAction.success
        ? parsedCultureAction.data
        : referencedCultureResult
          ? 'get_item'
          : contextualCultureRequest
            ? 'recommend_candidates'
            : inferredCulture?.action ?? 'discover';
      const requestedSlots = {
        ...(inferredCulture?.slots ?? {}),
        ...(parsed.data.slots ?? {}),
        ...(referencedCultureResult?.entityType === 'agora.item'
          ? { itemId: referencedCultureResult.entityId }
          : {}),
        ...(contextualCultureRequest && activeResultSet ? { resultSetId: activeResultSet.id } : {}),
      };
      try {
        const culture = await executeCulture({
          action: requestedAction,
          slots: requestedSlots,
          text: assistantInputText,
          threadId: effectiveThreadId,
          clientContext: parsed.data.clientContext,
          env: deps.env,
          resultSets: resultSetRepository,
          selectedResult: referencedCultureResult,
        });
        const responseText = voiceEnabled
          ? formatVoiceResponse({ text: culture.text, domain: 'general', mode: voiceMode })
          : culture.text;
        await conversationService.persistMessages(effectiveThreadId, text || `culture.${requestedAction}`, responseText);
        await threadRepository.updateResponseTime(effectiveThreadId, Date.now());
        return reply.code(200).send({
          threadId: effectiveThreadId,
          responseText: toSingleParagraphPlainText(responseText),
          replyMeta: {
            kind: 'culture',
            source: 'agora',
            routeKey: `culture.${requestedAction}`,
            semanticDecision: referencedCultureResult ? 'deterministic_reference' : 'activated',
          },
        });
      } catch (error) {
        app.log.warn({ threadId: effectiveThreadId, requestId, error }, 'culture_agent_failed');
        if (error instanceof z.ZodError) {
          return reply.code(400).send({ error: 'invalid_culture_contract', issues: error.issues });
        }
        if (error instanceof Error && error.message === 'agora_not_configured') {
          return reply.code(503).send({ error: 'agora_not_configured' });
        }
        if (error instanceof AgoraClientError) {
          if (error.code === 'timeout') return reply.code(504).send({ error: 'agora_timeout' });
          if (error.code === 'unauthorized') return reply.code(502).send({ error: 'agora_unauthorized' });
          if (error.code === 'invalid_response') return reply.code(502).send({ error: 'agora_invalid_response' });
          if (error.code === 'unavailable') return reply.code(503).send({ error: 'agora_unavailable' });
        }
        return reply.code(502).send({ error: 'agora_unavailable' });
      }
    }

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

    if (isLocalTimeQuery(assistantInputText)) {
      const localTimeText = `Il est ${formatParisTime()}.`;
      const responseText = voiceEnabled
        ? formatVoiceResponse({ text: localTimeText, domain: 'general', mode: voiceMode })
        : localTimeText;
      await conversationService.persistMessages(effectiveThreadId, text, responseText);
      await threadRepository.updateResponseTime(effectiveThreadId, Date.now());
      recordPerf('ingest', Date.now() - t0);
      app.log.info({ threadId: effectiveThreadId, requestId, elapsed_ms: Date.now() - t0, voice_turn_id: voiceTurnId || undefined }, 'ingest_local_time_fast_path');
      const payload = {
        threadId: effectiveThreadId,
        responseText: toSingleParagraphPlainText(responseText),
        replyMeta: {
          kind: 'time',
          source: 'local_paris_time',
        },
      };
      if (sseStream !== null) { pushSseResponse(payload); return reply; }
      return reply.code(200).send(payload);
    }

    if (deps.ha && isVoiceHubChannel && isLikelyLocalWeatherQuery(assistantInputText)) {
      try {
        const rawStates = await deps.ha.getStates();
        const haStates: HaStateLike[] = Array.isArray(rawStates)
          ? rawStates.filter((item): item is HaStateLike => item !== null && typeof item === 'object' && 'entity_id' in item && typeof (item as { entity_id?: unknown }).entity_id === 'string')
          : [];
        const weather = buildWeatherSnapshotFromStates(haStates);
        if (weather) {
          const deterministicWeatherText = synthesizeDeterministicWeatherReply({
            userText: assistantInputText,
            weather,
            log: app.log,
          });
          if (deterministicWeatherText) {
            const responseText = voiceEnabled
              ? formatVoiceResponse({ text: deterministicWeatherText, domain: 'weather', mode: voiceMode })
              : deterministicWeatherText;
            await conversationService.persistMessages(effectiveThreadId, text, responseText);
            await threadRepository.updateResponseTime(effectiveThreadId, Date.now());
            recordPerf('ingest', Date.now() - t0);
            app.log.info({ threadId: effectiveThreadId, requestId, elapsed_ms: Date.now() - t0 }, 'ingest_local_weather_fast_path');
            const payload = {
              threadId: effectiveThreadId,
              responseText: toSingleParagraphPlainText(responseText),
              replyMeta: {
                kind: 'weather',
                source: 'local_weather_snapshot',
              },
            };
            if (sseStream !== null) { pushSseResponse(payload); return reply; }
            return reply.code(200).send(payload);
          }
        }
      } catch (err) {
        app.log.warn({ threadId: effectiveThreadId, requestId, err }, 'ingest_local_weather_fast_path_failed');
      }
    }

    if (deps.ha && isVoiceHubChannel && isSalonLightCommand(assistantInputText)) {
      try {
        const states = toEntityStates(await deps.ha.getStates());
        if (!hasRealSalonLight(states)) {
          const responseText = 'Je ne trouve pas de lumière du salon exposée dans Home Assistant.';
          await conversationService.persistMessages(effectiveThreadId, text, responseText);
          await threadRepository.updateResponseTime(effectiveThreadId, Date.now());
          recordPerf('ingest', Date.now() - t0);
          app.log.info({ threadId: effectiveThreadId, requestId, elapsed_ms: Date.now() - t0 }, 'ingest_salon_light_missing_fast_path');
          const payload = {
            threadId: effectiveThreadId,
            responseText,
            replyMeta: {
              kind: 'executor',
              source: 'ha_entity_index',
              fallbackReason: 'missing_salon_light',
            },
          };
          if (sseStream !== null) { pushSseResponse(payload); return reply; }
          return reply.code(200).send(payload);
        }
      } catch (err) {
        app.log.warn({ threadId: effectiveThreadId, requestId, err }, 'ingest_salon_light_missing_fast_path_failed');
      }
    }

    if (isVoiceHubChannel && isDailyRecapRequest(assistantInputText)) {
      const responseText = 'Je n’ai pas encore de journal fiable de ta journée. Je peux te résumer l’agenda, les tâches ou les mails si tu me précises quoi regarder.';
      await conversationService.persistMessages(effectiveThreadId, text, responseText);
      await threadRepository.updateResponseTime(effectiveThreadId, Date.now());
      recordPerf('ingest', Date.now() - t0);
      app.log.info({ threadId: effectiveThreadId, requestId, elapsed_ms: Date.now() - t0 }, 'ingest_daily_recap_fast_path');
      const payload = {
        threadId: effectiveThreadId,
        responseText: toSingleParagraphPlainText(responseText),
        replyMeta: {
          kind: 'general',
          source: 'voice_hub_fast_path',
          fallbackReason: 'missing_daily_journal',
        },
      };
      if (sseStream !== null) { pushSseResponse(payload); return reply; }
      return reply.code(200).send(payload);
    }

    const simpleSpotifyAction = inferSimpleSpotifyControl(assistantInputText, { voiceHub: isVoiceHubChannel });
    if (simpleSpotifyAction && deps.spotifyWebApi.isConfigured()) {
      const spotifyPayload = ingestSpotifyRequestSchema.parse({
        threadId: effectiveThreadId,
        domain: 'spotify',
        action: simpleSpotifyAction,
        slots: {},
        context: {},
        text,
        correlation_id: correlationId || undefined,
        user_id: typeof parsed.data.user_id === 'string' ? parsed.data.user_id.trim() || undefined : undefined,
      });
      const spotifyResp = await executeSpotifyCapability({
        request: spotifyPayload,
        spotifyWebApi: deps.spotifyWebApi,
        env: deps.env,
        log: app.log,
      });
      const responseText = voiceEnabled
        ? formatVoiceResponse({ text: spotifyResp.tts, domain: 'spotify', mode: voiceMode })
        : spotifyResp.tts;
      await conversationService.persistMessages(effectiveThreadId, text, responseText);
      await threadRepository.updateResponseTime(effectiveThreadId, Date.now());
      recordPerf('ingest', Date.now() - t0);
      app.log.info(
        { threadId: effectiveThreadId, requestId, action: simpleSpotifyAction, status: spotifyResp.status, elapsed_ms: Date.now() - t0 },
        'ingest_spotify_simple_control_fast_path',
      );
      const payload = buildSpotifyIngestPayload({
        threadId: effectiveThreadId,
        responseText,
        spotify: {
          status: spotifyResp.status,
          ...(spotifyResp.data ? { data: spotifyResp.data } : {}),
          ...(spotifyResp.options ? { options: spotifyResp.options } : {}),
          ...(spotifyResp.error_code ? { error_code: spotifyResp.error_code } : {}),
        },
        action: simpleSpotifyAction,
        routingPath: 'router_direct',
        correlationId: correlationId || undefined,
      });
      if (sseStream !== null) { pushSseResponse(payload); return reply; }
      return reply.code(200).send(payload);
    }

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
      ? { agentId: 'weather', routerId: LOCAL_WEATHER_ROUTER_AGENT_ID, hint: 'Meteo locale Home Assistant: etat actuel, temperature, humidite, precipitation, previsions courtes. Jamais une ville externe.', key: 'weather' }
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

    const directConversationReply = simpleConversationalReply(assistantInputText);
    if (directConversationReply) {
      assistantText = directConversationReply;
      app.log.info({ threadId, requestId }, 'ingest_simple_conversation_fast_path');
    }

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
              timeoutMs: deps.env.LLM_PROVIDER === 'hybrid' ? deps.env.LLM_LOCAL_ROUTER_TIMEOUT_MS : deps.env.ROUTER_TIMEOUT_MS,
              confidenceThreshold: threshold,
              generalAgentId,
              provider: deps.env.LLM_PROVIDER === 'openai' ? 'openai' : 'ollama',
              ...(deps.env.LLM_PROVIDER === 'hybrid' && deps.env.LLM_FALLBACK_OPENAI_API_KEY && deps.env.LLM_FALLBACK_OPENAI_BASE_URL && deps.env.LLM_FALLBACK_OPENAI_MODEL_ROUTER ? {
                fallback: {
                  openAiApiKey: deps.env.LLM_FALLBACK_OPENAI_API_KEY,
                  openAiBaseUrl: deps.env.LLM_FALLBACK_OPENAI_BASE_URL,
                  model: deps.env.LLM_FALLBACK_OPENAI_MODEL_ROUTER,
                  timeoutMs: deps.env.LLM_FALLBACK_OPENAI_TIMEOUT_MS,
                },
              } : {}),
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

    // ── General local fallback ────────────────────────────────────────────────
    // General discussion is not a home-automation task. Keep it on the local
    // Ollama runtime so a missing/unauthorized HA conversation agent can never
    // turn a greeting into an operational error.
    if (assistantText === undefined) {
      try {
        const t0 = Date.now();
        assistantText = await answerGeneralConversationWithOllama({
          text: applyFrenchVoiceHubGuard(assistantInputText, clientChannel),
          baseUrl: deps.env.OLLAMA_BASE_URL,
          model: deps.env.OLLAMA_MODEL ?? deps.env.OPENAI_MODEL_ROUTER,
          timeoutMs: deps.env.ROUTER_TIMEOUT_MS,
        });
        app.log.info({ threadId, requestId, elapsed_ms: Date.now() - t0 }, 'ingest_ollama_general_done');
        responseDomain = 'general';
      } catch (err) {
        app.log.warn({ threadId, requestId, correlation_id: correlationId || undefined, err }, 'ingest_ollama_general_failed');
        assistantText = 'Je suis là. Que puis-je faire pour toi ?';
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
    const hasDedicatedTtsRuntime = typeof deps.env.OPENAI_TTS_BASE_URL === 'string'
      && deps.env.OPENAI_TTS_BASE_URL.trim().length > 0;
    const shouldPrepareTts = voiceEnabled || (hasDedicatedTtsRuntime && Boolean(clientChannel?.startsWith('desktop')));
    const shouldInlineVoiceAudio = hasDedicatedTtsRuntime
      && (supportsInlineVoiceAudio || Boolean(clientChannel?.startsWith('desktop')));

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

    // Pre-warm TTS in background so voice clients can display text immediately
    // while a subsequent /v1/tts call can hit warm cache/in-flight audio.
    if (shouldPrepareTts) {
      warmTtsInBackground(toSingleParagraphPlainText(assistantTextVoice));
    }

    const activeProposalForResponse = await pendingMutationRepository.findActiveByThread(effectiveThreadId) as PendingMutation | null;
    const voiceAudio = shouldInlineVoiceAudio
      ? await resolveInlineVoiceAudio(toSingleParagraphPlainText(assistantTextVoice))
      : null;

    const payload = {
      threadId: effectiveThreadId,
      responseText: toSingleParagraphPlainText(assistantTextVoice),
      ...(usedSummaryVersion ? { usedSummaryVersion } : {}),
      ...(searchSources.length > 0 ? { sources: searchSources } : {}),
      ...(voiceAudio ? { voiceAudio } : {}),
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
        ...(routerResult.status === 'fulfilled' ? {
          llmProvider: routerResult.value.provider,
          llmModel: routerResult.value.model,
          llmLatencyMs: routerResult.value.latencyMs,
          ...(routerResult.value.fallbackReason ? { llmFallbackReason: routerResult.value.fallbackReason } : {}),
        } : {}),
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
    const t0 = Date.now();
    const voiceTurnId = typeof req.headers['x-voice-turn-id'] === 'string' ? req.headers['x-voice-turn-id'].trim() : '';

    // Desktop and APK call Jarvis directly. Home Assistant is intentionally not
    // part of the STT path: Jarvis streams PCM directly to local Whisper.
    const tryLocalStt = async (): Promise<{ text: string; engineId: string } | null> => {
      try {
        const text = toSingleParagraphPlainText(await transcribeWithWyoming(body, {
          host: deps.env.LOCAL_STT_HOST,
          port: deps.env.LOCAL_STT_PORT,
          timeoutMs: deps.env.LOCAL_STT_TIMEOUT_MS,
          language: deps.env.OPENAI_STT_LANGUAGE,
        }));
        return text ? { text, engineId: 'local:wyoming-whisper' } : null;
      } catch {
        return null;
      }
    };

    if (deps.env.STT_LOCAL_FIRST) {
      const localResult = await tryLocalStt();
      if (localResult) {
        recordPerf('stt', Date.now() - t0);
        app.log.info({ engineId: localResult.engineId, elapsed_ms: Date.now() - t0, voice_turn_id: voiceTurnId || undefined, local_first: true }, 'stt_complete');
        return reply.code(200).send({ text: localResult.text, result: localResult.text, engineId: localResult.engineId });
      }
      if (!deps.env.STT_REMOTE_FALLBACK_ENABLED) {
        app.log.warn({ voice_turn_id: voiceTurnId || undefined }, 'stt_local_unavailable_remote_fallback_disabled');
        return reply.code(503).send({ error: 'stt_not_available', hint: 'Le STT local est indisponible.' });
      }
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
      if (err instanceof Error && err.message === 'openai_stt_empty_transcript') {
        app.log.info({ engineId: 'openai', voice_turn_id: voiceTurnId || undefined }, 'stt_openai_empty_silence_skip');
        return reply.code(422).send({ error: 'stt_empty_transcript', engineId: 'openai' });
      }
      app.log.warn({ err }, 'stt_openai_failed');
      return reply.code(503).send({ error: 'stt_not_available', hint: 'Le STT local et le secours OpenAI sont indisponibles.' });
    }
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

    const mode = defaultMode === 'ha'
      ? 'ha'
      : defaultMode === 'openai'
        ? 'openai'
        : (parsed.data.provider === 'ha' ? 'ha' : (parsed.data.provider === 'openai' ? 'openai' : 'auto'));
    const openAiTtsCfg = resolveOpenAiTtsRuntimeConfig(deps.env);
    if (mode === 'ha') {
      return reply.code(410).send({ error: 'ha_tts_disabled', provider: 'openai_only' });
    }

    if (!openAiTtsCfg) {
      return reply.code(503).send({ error: 'tts_not_configured', provider: mode });
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
    type TtsWin = { bytes: Buffer; contentType: string; engineId: string; via: string };

    // OpenAI-only TTS coroutine
    const doOpenAiTts = async (): Promise<TtsWin> => {
      if (!openAiTtsCfg) throw new Error('openai_tts_not_configured');
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), openAiTtsCfg.timeoutMs);
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
    let winner: TtsWin;
    try {
      winner = await doOpenAiTts();
    } catch (err) {
      app.log.warn({ err, voice_turn_id: voiceTurnId || undefined }, 'tts_openai_failed');
      return reply.code(502).send({ error: 'tts_openai_failed' });
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
    return reply.code(200).send({ latency_ms: stats, tts_circuit_breaker: {} });
  });

}
