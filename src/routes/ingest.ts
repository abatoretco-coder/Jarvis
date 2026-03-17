import { randomUUID } from 'node:crypto';

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { ConversationService } from '../conversation/ConversationService';
import { resolveDeterministicIntentReply } from '../conversation/deterministicIntents';
import { toSingleParagraphPlainText } from '../conversation/plainText';
import {
  createConversationDb,
  SqliteMessageRepository,
  SqliteThreadRepository,
} from '../conversation/repositories/SqliteRepositories';
import { SummarizationService } from '../conversation/SummarizationService';
import type { AppDeps } from '../server';
import { ingestSpotifyRequestSchema } from '../spotify/contracts';
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

  const response = await fetch(`${params.env.OPENAI_BASE_URL.replace(/\/$/, '')}/audio/transcriptions`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${openAiApiKey}`,
    },
    body: form,
  });

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

async function synthesizeWithOpenAi(params: {
  env: AppDeps['env'];
  text: string;
}): Promise<{ bytes: Buffer; contentType: string; provider: string }> {
  const openAiApiKey = params.env.OPENAI_API_KEY?.trim();
  if (!openAiApiKey) {
    throw new Error('openai_api_key_missing');
  }

  const model = params.env.OPENAI_TTS_MODEL.trim();
  const voice = params.env.OPENAI_TTS_VOICE.trim();
  const format = params.env.OPENAI_TTS_FORMAT;

  const response = await fetch(`${params.env.OPENAI_BASE_URL.replace(/\/$/, '')}/audio/speech`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${openAiApiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model,
      voice,
      input: params.text,
      format,
    }),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`openai_tts_failed:${response.status}:${errorBody.slice(0, 500)}`);
  }

  const contentType = response.headers.get('content-type') ?? 'audio/mpeg';
  const bytes = Buffer.from(await response.arrayBuffer());
  return {
    bytes,
    contentType,
    provider: `openai:${model}`,
  };
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

      app.log.info(
        {
          threadId,
          requestId,
          correlation_id: correlationId || undefined,
          intent: deterministicReply.intent,
          target: deterministicReply.target,
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

    const committed = await summarizationService.commitCandidateIfReady(threadId);
    const threadBefore = await threadRepository.getOrCreate(threadId);
    const usedSummaryVersion =
      committed.usedSummaryVersion ?? (threadBefore.summaryVersion > 0 ? `v${threadBefore.summaryVersion}` : undefined);

    // Both run in parallel — music planner (1 OpenAI call) + HA conversation simultaneously.
    // If planner routes to Spotify the HA result is discarded. If route=none, HA result is used directly.
    const [musicPlanResult, haResponseResult] = await Promise.allSettled([
      planSpotifyActionFromTextWithOpenAi({
        env: deps.env,
        spotifyWebApi: deps.spotifyWebApi,
        text,
        correlationId: correlationId || undefined,
        userId: typeof parsed.data.user_id === 'string' ? parsed.data.user_id.trim() || undefined : undefined,
      }),
      conversationService.callHomeAssistantConversation(text, threadId),
    ]);

    // If the music planner decided this is Spotify, execute and return immediately.
    if (musicPlanResult.status === 'fulfilled') {
      const musicPlan = musicPlanResult.value;

      if (musicPlan.route === 'spotify' && musicPlan.request) {
        const spotifyPayload = ingestSpotifyRequestSchema.safeParse({
          threadId,
          correlation_id: correlationId || undefined,
          user_id: typeof parsed.data.user_id === 'string' ? parsed.data.user_id.trim() || undefined : undefined,
          ...musicPlan.request,
          text,
        });

        if (spotifyPayload.success) {
          const spotifyResponse = await executeSpotifyCapability({
            request: spotifyPayload.data,
            spotifyWebApi: deps.spotifyWebApi,
            env: deps.env,
            log: app.log,
          });

          await conversationService.persistMessages(threadId, text, spotifyResponse.tts);

          if (await summarizationService.shouldPresummarize(threadId)) {
            summarizationService.startPresummarize(threadId);
          }

          app.log.info(
            {
              threadId,
              requestId,
              correlation_id: correlationId || undefined,
              route: musicPlan.route,
              reason: musicPlan.reason,
              action: spotifyPayload.data.action,
              status: spotifyResponse.status,
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
            planner: {
              source: 'openai_music_agent',
              route: musicPlan.route,
              reason: musicPlan.reason,
            },
          });
        }

        app.log.warn(
          { threadId, requestId, correlation_id: correlationId || undefined, issues: spotifyPayload.error.issues },
          'music_agent_generated_invalid_spotify_payload'
        );
      } else {
        app.log.info(
          { threadId, requestId, route: musicPlan.route, reason: musicPlan.reason, text },
          'music_agent_route_none_ha_wins'
        );
      }
    } else {
      app.log.warn(
        { threadId, requestId, correlation_id: correlationId || undefined, err: musicPlanResult.reason },
        'music_agent_planning_failed'
      );
    }

    // HA path wins — planner returned route=none, failed, or payload was invalid.
    app.log.info(
      { threadId, requestId, correlation_id: correlationId || undefined },
      'ingest_home_assistant_conversation_start'
    );

    let assistantText: string;
    if (haResponseResult.status === 'fulfilled') {
      assistantText = haResponseResult.value;
    } else {
      app.log.warn(
        { threadId, requestId, correlation_id: correlationId || undefined, err: haResponseResult.reason },
        'ingest_home_assistant_call_failed'
      );
      assistantText = toDeterministicHaFailureMessage();
    }

    await conversationService.persistMessages(threadId, text, assistantText);

    if (await summarizationService.shouldPresummarize(threadId)) {
      summarizationService.startPresummarize(threadId);
    }

    const payload = {
      threadId,
      responseText: toSingleParagraphPlainText(assistantText),
      ...(usedSummaryVersion ? { usedSummaryVersion } : {}),
    };

    const validated = responseSchema.safeParse(payload);
    if (!validated.success) {
      return reply.code(500).send({ error: 'response_validation_failed' });
    }

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

    try {
      const openAiResult = await transcribeWithOpenAi({
        env: deps.env,
        body,
        incomingContentType,
      });

      return reply.code(200).send({
        text: openAiResult.text,
        result: openAiResult.text,
        engineId: `openai:${openAiResult.model}`,
      });
    } catch {
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
      const candidateResponse = await fetch(`${deps.env.HA_BASE_URL.replace(/\/$/, '')}/api/stt/${encodeURIComponent(candidate)}`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${deps.env.HA_TOKEN}`,
          'content-type': incomingContentType,
          'x-speech-content': speechContent,
        },
        body,
      });

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
        const statesRaw = await deps.ha.getStates();
        const availableTtsProviders = new Set(
          toEntityStates(statesRaw)
            .map((item) => item.entity_id)
            .filter((entityId) => entityId.startsWith('tts.'))
        );
        const availableCandidates = candidateEngineIds.filter((engineId) => availableTtsProviders.has(engineId));
        if (availableCandidates.length > 0) {
          candidateEngineIds = availableCandidates;
        }
      } catch {
      }
    }

    try {
      let selectedEngineId = candidateEngineIds[0] ?? primaryEngineId;
      const attempts: Array<{ engineId: string; stage: 'tts_get_url' | 'audio_proxy'; status: number; message?: string }> = [];

      for (let index = 0; index < candidateEngineIds.length; index += 1) {
        const engineId = candidateEngineIds[index]!;
        selectedEngineId = engineId;

        const ttsUrlResponse = await fetch(`${haBaseUrl}/api/tts_get_url`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${deps.env.HA_TOKEN}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            engine_id: engineId,
            message: text,
            cache: true,
          }),
        });

        if (!ttsUrlResponse.ok) {
          const errorBody = await ttsUrlResponse.text();
          attempts.push({
            engineId,
            stage: 'tts_get_url',
            status: ttsUrlResponse.status,
            message: errorBody.slice(0, 300),
          });

          const hasNext = index < candidateEngineIds.length - 1;
          const shouldTryNext =
            hasNext
            && (isElevenLabsEngine(engineId)
              ? shouldFallbackFromElevenLabs(ttsUrlResponse.status, errorBody)
              : ttsUrlResponse.status === 404 || ttsUrlResponse.status === 429 || ttsUrlResponse.status >= 500);

          if (!shouldTryNext) {
            return reply.code(502).send({
              error: 'ha_tts_get_url_failed',
              status: ttsUrlResponse.status,
              engineId,
              attempts,
              hint:
                ttsUrlResponse.status === 500
                  ? 'Check Home Assistant TTS engine id settings and fallback list. Example HA_TTS_ENTITY_ID=tts.elevenlabs_text_to_speech HA_TTS_FALLBACK_ENTITY_IDS=tts.elevenlabs_text_to_speech'
                  : undefined,
            });
          }

          continue;
        }

        const ttsPayload = (await ttsUrlResponse.json()) as { path?: string; url?: string };
        const proxyUrl = typeof ttsPayload.path === 'string' && ttsPayload.path.length > 0
          ? `${haBaseUrl}${ttsPayload.path}`
          : ttsPayload.url;

        if (!proxyUrl) {
          attempts.push({
            engineId,
            stage: 'audio_proxy',
            status: 502,
            message: 'invalid_tts_response',
          });

          const hasNext = index < candidateEngineIds.length - 1;
          if (hasNext) {
            continue;
          }

          return reply.code(502).send({ error: 'ha_tts_invalid_response', attempts });
        }

        const upstream = await fetch(proxyUrl, {
          method: 'GET',
          headers: {
            authorization: `Bearer ${deps.env.HA_TOKEN}`,
          },
        });

        if (!upstream.ok) {
          const errorText = await upstream.text();
          attempts.push({
            engineId,
            stage: 'audio_proxy',
            status: upstream.status,
            message: errorText.slice(0, 300),
          });

          const hasNext = index < candidateEngineIds.length - 1;
          const shouldTryNext =
            hasNext
            && (isElevenLabsEngine(engineId)
              ? shouldFallbackFromElevenLabs(upstream.status, errorText)
              : upstream.status === 404 || upstream.status === 429 || upstream.status >= 500);

          if (shouldTryNext) {
            continue;
          }

          break;
        }

        const contentType = upstream.headers.get('content-type') ?? 'audio/mpeg';
        const bytes = Buffer.from(await upstream.arrayBuffer());

        return reply
          .code(200)
          .header('content-type', contentType)
          .header('x-tts-provider', `ha:${selectedEngineId}`)
          .send(bytes);
      }

      try {
        const openAiSpeech = await synthesizeWithOpenAi({ env: deps.env, text });
        return reply
          .code(200)
          .header('content-type', openAiSpeech.contentType)
          .header('x-tts-provider', openAiSpeech.provider)
          .send(openAiSpeech.bytes);
      } catch {
      }

      return reply.code(502).send({
        error: 'tts_failed_all_candidates',
        engineId: selectedEngineId,
        attempts,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'unknown_error';
      return reply.code(502).send({ error: 'ha_tts_failed', message });
    }
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

}

