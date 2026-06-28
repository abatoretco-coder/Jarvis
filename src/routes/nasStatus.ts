import type { FastifyInstance } from 'fastify';

import type { AppDeps } from '../server';

export function registerNasStatusRoute(app: FastifyInstance, deps: AppDeps): void {
  app.get('/v1/nas/status', async (_req, reply) => {
    if (!deps.nasStatus?.isConfigured()) {
      return reply.code(503).send({ status: 'unavailable', reason: 'not_configured' });
    }
    try {
      const snapshot = await deps.nasStatus.getStatus();
      return reply.code(200).send({
        status: 'ok',
        nas: snapshot,
      });
    } catch (error) {
      app.log.warn({ error }, 'nas_status_failed');
      return reply.code(502).send({ status: 'unavailable', reason: 'collector_unreachable' });
    }
  });
}
