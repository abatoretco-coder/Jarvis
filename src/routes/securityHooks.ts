import { timingSafeEqual } from 'node:crypto';

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import type { Env } from '../env';
import { getRequestPrincipal } from '../identity/requestIdentity';
import { parseAllowedOrigins } from '../security/edgePolicy';

type RateEntry = { count: number; resetAt: number };
type RateBucket = { name: string; max: number };

class BoundedRateStore {
  private readonly rates = new Map<string, RateEntry>();

  constructor(private readonly maxTrackedClients: number) {}

  consume(key: string, max: number, windowMs: number, now: number): RateEntry {
    const current = this.rates.get(key);
    const entry =
      !current || current.resetAt <= now
        ? { count: 1, resetAt: now + windowMs }
        : { count: current.count + 1, resetAt: current.resetAt };
    this.rates.delete(key);
    this.rates.set(key, entry);

    if (this.rates.size > this.maxTrackedClients) {
      for (const [client, value] of this.rates) {
        if (value.resetAt <= now) this.rates.delete(client);
      }
      while (this.rates.size > this.maxTrackedClients) {
        const oldest = this.rates.keys().next().value as string | undefined;
        if (!oldest) break;
        this.rates.delete(oldest);
      }
    }
    return entry;
  }
}

function normalizeIp(value: string | undefined): string {
  if (!value) return '';
  const trimmed = value.trim();
  if (trimmed.startsWith('::ffff:')) return trimmed.slice('::ffff:'.length);
  if (trimmed === '::1') return '127.0.0.1';
  return trimmed;
}

function routePath(url: string): string {
  return url.split('?')[0] ?? url;
}

function rateBucket(url: string, env: Env): RateBucket {
  const path = routePath(url);
  if (path.startsWith('/v1/auth/')) return { name: 'auth', max: env.RATE_LIMIT_AUTH_MAX };
  if (path.startsWith('/v1/integrations/oauth/')) {
    return { name: 'auth', max: env.RATE_LIMIT_AUTH_MAX };
  }
  if (
    path.startsWith('/v1/admin/') ||
    path.startsWith('/v1/nas-status') ||
    path.startsWith('/v1/integrations') ||
    path === '/v1/home/actions'
  ) {
    return { name: 'sensitive', max: env.RATE_LIMIT_SENSITIVE_MAX };
  }
  if (path.startsWith('/v1/stt') || path.startsWith('/v1/tts')) {
    return { name: 'audio', max: env.RATE_LIMIT_AUDIO_MAX };
  }
  if (path.startsWith('/v1/ingest')) return { name: 'ai', max: env.RATE_LIMIT_AI_MAX };
  return { name: 'general', max: env.RATE_LIMIT_MAX };
}

function headerValue(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? '') : (value ?? '');
}

function secretsMatch(expected: string, provided: string): boolean {
  const left = Buffer.from(expected);
  const right = Buffer.from(provided);
  return left.length === right.length && timingSafeEqual(left, right);
}

function publicOrigin(env: Env): string | undefined {
  return env.PUBLIC_BASE_URL ? new URL(env.PUBLIC_BASE_URL).origin : undefined;
}

function allowedOrigins(env: Env): Set<string> {
  const origins = parseAllowedOrigins(env.ALLOWED_ORIGINS);
  if (!env.PUBLIC_EDGE_ENABLED) {
    origins.add('http://localhost:1420');
    origins.add('http://127.0.0.1:1420');
    origins.add('http://tauri.localhost');
  }
  const origin = publicOrigin(env);
  if (origin) origins.add(origin);
  return origins;
}

function sendRateLimit(
  request: FastifyRequest,
  reply: FastifyReply,
  bucket: RateBucket,
  entry: RateEntry,
  now: number,
  scope: 'ip' | 'account'
) {
  request.log.warn(
    { securityEvent: 'rate_limit', bucket: bucket.name, scope },
    'security_request_rate_limited'
  );
  return reply
    .header('retry-after', String(Math.max(1, Math.ceil((entry.resetAt - now) / 1000))))
    .header('x-ratelimit-scope', scope)
    .code(429)
    .send({ error: 'rate_limited' });
}

