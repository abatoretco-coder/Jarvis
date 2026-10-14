import { Readable } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';

import type { FastifyInstance, FastifyRequest } from 'fastify';

import {
  type CachedMutationResponse,
  mutationFingerprint,
  MutationIdempotencyCoordinator,
} from '../idempotency/MutationIdempotencyCoordinator';
import { getRequestPrincipal } from '../identity/requestIdentity';

const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{8,128}$/u;
const reservations = new WeakMap<FastifyRequest, string>();

type MutationIdempotencyHookOptions = {
  streamCaptureMaxBytes?: number;
  streamCaptureMaxEventBytes?: number;
  streamCaptureTimeoutMs?: number;
};

function uncertainSse(reason: string): CachedMutationResponse {
  return {
    statusCode: 503,
    contentType: 'text/event-stream; charset=utf-8',
    payload: `event: error\ndata: ${JSON.stringify({ error: reason, operationStatus: 'uncertain' })}\n\n`,
  };
}

function captureStream(
  payload: Readable,
  response: { statusCode: number; contentType?: string },
  complete: (captured: CachedMutationResponse) => void,
  options: MutationIdempotencyHookOptions
): void {
  const maxBytes = options.streamCaptureMaxBytes ?? 512 * 1024;
  const maxEventBytes = options.streamCaptureMaxEventBytes ?? 256 * 1024;
  const chunks: Buffer[] = [];
  const decoder = new StringDecoder('utf8');
  let totalBytes = 0;
  let overflowed = false;
  let parseBuffer = '';
  let discardingOversizedEvent = false;
  let acknowledgement = '';
  let terminal = '';
  let settled = false;

  const processEvents = (text: string): void => {
    parseBuffer = `${parseBuffer}${text}`.replace(/\r\n/gu, '\n');
    if (discardingOversizedEvent) {
      const boundary = parseBuffer.indexOf('\n\n');
      if (boundary < 0) {
        if (Buffer.byteLength(parseBuffer, 'utf8') > maxEventBytes) parseBuffer = '';
        return;
      }
      parseBuffer = parseBuffer.slice(boundary + 2);
      discardingOversizedEvent = false;
    }
    while (true) {
      const boundary = parseBuffer.indexOf('\n\n');
      if (boundary < 0) break;
      const raw = parseBuffer.slice(0, boundary);
      parseBuffer = parseBuffer.slice(boundary + 2);
      if (Buffer.byteLength(raw, 'utf8') > maxEventBytes) continue;
      const event = `${raw}\n\n`;
      const type = raw.match(/^event:\s*([^\n]+)$/mu)?.[1]?.trim();
      if (type === 'ack' && !acknowledgement) acknowledgement = event;
      if (type === 'response' || type === 'error') terminal = event;
    }
    if (Buffer.byteLength(parseBuffer, 'utf8') > maxEventBytes) {
      parseBuffer = '';
      discardingOversizedEvent = true;
    }
  };

  const cleanup = (): void => {
    clearTimeout(timeout);
    payload.off('data', onData);
    payload.off('end', onEnd);
    payload.off('error', onError);
  };
  const finish = (captured: CachedMutationResponse): void => {
    if (settled) return;
    settled = true;
    cleanup();
    complete(captured);
  };
  const onData = (chunk: Buffer | string): void => {
    const bytes = Buffer.isBuffer(chunk) ? Buffer.from(chunk) : Buffer.from(chunk);
    processEvents(decoder.write(bytes));
    totalBytes += bytes.byteLength;
    if (!overflowed && totalBytes <= maxBytes) chunks.push(bytes);
    else if (!overflowed) {
      overflowed = true;
      chunks.length = 0;
    }
  };
  const onEnd = (): void => {
    processEvents(decoder.end());
    if (!overflowed) {
      finish({ ...response, payload: Buffer.concat(chunks) });
      return;
    }
    if (terminal) {
      finish({ ...response, payload: Buffer.from(`${acknowledgement}${terminal}`, 'utf8') });
      return;
    }
    finish(uncertainSse('mutation_stream_too_large'));
  };
  const onError = (): void => finish(uncertainSse('mutation_stream_interrupted'));
  const timeout = setTimeout(
    () => finish(uncertainSse('mutation_stream_timeout')),
    options.streamCaptureTimeoutMs ?? 60_000
  );
  timeout.unref?.();
  payload.on('data', onData);
  payload.once('end', onEnd);
  payload.once('error', onError);
}

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
    route.startsWith('/v1/home') ||
    (method === 'POST' && route === '/v1/music/actions') ||
    (method === 'POST' && route === '/v1/ingest')
  ) {
    return `${method} ${route}`;
  }
  return undefined;
}

export function registerMutationIdempotencyHooks(
  app: FastifyInstance,
  coordinator = new MutationIdempotencyCoordinator(),
  options: MutationIdempotencyHookOptions = {}
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
      captureStream(
        payload,
        {
          statusCode: reply.statusCode,
          contentType: reply.getHeader('content-type')?.toString(),
        },
        (captured) => coordinator.complete(cacheKey, captured),
        options
      );
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
