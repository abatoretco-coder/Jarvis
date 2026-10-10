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
  if (route.startsWith('/v1/home') || (method === 'POST' && route === '/v1/music/actions')) {
    return `${method} ${route}`;
  }
  return undefined;
}

export function registerMutationIdempotencyHooks(
  app: FastifyInstance,
  coordinator = new MutationIdempotencyCoordinator()
): void {
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
    const cachedPayload = Buffer.isBuffer(payload) ? Buffer.from(payload) : String(payload ?? '');
    coordinator.complete(cacheKey, {
      statusCode: reply.statusCode,
      contentType: reply.getHeader('content-type')?.toString(),
      payload: cachedPayload,
    });
    return payload;
  });
}