export function registerSecurityHooks(app: FastifyInstance, env: Env): void {
  const ipRates = new BoundedRateStore(env.RATE_LIMIT_MAX_TRACKED_CLIENTS);
  const origins = allowedOrigins(env);
  const expectedHost = env.PUBLIC_BASE_URL ? new URL(env.PUBLIC_BASE_URL).host.toLowerCase() : '';

  app.addHook('onRequest', async (request, reply) => {
    // In public mode every path, including health probes, is exposed to hostile traffic.
    // Keep the narrower /v1-only behaviour for local development.
    if (env.PUBLIC_EDGE_ENABLED || request.url.startsWith('/v1/')) {
      const now = Date.now();
      const bucket = rateBucket(request.url, env);
      const entry = ipRates.consume(
        `${bucket.name}:${normalizeIp(request.ip)}`,
        bucket.max,
        env.RATE_LIMIT_WINDOW_MS,
        now
      );
      if (entry.count > bucket.max) {
        return sendRateLimit(request, reply, bucket, entry, now, 'ip');
      }
    }

    if (env.PUBLIC_EDGE_ENABLED) {
      const providedSecret = headerValue(request.headers['x-jarvis-edge-secret']);
      if (!env.EDGE_PROXY_SECRET || !secretsMatch(env.EDGE_PROXY_SECRET, providedSecret)) {
        request.log.warn({ securityEvent: 'edge_rejected' }, 'security_edge_secret_rejected');
        return reply.code(403).send({ error: 'edge_required' });
      }
      if (request.protocol !== 'https') {
        return reply.code(426).send({ error: 'https_required' });
      }
      if (request.host.toLowerCase() !== expectedHost) {
        return reply.code(421).send({ error: 'invalid_public_host' });
      }
    }

    const origin = headerValue(request.headers.origin);
    if (origin && !origins.has(origin)) {
      request.log.warn({ securityEvent: 'origin_rejected' }, 'security_origin_rejected');
      return reply.code(403).send({ error: 'origin_forbidden' });
    }
    if (origin && request.method === 'OPTIONS') {
      return reply
        .header('access-control-allow-origin', origin)
        .header('access-control-allow-methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS')
        .header(
          'access-control-allow-headers',
          'Authorization,Content-Type,Idempotency-Key,X-API-Key'
        )
        .header('access-control-max-age', '600')
        .header('vary', 'Origin')
        .code(204)
        .send();
    }
  });

  app.addHook('onSend', async (request, reply, payload) => {
    reply.header('x-content-type-options', 'nosniff');
    reply.header('x-frame-options', 'DENY');
    reply.header('referrer-policy', 'no-referrer');
    reply.header('permissions-policy', 'camera=(), microphone=()');
    reply.header(
      'content-security-policy',
      "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'"
    );
    reply.header('cache-control', 'no-store');
    const origin = headerValue(request.headers.origin);
    if (origin && origins.has(origin)) {
      reply.header('access-control-allow-origin', origin);
      reply.header('vary', 'Origin');
    }
    if (env.PUBLIC_EDGE_ENABLED && request.protocol === 'https') {
      reply.header('strict-transport-security', `max-age=${env.HSTS_MAX_AGE_SECONDS}`);
    }
    return payload;
  });
}

/** Register after authentication so limits can be isolated per human/service account. */
export function registerPrincipalRateLimitHook(app: FastifyInstance, env: Env): void {
  const accountRates = new BoundedRateStore(env.RATE_LIMIT_MAX_TRACKED_CLIENTS);
  app.addHook('preHandler', async (request, reply) => {
    if (!request.url.startsWith('/v1/')) return;
    const principal = getRequestPrincipal(request);
    if (!principal) return;
    const principalId =
      principal.kind === 'user'
        ? `user:${principal.userId}`
        : `service:${principal.serviceId ?? 'legacy'}`;
    const now = Date.now();
    const bucket = rateBucket(request.url, env);
    const entry = accountRates.consume(
      `${bucket.name}:${principalId}`,
      bucket.max,
      env.RATE_LIMIT_WINDOW_MS,
      now
    );
    if (entry.count > bucket.max) {
      return sendRateLimit(request, reply, bucket, entry, now, 'account');
    }
  });
}
