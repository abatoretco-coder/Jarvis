import type { FastifyInstance } from 'fastify';

const RATE_WINDOW_MS = 60_000;
const RATE_LIMIT = 240;
const MAX_TRACKED_CLIENTS = 10_000;

type RateEntry = {
  count: number;
  resetAt: number;
};

export function registerSecurityHooks(app: FastifyInstance): void {
  const rates = new Map<string, RateEntry>();

  app.addHook('onRequest', async (req, reply) => {
    if (!req.url.startsWith('/v1/')) return;

    const now = Date.now();
    const key = req.ip;
    const current = rates.get(key);
    const entry = !current || current.resetAt <= now
      ? { count: 1, resetAt: now + RATE_WINDOW_MS }
      : { count: current.count + 1, resetAt: current.resetAt };
    rates.set(key, entry);

    if (rates.size > MAX_TRACKED_CLIENTS) {
      for (const [client, value] of rates) {
        if (value.resetAt <= now) rates.delete(client);
      }
      while (rates.size > MAX_TRACKED_CLIENTS) {
        const oldest = rates.keys().next().value as string | undefined;
        if (!oldest) break;
        rates.delete(oldest);
      }
    }

    if (entry.count > RATE_LIMIT) {
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
    reply.header('permissions-policy', 'camera=(), geolocation=(), microphone=()');
    reply.header('cache-control', 'no-store');
    return payload;
  });
}
