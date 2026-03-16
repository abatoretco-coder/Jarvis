import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import type { AppDeps } from '../server';

export function registerFlowAuditRoute(app: FastifyInstance, deps: AppDeps): void {
  app.get('/v1/flows/recent', async (req, reply) => {
    if (!deps.env.EXPOSE_FLOW_AUDIT_API) {
      return reply.code(404).send({ error: 'not_found' });
    }

    if (!deps.flowAudit.isEnabled()) {
      return {
        ok: true,
        enabled: false,
        items: [],
      };
    }

    const query = z
      .object({
        limit: z.coerce.number().int().min(1).max(500).default(100),
      })
      .parse(req.query);

    const items = await deps.flowAudit.recent(query.limit);
    return {
      ok: true,
      enabled: true,
      limit: query.limit,
      items,
    };
  });
}
