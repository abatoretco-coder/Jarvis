import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { Readable } from 'node:stream';

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { ConversationService } from '../conversation/ConversationService';
import { detectEffectiveThreadId } from '../conversation/conversationWindow';
import { enrichWithContextNote } from '../conversation/contextNote';
import {
  routeUserRequest,
  parseAgentMap,
  SPOTIFY_AGENT_ID,
  synthesizeAgentResponses,
  type RouterResult,
  type RouterTarget,
} from '../conversation/orchestratorRouter';
import { toSingleParagraphPlainText } from '../conversation/plainText';
import { getSearchAgentConfig, isSearchAgentKey } from '../search/agents';
import { synthesizeDeterministicWeatherReply } from '../weather/deterministicWeatherReply';
import { buildWeatherSystemPrompt } from '../weather/prompts/weatherSystemPrompt';
import { buildWeatherUserPrompt } from '../weather/prompts/weatherUserTemplate';
import { buildWeatherSnapshotFromStates, type WeatherSnapshot } from '../weather/weatherSnapshot';
import { callTodoAgent, isTodoAgentKey } from '../todo/todoAgent';
import { buildMailAccounts, callMailAgent, isMailAgentKey } from '../mail/mailAgent';
import {
  createConversationDb,
  SqliteMessageRepository,
  SqliteThreadRepository,
} from '../conversation/repositories/SqliteRepositories';
import { SummarizationService } from '../conversation/SummarizationService';
import type { AppDeps } from '../server';
import { ingestSpotifyRequestSchema, spotifyActionSchema } from '../spotify/contracts';
import { planSpotifyActionFromTextWithOpenAi } from '../spotify/musicAgentPlanner';
import { executeSpotifyCapability } from '../spotify/spotifyExecutor';
import { dispatchAcceptedE1Route } from '../routing/e1RouteDispatcher';
import { trySemanticRouter } from '../routing/semanticRouter';
import type { EmbeddingClientConfig, SemanticRouterInput } from '../routing/semanticRouter.types';
import { dispatchAcceptedSearchE2Route } from '../routing/routeDispatcher';

const ingestSchema = z.object({
  threadId: z.string().min(1),
  text: z.string().optional(),
  contextNote: z.string().optional(),
  clientContext: z.record(z.unknown()).optional(),
  domain: z.string().optional(),
  action: z.string().optional(),
  slots: z.record(z.unknown()).optional(),
  context: z.record(z.unknown()).optional(),
  understanding: z.record(z.unknown()).optional(),
  response_contract: z.record(z.unknown()).optional(),
  correlation_id: z.string().optional(),
  user_id: z.string().optional(),
});

const responseSchema = z.object({
  threadId: z.string().min(1),
  responseText: z.string().min(1),
  usedSummaryVersion: z.string().min(1).optional(),
});

const historyQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(500).optional(),
});

const sttParamsSchema = z.object({
  engineId: z.string().min(1),
});

const ttsRequestSchema = z.object({
  text: z.string().min(1),
  language: z.string().min(1).optional(),
});

type EntityStateLike = {
  entity_id: string;
  attributes?: Record<string, unknown>;
};

type AudioTransformOpts = { speed: number; pitchSemitones: number; clarity: boolean };

// Build ffmpeg audio filter chain (speed is optional — OpenAI handles it natively)
function buildFfmpegFilters(opts: AudioTransformOpts, skipSpeed = false): string[] {
  const filters: string[] = [];
  if (opts.pitchSemitones !== 0) {
    const ratio = Math.pow(2, opts.pitchSemitones / 12);
    // asetrate expects a plain integer — precompute to avoid expression-parse failure
    const shiftedRate = Math.round(44100 * ratio);
    // asetrate shifts pitch+tempo; aresample restores sample rate; atempo corrects speed back
    filters.push(
      `asetrate=${shiftedRate}`,
      'aresample=44100',
      `atempo=${Math.max(0.5, Math.min(2.0, 1 / ratio)).toFixed(6)}`,
    );
  }
  if (!skipSpeed && opts.speed !== 1.0) {
    filters.push(`atempo=${Math.max(0.5, Math.min(2.0, opts.speed)).toFixed(6)}`);
  }
  if (opts.clarity) {
    filters.push('highpass=f=100', 'equalizer=f=3000:width_type=o:width=2:g=2');
  }
  return filters;
}

