import type { FastifyInstance } from 'fastify';

import type { Env } from '../env';

type RateEntry = {
  count: number;
  resetAt: number;
};

function normalizeIp(value: string | undefined): string {
  if (!value) return '';
  const trimmed = value.trim();
  if (trimmed.startsWith('::ffff:')) return trimmed.slice('::ffff:'.length);
  if (trimmed === '::1') return '127.0.0.1';
  return trimmed;
}

export function registerSecurityHooks(app: FastifyInstance, env: Env): void {
  const rates = new Map<string, RateEntry>();

  app.addHook('onRequest', async (req, reply) => {
    if (!req.url.startsWith('/v1/')) return;

    const now = Date.now();
    const key = normalizeIp(req.ip);
    const current = rates.get(key);
    const entry = !current || current.resetAt <= now
      ? { count: 1, resetAt: now + env.RATE_LIMIT_WINDOW_MS }
      : { count: current.count + 1, resetAt: current.resetAt };
    rates.set(key, entry);

    if (rates.size > env.RATE_LIMIT_MAX_TRACKED_CLIENTS) {
      for (const [client, value] of rates) {
        if (value.resetAt <= now) rates.delete(client);
      }
      while (rates.size > env.RATE_LIMIT_MAX_TRACKED_CLIENTS) {
        const oldest = rates.keys().next().value as string | undefined;
        if (!oldest) break;
        rates.delete(oldest);
      }
    }

    if (entry.count > env.RATE_LIMIT_MAX) {
      return reply
        .header('retry-after', String(Math.max(1, Math.ceil((entry.resetAt - now) / 1000))))
        .code(429)
        .send({ error: 'rate_limited' });
    }
  });

  app.addHook('onSend', async (_req, reply, payload) => {
    reply.header('x-content-type-options', 'nosniff');
    reply.header('x-frame-options', 'DENY');
    reply.header('referrer-policy', 'no-referrer');
    reply.header('permissions-policy', 'camera=(), microphone=()');
    reply.header('cache-control', 'no-store');
    return payload;
  });
}
