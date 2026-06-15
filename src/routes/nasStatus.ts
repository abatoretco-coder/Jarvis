import type { FastifyInstance } from 'fastify';

import { AsyncSnapshotCache } from '../cache/AsyncSnapshotCache';
import type { AppDeps } from '../server';

export function registerNasStatusRoute(app: FastifyInstance, deps: AppDeps): void {
  const cache = new AsyncSnapshotCache(
    () => {
      if (!deps.nasStatus) throw new Error('NAS status is not configured');
      return deps.nasStatus.getStatus();
    },
    {
      ttlMs: deps.env.NAS_STATUS_CACHE_TTL_MS,
      staleMs: deps.env.NAS_STATUS_CACHE_STALE_MS,
    },
  );

  app.get('/v1/nas/status', async (_req, reply) => {
    if (!deps.nasStatus?.isConfigured()) {
      return reply.code(503).send({ status: 'unavailable', reason: 'not_configured' });
    }
    try {
      const snapshot = await cache.get();
      return reply.code(200).send({
        status: 'ok',
        cache: {
          hit: snapshot.cached,
          stale: snapshot.stale,
          fetchedAt: new Date(snapshot.fetchedAt).toISOString(),
        },
        nas: snapshot.value,
      });
    } catch (error) {
      app.log.warn({ error }, 'nas_status_failed');
      return reply.code(502).send({ status: 'unavailable', reason: 'collector_unreachable' });
    }
  });
}
