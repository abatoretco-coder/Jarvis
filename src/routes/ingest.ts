import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { ConversationService, JARVIS_HA_AGENT_GENERAL } from '../conversation/ConversationService';
import { routeToHaAgent, parseAgentMap, SPOTIFY_AGENT_ID } from '../conversation/haAgentRouter';
import { resolveDeterministicIntentReply } from '../conversation/deterministicIntents';
import { toSingleParagraphPlainText } from '../conversation/plainText';
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

const ingestSchema = z.object({
  threadId: z.string().min(1),
  text: z.string().optional(),
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

/**
 * Calls Perplexity sonar (primary) or OpenAI gpt-4o-search-preview (fallback) for web search.
 * Bypasses HA entirely — Jarvis controls the system prompt and embeds concrete dates.
 */
async function callOpenAiSearchDirect(params: {
  text: string;
  openAiApiKey: string;
  openAiBaseUrl: string;
  perplexityApiKey?: string;
  perplexityBaseUrl?: string;
  perplexityModel?: string;
  timeoutMs: number;
  log?: { info: (obj: Record<string, unknown>, msg: string) => void };
}): Promise<string> {
  const now = new Date();
  const tz = 'Europe/Paris';
  const dateStr = now.toLocaleDateString('fr-FR', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: tz,
  });
  const monthYear = now.toLocaleDateString('fr-FR', { month: 'long', year: 'numeric', timeZone: tz });

  const systemPrompt =
    `Tu es un assistant de recherche web. Aujourd'hui: ${dateStr}. ` +
    `Cherche les informations les plus recentes sur le sujet demande en utilisant "${monthYear}" dans ta requete. ` +
    `Reponds en une seule phrase naturelle. Pas de tirets, pas de listes, pas de liens, pas de noms de sites.`;

  const usePerplexity = Boolean(params.perplexityApiKey);
  const apiKey = usePerplexity ? params.perplexityApiKey! : params.openAiApiKey;
  const baseUrl = usePerplexity
    ? (params.perplexityBaseUrl ?? 'https://api.perplexity.ai')
    : params.openAiBaseUrl;
  const model = usePerplexity
    ? (params.perplexityModel ?? 'sonar')
    : 'gpt-4o-search-preview';

  params.log?.info({ provider: usePerplexity ? 'perplexity' : 'openai', model }, 'search_agent_provider');

  const body: Record<string, unknown> = {
    model,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: params.text },
    ],
  };
  // OpenAI search-preview requires web_search_options; Perplexity does search natively
  if (!usePerplexity) {
    body['web_search_options'] = { search_context_size: 'high' };
  }

  const resp = await fetch(
    `${baseUrl.replace(/\/$/, '')}/chat/completions`,
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
  const content = data.choices?.[0]?.message?.content?.trim();
  params.log?.info({ provider: usePerplexity ? 'perplexity' : 'openai', content_len: content?.length ?? 0, content_preview: content?.slice(0, 120) }, 'search_agent_raw_response');
  return content || "Je n'ai pas obtenu cette information.";
}

