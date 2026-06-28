import type { FastifyInstance } from 'fastify';

import type { NasStatus } from '../nas/NasStatusClient';
import type { AppDeps } from '../server';

function toPublicNasStatus(snapshot: NasStatus): Record<string, unknown> {
  return {
    hostname: snapshot.hostname,
    generatedAt: snapshot.generatedAt,
    uptimeSeconds: snapshot.uptimeSeconds,
    load: snapshot.load,
    memory: snapshot.memory,
    swap: snapshot.swap,
    disks: snapshot.filesystems.map((filesystem) => ({
      mount: filesystem.mount,
      totalBytes: filesystem.totalBytes,
      availableBytes: filesystem.availableBytes,
      usedPercent: filesystem.usedPercent,
    })),
    temperatures: snapshot.temperatures,
  };
}

export function registerNasStatusRoute(app: FastifyInstance, deps: AppDeps): void {
  app.get('/v1/nas/status', async (_req, reply) => {
    if (!deps.nasStatus?.isConfigured()) {
      return reply.code(503).send({ status: 'unavailable', reason: 'not_configured' });
    }
    try {
      const snapshot = await deps.nasStatus.getStatus();
      return reply.code(200).send({
        status: 'ok',
        nas: toPublicNasStatus(snapshot),
      });
    } catch (error) {
      app.log.warn({ error }, 'nas_status_failed');
      return reply.code(502).send({ status: 'unavailable', reason: 'collector_unreachable' });
    }
  });
}
