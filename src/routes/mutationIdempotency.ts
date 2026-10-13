import { Readable } from 'node:stream';

import type { FastifyInstance, FastifyRequest } from 'fastify';

import {
  mutationFingerprint,
  MutationIdempotencyCoordinator,
} from '../idempotency/MutationIdempotencyCoordinator';
import { getRequestPrincipal } from '../identity/requestIdentity';

const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{8,128}$/u;
const reservations = new WeakMap<FastifyRequest, string>();

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function identityFor(request: FastifyRequest): string {
  const principal = getRequestPrincipal(request);
  if (principal?.kind === 'user') return `user:${principal.userId}`;
  if (principal?.kind === 'service') return `service:${principal.serviceId}`;
  return `legacy-local:${request.ip}`;
}

function mutationAction(request: FastifyRequest): string | undefined {
  const method = request.method.toUpperCase();
  if (['GET', 'HEAD', 'OPTIONS'].includes(method)) return undefined;
  const route = request.routeOptions.url;
  if (!route) return undefined;
  if (
    route.startsWith('/v1/home')
    || (method === 'POST' && route === '/v1/music/actions')
    || (method === 'POST' && route === '/v1/ingest')
  ) {
    return `${method} ${route}`;
  }
  return undefined;
}

export function registerMutationIdempotencyHooks(
  app: FastifyInstance,
  coordinator = new MutationIdempotencyCoordinator()
): void {
  app.get<{ Params: { idempotencyKey: string } }>(
    '/v1/mutation-results/:idempotencyKey',
    async (request, reply) => {
      const key = request.params.idempotencyKey.trim();
      if (!IDEMPOTENCY_KEY.test(key)) {
        return reply.code(400).send({ error: 'invalid_idempotency_key' });
      }
      const result = coordinator.lookup(identityFor(request), key);
      reply.header('cache-control', 'no-store');
      if (result.state === 'missing') return reply.code(404).send({ state: 'missing' });
      if (result.state === 'pending') return reply.code(202).send({ state: 'pending' });
      return reply.code(200).send({
        state: 'completed',
        statusCode: result.response.statusCode,
        contentType: result.response.contentType,
        payloadBase64: Buffer.from(result.response.payload).toString('base64'),
      });
    }
  );

  app.addHook('preHandler', async (request, reply) => {
    const action = mutationAction(request);
    if (!action) return;
    const rawKey = firstHeader(request.headers['idempotency-key']);
    if (rawKey === undefined) return; // Mixed-version compatibility during client rollout.
    const key = rawKey.trim();
    if (!IDEMPOTENCY_KEY.test(key)) {
      return reply.code(400).send({ error: 'invalid_idempotency_key' });
    }
    const fingerprint = mutationFingerprint(action, {
      params: request.params ?? null,
      query: request.query ?? null,
      body: request.body ?? null,
    });
    const reservation = coordinator.reserve(identityFor(request), key, fingerprint);
    if (reservation.kind === 'conflict') {
      return reply.code(409).send({ error: 'idempotency_key_conflict' });
    }
    if (reservation.kind === 'capacity') {
      return reply.code(503).send({ error: 'idempotency_capacity_exhausted' });
    }
    if (reservation.kind === 'replay') {
      const cached = await reservation.response;
      reply.header('idempotent-replay', 'true');
      if (cached.contentType) reply.type(cached.contentType);
      return reply.code(cached.statusCode).send(cached.payload);
    }
    reservations.set(request, reservation.cacheKey);
  });

  app.addHook('onSend', async (request, reply, payload) => {
    const cacheKey = reservations.get(request);
    if (!cacheKey) return payload;
    reservations.delete(request);
    if (payload instanceof Readable) {
      const chunks: Buffer[] = [];
      payload.on('data', (chunk: Buffer | string) => {
        chunks.push(Buffer.isBuffer(chunk) ? Buffer.from(chunk) : Buffer.from(chunk));
      });
      payload.once('end', () => {
        coordinator.complete(cacheKey, {
          statusCode: reply.statusCode,
          contentType: reply.getHeader('content-type')?.toString(),
          payload: Buffer.concat(chunks),
        });
      });
      // Keep the source alive as a cache sink even if the HTTP consumer drops.
      // Pause until Fastify has attached its own consumer so no early chunk is
      // lost from the live SSE response.
      payload.pause();
      setImmediate(() => payload.resume());
      return payload;
    }
    const cachedPayload = Buffer.isBuffer(payload) ? Buffer.from(payload) : String(payload ?? '');
    coordinator.complete(cacheKey, {
      statusCode: reply.statusCode,
      contentType: reply.getHeader('content-type')?.toString(),
      payload: cachedPayload,
    });
    return payload;
  });
}