// Stream HTTP response body directly through ffmpeg (transform runs while bytes arrive — no buffer-then-transform)
function pipeStreamThroughFfmpeg(body: ReadableStream<Uint8Array>, filters: string[]): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const proc = spawn('ffmpeg', [
      '-f', 'mp3', '-i', 'pipe:0',
      '-filter:a', filters.join(','),
      '-f', 'mp3', 'pipe:1',
      '-loglevel', 'error',
    ]);
    const chunks: Buffer[] = [];
    let stderr = '';
    proc.stdout.on('data', (d: Buffer) => chunks.push(d));
    proc.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
    proc.on('close', (code) => {
      if (code === 0) resolve(Buffer.concat(chunks));
      else reject(new Error(`ffmpeg exit ${code}: ${stderr.slice(0, 200)}`));
    });
    proc.on('error', reject);
    const reader = body.getReader();
    const pump = (): void => {
      reader.read().then(({ done, value }) => {
        if (done) { proc.stdin.end(); return; }
        const ok = proc.stdin.write(value);
        if (ok) pump();
        else proc.stdin.once('drain', pump);
      }).catch((err: unknown) => { proc.stdin.destroy(err as Error); reject(err); });
    };
    pump();
  });
}

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

function normalizeClientChannel(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toLowerCase().replace(/\s+/g, '-');
  if (!normalized) return undefined;
  if (!/^[a-z0-9._-]{2,64}$/.test(normalized)) return undefined;
  return normalized;
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
): Promise<string> {
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
  // Strip Perplexity citation markers [1], [2][3], bold markers **, and leftover markdown
  const content = raw
    ?.replace(/\[\d+\]/g, '')       // [1] [2] [3]
    ?.replace(/\*\*(.+?)\*\*/g, '$1') // **bold** → bold
    ?.replace(/\*(.+?)\*/g, '$1')    // *italic* → italic
    ?.replace(/\s{2,}/g, ' ')        // multiple spaces
    ?.trim();
  params.log?.info({ provider: usePerplexity ? 'perplexity' : 'openai', model, agentKey, content_len: content?.length ?? 0, content_preview: content?.slice(0, 120) }, 'search_agent_raw_response');
  return content || "Je n'ai pas obtenu cette information.";
}


function isElevenLabsEngine(engineId: string): boolean {
  return /elevenlabs/i.test(engineId);
}

function shouldFallbackFromElevenLabs(status: number, bodyText: string): boolean {
  if (status === 429 || status >= 500) return true;
  return /(quota|capacity|limit|credit|insufficient|exceed|plan)/i.test(bodyText);
}

function audioExtensionFromContentType(contentType: string): string {
  if (/wav/u.test(contentType)) return 'wav';
  if (/ogg|opus/u.test(contentType)) return 'ogg';
  if (/flac/u.test(contentType)) return 'flac';
  if (/aac|m4a|mp4/u.test(contentType)) return 'm4a';
  if (/mpeg|mp3/u.test(contentType)) return 'mp3';
  return 'wav';
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
  form.set('file', new Blob([params.body], { type: params.incomingContentType }), `audio.${fileExt}`);

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

  let parsed: unknown = {};
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
  const ks = keys.map((k) => k ?? '');
  const hasMail   = ks.some((k) => k === 'mail'  || k.startsWith('mail.'));
  const hasTodo   = ks.some((k) => k === 'todo'  || k.startsWith('todo.'));
  const hasSearch = ks.some((k) => k.startsWith('search'));
  const hasWeather = ks.some((k) => k === 'weather' || k.startsWith('weather.'));
  if (hasMail  && !hasTodo && !hasSearch) return 'Deux secondes, je consulte tes emails.';
  if (hasTodo  && !hasMail && !hasSearch) return 'Deux secondes, je regarde tes taches.';
  if (hasWeather && !hasMail && !hasTodo && !hasSearch) return 'Je regarde la meteo, une seconde.';
  if (hasSearch && !hasMail && !hasTodo && ks.length === 1) return 'Je cherche ca, une seconde.';
  return 'Deux secondes, je traite ta demande.';
}

