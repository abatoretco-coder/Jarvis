import type Database from 'better-sqlite3';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';

import { SqliteThreadRepository } from '../conversation/repositories/SqliteRepositories';
import { hasRequestPermission, requireUserPrincipal } from '../identity/requestIdentity';
import { canUseLivePilot } from '../voice/live/LiveAccessPolicy';
import type { LiveVoiceRuntime } from '../voice/live/runtime';

const sessionIdSchema = z.string().trim().regex(/^[A-Za-z0-9._:-]{8,160}$/u);
const delegationIdSchema = z.string().trim().regex(/^[A-Za-z0-9._:-]{1,160}$/u);

const createSessionSchema = z.object({
  sdp: z.string().min(1).max(65_536),
  threadId: z.string().trim().min(1).max(256),
  client: z.enum(['desktop', 'android']),
  deviceId: z.string().trim().min(8).max(256),
  contextNote: z.string().trim().max(1_000).optional(),
}).strict();

const telemetrySchema = z.object({
  sessionId: sessionIdSchema,
  type: z.enum([
    'client_connected',
    'first_input_transcript',
    'delegation_received',
    'ingest_started',
    'ingest_completed',
    'first_audio_played',
    'fallback_started',
    'client_closed',
  ]),
  delegationId: delegationIdSchema.optional(),
  elapsedMs: z.number().int().min(0).max(3_600_000).optional(),
}).strict();

function firstHeader(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? '') : (value ?? '');
}

function liveContext(request: FastifyRequest): Record<string, unknown> | null {
  if (!request.url.startsWith('/v1/ingest')) return null;
  const body = request.body;
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const clientContext = (body as Record<string, unknown>)['clientContext'];
  if (!clientContext || typeof clientContext !== 'object' || Array.isArray(clientContext)) return null;
  const record = clientContext as Record<string, unknown>;
  return record['voiceTransport'] === 'gpt-live' ? record : null;
}

export function registerLiveIngestValidationHook(
  app: FastifyInstance,
  live: LiveVoiceRuntime
): void {
  app.addHook('preHandler', async (request, reply) => {
    const context = liveContext(request);
    if (!context) return;
    let user;
    try {
      user = requireUserPrincipal(request);
    } catch {
      return reply.code(401).send({ error: 'oidc_user_required' });
    }
    if (!hasRequestPermission(request, 'chat')) return reply.code(403).send({ error: 'forbidden' });
    if (!canUseLivePilot(user, live.sessions.pilotOwnerOnly)) {
      return reply.code(403).send({ error: 'live_pilot_owner_required' });
    }
    const parsedIds = z.object({
      liveSessionId: sessionIdSchema,
      liveDelegationId: delegationIdSchema,
    }).safeParse(context);
    if (!parsedIds.success) return reply.code(400).send({ error: 'live_context_invalid' });
    const session = live.registry.findOwnedActive(parsedIds.data.liveSessionId, user.userId);
    if (!session) return reply.code(403).send({ error: 'live_session_forbidden_or_inactive' });
    const observed = await live.delegations.waitUntilObserved(
      parsedIds.data.liveSessionId,
      parsedIds.data.liveDelegationId,
      1_000
    );
    if (!observed) return reply.code(409).send({ error: 'live_delegation_not_observed' });
    const operationKey = firstHeader(request.headers['idempotency-key']).trim();
    try {
      live.delegations.markIngestSent(
        parsedIds.data.liveSessionId,
        parsedIds.data.liveDelegationId,
        operationKey
      );
    } catch (error) {
      const code = error instanceof Error ? error.message : 'live_delegation_invalid';
      return reply.code(409).send({ error: code });
    }
  });
}

export function registerLiveVoiceRoutes(
  app: FastifyInstance,
  live: LiveVoiceRuntime,
  db: Database.Database
): void {
  const threads = new SqliteThreadRepository(db);

  app.post('/v1/voice/live/sessions', async (request, reply) => {
    const parsed = createSessionSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_body' });
    let user;
    try {
      user = requireUserPrincipal(request);
    } catch {
      return reply.code(401).send({ error: 'oidc_user_required' });
    }
    if (!hasRequestPermission(request, 'chat')) return reply.code(403).send({ error: 'forbidden' });
    if (!canUseLivePilot(user, live.sessions.pilotOwnerOnly)) {
      return reply.code(403).send({ error: 'live_pilot_owner_required' });
    }
    try {
      await threads.getOrCreate(parsed.data.threadId, { channel: parsed.data.client });
    } catch {
      return reply.code(403).send({ error: 'thread_forbidden' });
    }
    try {
      const result = await live.sessions.create({ ownerUserId: user.userId, ...parsed.data });
      return reply.code(201).send(result);
    } catch (error) {
      const code = error instanceof Error ? error.message : 'live_session_create_failed';
      if (code === 'live_creation_rate_limited') return reply.code(429).send({ error: code });
      if (code === 'live_session_limit') return reply.code(409).send({ error: code });
      if (code.startsWith('live_unavailable:')) {
        return reply.code(503).send({ error: 'live_unavailable', reason: code.split(':')[1] });
      }
      request.log.warn({ errorCode: code }, 'live session creation failed');
      return reply.code(502).send({ error: 'live_session_create_failed' });
    }
  });

  app.delete<{ Params: { sessionId: string } }>(
    '/v1/voice/live/sessions/:sessionId',
    async (request, reply) => {
      const sessionId = sessionIdSchema.safeParse(request.params.sessionId);
      if (!sessionId.success) return reply.code(400).send({ error: 'invalid_session_id' });
      let user;
      try {
        user = requireUserPrincipal(request);
      } catch {
        return reply.code(401).send({ error: 'oidc_user_required' });
      }
      try {
        await live.sessions.close(sessionId.data, user.userId, true);
        return reply.code(204).send();
      } catch (error) {
        if (error instanceof Error && error.message === 'live_session_forbidden') {
          return reply.code(403).send({ error: 'forbidden' });
        }
        return reply.code(502).send({ error: 'live_session_close_failed' });
      }
    }
  );

  app.post('/v1/voice/live/telemetry', async (request, reply) => {
    const parsed = telemetrySchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_body' });
    let user;
    try {
      user = requireUserPrincipal(request);
    } catch {
      return reply.code(401).send({ error: 'oidc_user_required' });
    }
    const session = live.registry.find(parsed.data.sessionId);
    if (!session || session.ownerUserId !== user.userId) {
      return reply.code(403).send({ error: 'forbidden' });
    }
    if (parsed.data.delegationId) {
      const state = parsed.data.type === 'ingest_started'
        ? 'ingest_running'
        : parsed.data.type === 'ingest_completed'
          ? 'ingest_completed'
          : parsed.data.type === 'first_audio_played'
            ? 'replying'
            : parsed.data.type === 'fallback_started'
              ? 'uncertain'
              : null;
      if (state) {
        try {
          live.delegations.markClientState(
            parsed.data.sessionId,
            parsed.data.delegationId,
            state
          );
        } catch {
          return reply.code(409).send({ error: 'live_delegation_not_observed' });
        }
      }
    }
    live.registry.recordTelemetry({
      sessionId: parsed.data.sessionId,
      eventType: parsed.data.type,
      delegationId: parsed.data.delegationId,
      elapsedMs: parsed.data.elapsedMs,
    });
    request.log.info(
      {
        liveSessionId: parsed.data.sessionId,
        eventType: parsed.data.type,
        elapsedMs: parsed.data.elapsedMs,
      },
      'live client telemetry'
    );
    return reply.code(202).send({ status: 'accepted' });
  });
}