function buildSearchDateContext(): string {
  const now = new Date();
  const tz = 'Europe/Paris';
  const dateStr = now.toLocaleDateString('fr-FR', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: tz,
  });
  const timeStr = now.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', timeZone: tz });
  const threshold = new Date(now.getTime() - 7 * 24 * 3600 * 1000);
  const thresholdStr = threshold.toLocaleDateString('fr-FR', {
    day: 'numeric', month: 'long', year: 'numeric', timeZone: tz,
  });
  return `[Date: ${dateStr} ${timeStr} Paris. Seuil de fraicheur: apres le ${thresholdStr}.]`;
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
  const TTS_PROVIDER_CACHE_TTL_MS = 60_000;

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
    const requestId = randomUUID();
    const t0 = Date.now();
    const voiceTurnId = typeof req.headers['x-voice-turn-id'] === 'string' ? req.headers['x-voice-turn-id'].trim() : '';
    const correlationId = typeof parsed.data.correlation_id === 'string' ? parsed.data.correlation_id.trim() : '';

    const toDeterministicHaFailureMessage = (): string => (
      'Je n’ai pas pu joindre l’agent Home Assistant pour cette requête. Réessaie dans quelques secondes ou formule une commande musique explicite (ex: « mets de la musique sur Spotify »).'
    );

    // Guardrail: explicit spotify contract always has priority.
    if (parsed.data.domain === 'spotify' && parsed.data.action) {
      const spotifyPayload = ingestSpotifyRequestSchema.safeParse({
        ...parsed.data,
        threadId,
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
      await conversationService.persistMessages(threadId, persistedInput, spotifyResponse.tts);

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

      return reply.code(200).send({
        threadId,
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

    const deterministicReply = resolveDeterministicIntentReply(text);
    if (deterministicReply) {
      await conversationService.persistMessages(threadId, text, deterministicReply.responseText);

      if (await summarizationService.shouldPresummarize(threadId)) {
        summarizationService.startPresummarize(threadId);
      }

      recordPerf('ingest', Date.now() - t0);
      app.log.info(
        {
          threadId,
          requestId,
          correlation_id: correlationId || undefined,
          voice_turn_id: voiceTurnId || undefined,
          intent: deterministicReply.intent,
          target: deterministicReply.target,
          elapsed_ms: Date.now() - t0,
        },
        'ingest_deterministic_reply_done'
      );

      return reply.code(200).send({
        threadId,
        responseText: deterministicReply.responseText,
        status: 'success',
        deterministic: {
          intent: deterministicReply.intent,
          ...(deterministicReply.target ? { target: deterministicReply.target } : {}),
        },
        ...(correlationId ? { correlation_id: correlationId } : {}),
      });
    }

    app.log.info(
      { threadId, requestId, text_len: text.length, voice_turn_id: voiceTurnId || undefined, correlation_id: correlationId || undefined },
      'ingest_start',
    );

    const committed = await summarizationService.commitCandidateIfReady(threadId);
    const threadBefore = await threadRepository.getOrCreate(threadId);
    const usedSummaryVersion =
      committed.usedSummaryVersion ?? (threadBefore.summaryVersion > 0 ? `v${threadBefore.summaryVersion}` : undefined);

    // ── Orchestrator layer ────────────────────────────────────────────────────
    // Router + HA general start in parallel.
    // Router returns a list of targets — supports multi-domain requests
    // (e.g. "lance la musique ET dis-moi la météo" → [spotify, jarvis_assistant]).
    //
    // HA general ALWAYS runs in parallel — it is the safety net.
    // If all specialized tasks succeed → HA result is discarded (never sent).
    // If any specialized task fails/returns null → HA general is the fallback.
    //
    // Outcomes:
    //   - single spotify target   → music planner + executor, early return (HA discarded)
    //   - spotify + HA targets    → run both in parallel, combine text parts
    //   - HA specialized only     → call those in parallel, combine, discard general
    //   - general / fail / none   → use HA general directly

    const agentEntries = parseAgentMap(deps.env.HA_AGENT_MAP);
    const spotifyEntry = Boolean(deps.spotifyWebApi)
      ? { agentId: SPOTIFY_AGENT_ID, hint: 'Musique streaming Spotify: jouer, pause, suivant, précédent, volume, recherche musicale' }
      : null;
    const allAgentEntries = [...(spotifyEntry ? [spotifyEntry] : []), ...agentEntries];
    const routerEnabled = allAgentEntries.length > 0 && Boolean(deps.env.OPENAI_API_KEY);
    const threshold = deps.env.ROUTER_CONFIDENCE_THRESHOLD;

    const recentMessages = routerEnabled ? await messageRepository.getRecentMessages(threadId, 3) : [];

    const generalAgentId = deps.env.HA_AGENT_GENERAL;

    if (!routerEnabled) {
      app.log.info({ threadId, requestId, reason: allAgentEntries.length === 0 ? 'no_agents' : 'no_openai_key' }, 'ha_agent_router_disabled');
    }

    const [routerResult, haGeneralResult] = await Promise.allSettled([
      routerEnabled
        ? routeToHaAgent({
            text,
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
        : Promise.reject(new Error('router_disabled')),
      conversationService.callHomeAssistantConversation(text, threadId, undefined, generalAgentId),
    ]);

    if (routerResult.status === 'rejected' && routerEnabled) {
      app.log.warn({ threadId, requestId, err: routerResult.reason }, 'ha_agent_router_failed_fallback_general');
    }

    // ── Resolve targets ───────────────────────────────────────────────────────
    let assistantText: string | undefined;

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
          // When the router already resolved the Spotify action directly, use it.
          // Fall back to the music planner only when the router didn't specify an action.
          const routerActionParsed = spotifyTarget.action ? spotifyActionSchema.safeParse(spotifyTarget.action) : null;
          const resolveSpotifyPayload = (routerActionParsed?.success)
            ? Promise.resolve({
                route: 'spotify' as const,
                reason: `router_direct:${routerActionParsed.data}`,
                request: {
                  domain: 'spotify' as const,
                  action: routerActionParsed.data,
                  slots: spotifyTarget.slots ?? {},
                  text,
                },
              })
            : planSpotifyActionFromTextWithOpenAi({
                env: deps.env,
                spotifyWebApi: deps.spotifyWebApi,
                text,
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
        for (const haTarget of haSpecTargets) {
          const agentEntry = agentEntryByAgentId.get(haTarget.agentId);
          const isSearchAgent = agentEntry?.key === 'search';

          if (isSearchAgent) {
            // Search: Perplexity sonar (if key configured) or OpenAI gpt-4o-search-preview — bypass HA entirely.
            // Jarvis controls the system prompt with concrete dates, forcing dated search queries.
            app.log.info({ threadId, requestId, agent: haTarget.agentId }, 'search_agent_direct_openai');
            tasks.push(
              callOpenAiSearchDirect({
                text,
                openAiApiKey: deps.env.OPENAI_API_KEY!,
                openAiBaseUrl: deps.env.OPENAI_BASE_URL,
                perplexityApiKey: deps.env.PERPLEXITY_API_KEY,
                perplexityBaseUrl: deps.env.PERPLEXITY_BASE_URL,
                perplexityModel: deps.env.PERPLEXITY_SEARCH_MODEL,
                timeoutMs: deps.env.OPENAI_TIMEOUT_MS,
                log: app.log,
              })
                .then((txt): SpecializedResult | null => {
                  app.log.info({ threadId, requestId, agent: haTarget.agentId }, 'search_agent_direct_done');
                  return { kind: 'ha_text', agentId: haTarget.agentId, text: txt };
                })
                .catch((err) => {
                  app.log.warn({ threadId, requestId, agent: haTarget.agentId, err }, 'search_agent_direct_failed_fallback_ha');
                  // Fallback to HA search agent if direct call fails
                  return conversationService
                    .callHomeAssistantConversation(`${buildSearchDateContext()}\n${text}`, threadId, undefined, haTarget.agentId)
                    .then((txt): SpecializedResult | null => {
                      if (/^\s*OUT_OF_SCOPE\s*$/i.test(txt)) return null;
                      return { kind: 'ha_text', agentId: haTarget.agentId, text: txt };
                    })
                    .catch(() => null);
                }),
            );
          } else {
            tasks.push(
              conversationService
                .callHomeAssistantConversation(text, threadId, undefined, haTarget.agentId)
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
            void conversationService.persistMessages(threadId, text, spotifyRes.tts).then(async () => {
              if (await summarizationService.shouldPresummarize(threadId)) {
                summarizationService.startPresummarize(threadId);
              }
            });
            return reply.code(200).send({
              threadId,
              responseText: spotifyRes.tts,
              ...spotifyRes.spotifyPayload,
              ...(correlationId ? { correlation_id: correlationId } : {}),
              planner: { source: 'openai_music_agent', route: spotifyRes.musicPlanRoute, reason: spotifyRes.musicPlanReason },
            });
          }

          // Multi-target: join all response parts
          const parts = goodResults.map((r) => (r.kind === 'spotify_tts' ? r.tts : r.text));
          assistantText = parts
            .map((p) => p.trim().replace(/\.?\s*$/, ''))
            .join('. ')
            .concat('.');
          app.log.info({ threadId, requestId, parts: parts.length }, 'multi_target_combined');
        }
        // All tasks failed/OUT_OF_SCOPE → assistantText stays undefined → HA general fallback
      }
      // No valid targets above threshold → HA general fallback
    }

    // ── General HA fallback ───────────────────────────────────────────────────
    if (assistantText === undefined) {
      if (haGeneralResult.status === 'fulfilled' && !/^\s*OUT_OF_SCOPE\s*$/i.test(haGeneralResult.value)) {
        app.log.info({ threadId, requestId, agent: generalAgentId }, 'ingest_ha_general_fallback');
        assistantText = haGeneralResult.value;
      } else if (haGeneralResult.status === 'fulfilled') {
        app.log.warn({ threadId, requestId, agent: generalAgentId }, 'ingest_ha_general_out_of_scope');
        assistantText = toDeterministicHaFailureMessage();
      } else {
        app.log.warn(
          { threadId, requestId, correlation_id: correlationId || undefined, err: haGeneralResult.reason },
          'ingest_home_assistant_call_failed'
        );
        assistantText = toDeterministicHaFailureMessage();
      }
    }

    void conversationService.persistMessages(threadId, text, assistantText).then(async () => {
      if (await summarizationService.shouldPresummarize(threadId)) {
        summarizationService.startPresummarize(threadId);
      }
    });

    const payload = {
      threadId,
      responseText: toSingleParagraphPlainText(assistantText),
      ...(usedSummaryVersion ? { usedSummaryVersion } : {}),
    };

    const validated = responseSchema.safeParse(payload);
    if (!validated.success) {
      return reply.code(500).send({ error: 'response_validation_failed' });
    }

    recordPerf('ingest', Date.now() - t0);
    app.log.info({ threadId, requestId, elapsed_ms: Date.now() - t0, voice_turn_id: voiceTurnId || undefined }, 'ingest_complete');
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
      try {
        const nowMs = Date.now();
        if (!ttsProviderCache || nowMs - ttsProviderCache.at > TTS_PROVIDER_CACHE_TTL_MS) {
          const statesRaw = await deps.ha.getStates();
          const providers = new Set(
            toEntityStates(statesRaw)
              .map((item) => item.entity_id)
              .filter((entityId) => entityId.startsWith('tts.'))
          );
          ttsProviderCache = { providers, at: nowMs };
        }
        const availableCandidates = candidateEngineIds.filter((engineId) => ttsProviderCache!.providers.has(engineId));
        if (availableCandidates.length > 0) {
          candidateEngineIds = availableCandidates;
        }
      } catch (err) {
        app.log.warn({ err }, 'tts_provider_discovery_failed');
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
    });

    const parsedQuery = listQuerySchema.safeParse(req.query ?? {});
    if (!parsedQuery.success) {
      return reply.code(400).send({ error: 'invalid_query', issues: parsedQuery.error.issues });
    }

    const limit = parsedQuery.data.limit ?? 40;
    const items = await threadRepository.listRecent(limit);

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