export function registerIngestRoute(app: FastifyInstance, deps: AppDeps): void {
  app.addContentTypeParser(/^audio\/.+$/u, { parseAs: 'buffer' }, (_req, body, done) => {
    done(null, body);
  });

  app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer' }, (_req, body, done) => {
    done(null, body);
  });

  const db = createConversationDb(deps.env.CONVERSATION_DB_PATH);
  const threadRepository = new SqliteThreadRepository(db);
  const messageRepository = new SqliteMessageRepository(db);

  // ─── Retention cleanup: purge threads inactive for more than 7 days ───────
  const RETENTION_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
  const CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000; // run once per day
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
  });

  let ttsProviderCache: { providers: Set<string>; at: number } | null = null;
  let ttsProviderRefreshPromise: Promise<void> | null = null;
  const TTS_PROVIDER_CACHE_TTL_MS = 15 * 60_000;

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
  const CB_THRESHOLD = 3;
  const CB_OPEN_MS = 45_000;

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

  // ─── Per-endpoint perf samples (rolling window 200) ──────────────────────
  const PERF_MAX = 200;
  const perfSamples = new Map<string, number[]>();

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
    const assistantInputText = toSingleParagraphPlainText(enrichWithContextNote(text, contextNote));
    const requestId = randomUUID();
    const t0 = Date.now();
    const voiceTurnId = typeof req.headers['x-voice-turn-id'] === 'string' ? req.headers['x-voice-turn-id'].trim() : '';
    const correlationId = typeof parsed.data.correlation_id === 'string' ? parsed.data.correlation_id.trim() : '';

    // Vérifier si une fenêtre de conversation active existe (10s post-réponse)
    // Si oui, réutiliser le threadId actif pour maintenir le contexte
    const activeThread = await threadRepository.getActiveConversationThread(clientChannel ?? undefined);
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

    const toDeterministicHaFailureMessage = (): string => (
      'Je n’ai pas pu joindre l’agent Home Assistant pour cette requête. Réessaie dans quelques secondes ou formule une commande musique explicite (ex: « mets de la musique sur Spotify »).'
    );

    // Guardrail: explicit spotify contract always has priority.
    if (parsed.data.domain === 'spotify' && parsed.data.action) {
      const spotifyPayload = ingestSpotifyRequestSchema.safeParse({
        ...parsed.data,
        threadId: effectiveThreadId,
      });

      if (!spotifyPayload.success) {
        return reply.code(400).send({ error: 'invalid_spotify_payload', issues: spotifyPayload.error.issues });
      }

      const spotifyResponse = await executeSpotifyCapability({
        request: spotifyPayload.data,
        spotifyWebApi: deps.spotifyWebApi,
        env: deps.env,
        log: app.log,
      });

      const persistedInput = text || `spotify:${spotifyPayload.data.action} ${JSON.stringify(spotifyPayload.data.slots ?? {})}`;
      await conversationService.persistMessages(effectiveThreadId, persistedInput, spotifyResponse.tts);

      app.log.info(
        {
          threadId,
          domain: 'spotify',
          action: spotifyPayload.data.action,
          status: spotifyResponse.status,
          correlation_id: correlationId || undefined,
          user_id: spotifyPayload.data.user_id,
        },
        'ingest_spotify_capability_done'
      );

      await threadRepository.updateResponseTime(effectiveThreadId, Date.now());

      return reply.code(200).send({
        threadId: effectiveThreadId,
        responseText: spotifyResponse.tts,
        status: spotifyResponse.status,
        ...(spotifyResponse.data ? { data: spotifyResponse.data } : {}),
        ...(spotifyResponse.options ? { options: spotifyResponse.options } : {}),
        ...(spotifyResponse.error_code ? { error_code: spotifyResponse.error_code } : {}),
        ...(correlationId ? { correlation_id: correlationId } : {}),
      });
    }

    if (!text) {
      return reply.code(400).send({ error: 'invalid_body', message: 'text is required when domain/action is not provided' });
    }

    app.log.info(
      {
        threadId,
        requestId,
        text_len: text.length,
        client_channel: clientChannel,
        voice_turn_id: voiceTurnId || undefined,
        correlation_id: correlationId || undefined,
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
    const pushSseAck      = (text: string): void => { sseStream?.push(`event: ack\ndata: ${JSON.stringify({ text })}\n\n`); };
    const pushSseResponse = (data: unknown): void => { sseStream?.push(`event: response\ndata: ${JSON.stringify(data)}\n\n`); sseStream?.push(null); };

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
    const allAgentEntries = [...(spotifyEntry ? [spotifyEntry] : []), ...(weatherEntry ? [weatherEntry] : []), ...agentEntries];
    const routerEnabled = allAgentEntries.length > 0 && Boolean(deps.env.OPENAI_API_KEY);
    const threshold = deps.env.ROUTER_CONFIDENCE_THRESHOLD;

    const recentMessages = routerEnabled ? recentMessages_ : [];

    const generalAgentId = deps.env.HA_AGENT_GENERAL;
    let assistantText: string | undefined;

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
      const embeddingCfg: EmbeddingClientConfig = {
        baseUrl: deps.env.OPENAI_BASE_URL,
        model: deps.env.SEMANTIC_ROUTER_EMBEDDING_MODEL,
        timeoutMs: deps.env.SEMANTIC_ROUTER_TIMEOUT_MS,
        apiKey: deps.env.OPENAI_API_KEY,
      };
      const semanticInput: SemanticRouterInput = {
        userText: text,
        embeddingConfig: embeddingCfg,
        options: {
          acceptScore: deps.env.SEMANTIC_ROUTER_ACCEPT_SCORE,
          minMargin: deps.env.SEMANTIC_ROUTER_MIN_MARGIN,
          enableE2: true,
          enableE1: true,
          enableD0: true,
        },
        enabledLevels: ['D0', 'E2', 'E1'],
        context: { threadId, requestId },
      };

      app.log.info({ threadId, requestId, text_len: text.length }, 'semantic_router_start');
      if (semanticLiveModeEnabled) {
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

            const routeKey = semResult.matchedRoute.key;
            if (!semanticE1ActivationEnabled) {
              app.log.info({ threadId, requestId, routeKey }, 'semantic_router_e1_activation_fallback_not_allowlisted');
            } else if (!semanticActivatedE1RouteKeys.has(routeKey)) {
              app.log.info({ threadId, requestId, routeKey }, 'semantic_router_e1_activation_fallback_not_allowlisted');
            } else {
              const targetAgentId = semResult.matchedRoute.targetAgentId;
              const isSearchDeep = targetAgentId === 'search' && routeKey.startsWith('search.deep.');
              const isSpotifyE1 = targetAgentId === SPOTIFY_AGENT_ID && routeKey.startsWith('spotify.');
              if (!isSearchDeep && !isSpotifyE1) {
                app.log.info(
                  { threadId, requestId, routeKey, targetAgentId },
                  'semantic_router_e1_activation_fallback_unsupported_target',
                );
              } else {
                const tE1 = Date.now();
                app.log.info(
                  {
                    threadId,
                    requestId,
                    route: routeKey,
                    decision: semResult.decision,
                    targetAgentId,
                    handled: false,
                  },
                  'semantic_router_e1_live_attempt',
                );

                if (isSearchDeep && sseStream !== null) {
                  const ackMsg = getIngestAckText([routeKey]);
                  if (ackMsg) pushSseAck(ackMsg);
                }

                try {
                  const e1Result = await dispatchAcceptedE1Route({
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
                        throw new Error('e1_todo_live_not_enabled_in_phase_2a');
                      },
                      callMailAgent: async () => {
                        throw new Error('e1_mail_live_not_enabled_in_phase_2a');
                      },
                    },
                  });

                  if (!e1Result) {
                    app.log.info(
                      {
                        threadId,
                        requestId,
                        route: routeKey,
                        decision: semResult.decision,
                        targetAgentId,
                        handled: false,
                        elapsed_ms: Date.now() - tE1,
                      },
                      'semantic_router_e1_live_fallback_llm',
                    );
                  } else if (e1Result.kind === 'search_text') {
                    assistantText = e1Result.data;
                    semanticActivatedRouteKey = e1Result.routeKey;
                    app.log.info(
                      {
                        threadId,
                        requestId,
                        route: e1Result.routeKey,
                        decision: semResult.decision,
                        targetAgentId,
                        handled: true,
                        elapsed_ms: Date.now() - tE1,
                      },
                      'semantic_router_e1_live_handled',
                    );
                  } else if (e1Result.kind === 'spotify_plan') {
                    const maybePlan = e1Result.data as MusicAgentPlan;
                    if (maybePlan.route !== 'spotify' || !maybePlan.request) {
                      app.log.info(
                        {
                          threadId,
                          requestId,
                          route: e1Result.routeKey,
                          decision: semResult.decision,
                          targetAgentId,
                          handled: false,
                          elapsed_ms: Date.now() - tE1,
                        },
                        'semantic_router_e1_live_fallback_llm',
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
                          decision: semResult.decision,
                          targetAgentId,
                          planner: 'spotify_music_agent',
                          handled: true,
                          elapsed_ms: Date.now() - tE1,
                        },
                        'semantic_router_e1_live_handled',
                      );
                    }
                  } else {
                    app.log.info(
                      {
                        threadId,
                        requestId,
                        route: routeKey,
                        decision: semResult.decision,
                        targetAgentId,
                        handled: false,
                        elapsed_ms: Date.now() - tE1,
                      },
                      'semantic_router_e1_live_fallback_llm',
                    );
                  }
                } catch (err) {
                  app.log.warn(
                    {
                      threadId,
                      requestId,
                      route: routeKey,
                      decision: semResult.decision,
                      targetAgentId,
                      elapsed_ms: Date.now() - tE1,
                      err,
                    },
                    'semantic_router_e1_live_error',
                  );
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
      app.log.warn({ threadId, requestId, err: routerResult.reason }, 'ha_agent_router_failed_fallback_general');
    }

    // ── Resolve targets ───────────────────────────────────────────────────────

    if (routerResult.status === 'fulfilled') {
      const validTargets = routerResult.value.targets.filter((t) => t.confidence >= threshold);
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
          | { kind: 'spotify_tts'; tts: string; musicPlanRoute: string; musicPlanReason?: string; spotifyPayload: object }
          | { kind: 'ha_text'; agentId: string; text: string };

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
          const isSearchAgent = isSearchAgentKey(agentEntry?.key);
          const isTodoAgent   = isTodoAgentKey(agentEntry?.key);
          const isMailAgent   = isMailAgentKey(agentEntry?.key);
          const isWeatherAgent = agentEntry?.key === 'weather';

          if (isSearchAgent) {
            // Search agents: dispatch to appropriate Perplexity/OpenAI strategy — bypass HA entirely.
            const searchAgentKey = agentEntry!.key ?? 'search';
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
                .then((txt): SpecializedResult | null => {
                  app.log.info({ threadId, requestId, agent: haTarget.agentId }, 'search_agent_direct_done');
                  return { kind: 'ha_text', agentId: haTarget.agentId, text: txt };
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
                .callHomeAssistantConversation(assistantInputText, effectiveThreadId, undefined, haTarget.agentId)
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

        if (goodResults.length > 0) {
          const spotifyRes = goodResults.find(
            (r): r is Extract<SpecializedResult, { kind: 'spotify_tts' }> => r.kind === 'spotify_tts',
          );

          // Single Spotify-only result → preserve full Spotify response shape (with planner metadata)
          if (spotifyRes && goodResults.length === 1) {
            void conversationService.persistMessages(effectiveThreadId, text, spotifyRes.tts).then(async () => {
              if (await summarizationService.shouldPresummarize(effectiveThreadId)) {
                summarizationService.startPresummarize(effectiveThreadId);
              }
            });
            const spotifyOnlyPayload = {
              threadId: effectiveThreadId,
              responseText: spotifyRes.tts,
              ...spotifyRes.spotifyPayload,
              ...(correlationId ? { correlation_id: correlationId } : {}),
              planner: { source: 'openai_music_agent', route: spotifyRes.musicPlanRoute, reason: spotifyRes.musicPlanReason },
            };
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
          }
        }
        // All tasks failed/OUT_OF_SCOPE → assistantText stays undefined → HA general fallback
      }
      // No valid targets above threshold → HA general fallback
    }

    // ── General HA fallback (only when router failed or produced no usable result) ─
    if (assistantText === undefined) {
      try {
        app.log.info({ threadId, requestId, agent: generalAgentId }, 'ingest_ha_general_fallback');
        const haText = await conversationService.callHomeAssistantConversation(assistantInputText, effectiveThreadId, undefined, generalAgentId);
        if (/^\s*OUT_OF_SCOPE\s*$/i.test(haText)) {
          app.log.warn({ threadId, requestId, agent: generalAgentId }, 'ingest_ha_general_out_of_scope');
          assistantText = toDeterministicHaFailureMessage();
        } else {
          assistantText = haText;
        }
      } catch (err) {
        app.log.warn(
          { threadId, requestId, correlation_id: correlationId || undefined, err },
          'ingest_home_assistant_call_failed'
        );
        assistantText = toDeterministicHaFailureMessage();
      }
    }

    void conversationService.persistMessages(effectiveThreadId, text, assistantText).then(async () => {
      if (await summarizationService.shouldPresummarize(effectiveThreadId)) {
        summarizationService.startPresummarize(effectiveThreadId);
      }
    });

    const payload = {
      threadId: effectiveThreadId,
      responseText: toSingleParagraphPlainText(assistantText),
      ...(usedSummaryVersion ? { usedSummaryVersion } : {}),
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
          body,
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
        body,
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
    let parsed: unknown = raw;
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

  app.post('/v1/tts', async (req, reply) => {
    const parsed = ttsRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_body', issues: parsed.error.issues });
    }

    if (!deps.env.HA_BASE_URL || !deps.env.HA_TOKEN) {
      return reply.code(503).send({ error: 'ha_not_configured' });
    }

    const text = toSingleParagraphPlainText(parsed.data.text);
    const t0 = Date.now();
    const voiceTurnId = typeof req.headers['x-voice-turn-id'] === 'string' ? req.headers['x-voice-turn-id'].trim() : '';
    const configuredEntity = deps.env.HA_TTS_ENTITY_ID?.trim();
    const primaryEngineId = configuredEntity && configuredEntity.length > 0
      ? configuredEntity
      : 'tts.elevenlabs_text_to_speech';
    const fallbackFromEnv = (deps.env.HA_TTS_FALLBACK_ENTITY_IDS ?? '')
      .split(',')
      .map((value) => value.trim())
      .filter((value) => value.length > 0);
    let candidateEngineIds = uniqueNonEmpty([primaryEngineId, ...fallbackFromEnv]);
    const haBaseUrl = deps.env.HA_BASE_URL.replace(/\/$/, '');

    if (deps.ha) {
      const nowMs = Date.now();
      const hasFreshProviderCache = Boolean(ttsProviderCache) && nowMs - ttsProviderCache!.at <= TTS_PROVIDER_CACHE_TTL_MS;

      if (hasFreshProviderCache) {
        const availableCandidates = candidateEngineIds.filter((engineId) => ttsProviderCache!.providers.has(engineId));
        if (availableCandidates.length > 0) {
          candidateEngineIds = availableCandidates;
        }
      } else {
        void refreshTtsProviderCache();
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
      const openAiApiKey = deps.env.OPENAI_API_KEY?.trim();
      if (!openAiApiKey) throw new Error('openai_api_key_missing');
      const model = deps.env.OPENAI_TTS_MODEL.trim();
      const voice = deps.env.OPENAI_TTS_VOICE.trim();
      const format = deps.env.OPENAI_TTS_FORMAT;
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), deps.env.OPENAI_TTS_TIMEOUT_MS);
      const onExternal = () => controller.abort();
      openAiAbort.signal.addEventListener('abort', onExternal, { once: true });
      const response = await fetch(`${deps.env.OPENAI_BASE_URL.replace(/\/$/, '')}/audio/speech`, {
        method: 'POST',
        headers: { authorization: `Bearer ${openAiApiKey}`, 'content-type': 'application/json' },
        // Speed is passed natively to OpenAI API (0.25–4.0); voice character via instructions if set
        body: JSON.stringify({
          model, voice, input: text, response_format: format, speed: deps.env.TTS_SPEED,
          ...(deps.env.OPENAI_TTS_INSTRUCTIONS ? { instructions: deps.env.OPENAI_TTS_INSTRUCTIONS } : {}),
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
      return { bytes, contentType, engineId: `openai:${model}`, via: `openai:${model}` };
    };

    // ── Race: ElevenLabs vs OpenAI — first success wins, loser aborted ────────
    // Cache hit ElevenLabs → OpenAI aborted at ~0ms cost.
    // ElevenLabs quota/500 retries → OpenAI wins after ~1s, ElevenLabs sleep interrupted via haAbort.
    let winner: TtsWin;
    try {
      const haPromise = doHaTts().then((v) => { openAiAbort.abort('race_winner_ha'); return v; });
      const activePromises: Promise<TtsWin>[] = [haPromise];
      if (deps.env.OPENAI_API_KEY?.trim()) {
        const openAiPromise = doOpenAiTts().then((v) => { haAbort.abort('race_winner_openai'); return v; });
        activePromises.push(openAiPromise);
      }
      winner = await new Promise<TtsWin>((resolve, reject) => {
        let remaining = activePromises.length;
        const onFail = () => { remaining -= 1; if (remaining === 0) reject(new Error('tts_all_failed')); };
        for (const p of activePromises) p.then(resolve, onFail);
      });
    } catch {
      app.log.warn({ attempts, voice_turn_id: voiceTurnId || undefined }, 'tts_all_failed');
      return reply.code(502).send({ error: 'tts_failed_all_candidates', attempts });
    }

    recordPerf('tts', Date.now() - t0);
    app.log.info({ engineId: winner.engineId, via: winner.via, elapsed_ms: Date.now() - t0, voice_turn_id: voiceTurnId || undefined }, 'tts_complete');
    return reply
      .code(200)
      .header('content-type', winner.contentType)
      .header('x-tts-provider', winner.via)
      .send(winner.bytes);
  });

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
    const params = z.object({ threadId: z.string().min(1) }).safeParse(req.params);
    if (!params.success) {
      return reply.code(400).send({ error: 'invalid_thread_id' });
    }

    const parsedQuery = historyQuerySchema.safeParse(req.query ?? {});
    if (!parsedQuery.success) {
      return reply.code(400).send({ error: 'invalid_query', issues: parsedQuery.error.issues });
    }

    const threadId = params.data.threadId.trim();
    const limit = parsedQuery.data.limit ?? 200;

    const thread = await threadRepository.getOrCreate(threadId);
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
    const params = z.object({ threadId: z.string().min(1) }).safeParse(req.params);
    if (!params.success) {
      return reply.code(400).send({ error: 'invalid_thread_id' });
    }

    const threadId = params.data.threadId.trim();

    try {
      // Delete from database (CASCADE will delete messages too)
      const db = createConversationDb(deps.env.CONVERSATION_DB_PATH);
      const result = db.prepare('DELETE FROM conversation_threads WHERE thread_id = ?').run(threadId);

      return reply.code(200).send({
        threadId,
        deleted: result.changes > 0,
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
