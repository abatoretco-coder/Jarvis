import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';

import { getRequestPrincipal, hasRequestPermission } from '../identity/requestIdentity';
import type { AppDeps } from '../server';

const entityIdSchema = z.string().regex(/^[a-z_]+\.[a-z0-9_]+$/u).max(255);
const historyQuerySchema = z.object({
  entityId: entityIdSchema,
  from: z.string().datetime({ offset: true }),
  to: z.string().datetime({ offset: true }),
  limit: z.coerce.number().int().min(1).max(5_000).default(2_000),
}).strict();

function canViewTelemetry(request: FastifyRequest): boolean {
  if (!hasRequestPermission(request, 'home')) return false;
  const principal = getRequestPrincipal(request);
  if (!principal) return true;
  if (principal.kind === 'service') return principal.permissions.includes('home');
  return !principal.roles.includes('guest');
}

export function registerHomeTelemetryRoutes(app: FastifyInstance, deps: AppDeps): void {
  app.get('/v1/home/telemetry/entities', async (request, reply) => {
    if (!canViewTelemetry(request)) return reply.code(403).send({ error: 'forbidden' });
    if (!deps.homeTelemetry) return reply.code(503).send({ error: 'home_telemetry_unavailable' });
    const sync = deps.homeTelemetry.getSyncState(deps.env.ACTIVE_HOME_ID);
    reply.header('cache-control', 'no-store');
    return reply.send({
      homeId: deps.env.ACTIVE_HOME_ID,
      entities: deps.homeTelemetry.listEntities(deps.env.ACTIVE_HOME_ID),
      sync: {
        ...(sync.historyCursorAtMs ? { historyCursorAt: new Date(sync.historyCursorAtMs).toISOString() } : {}),
        ...(sync.lastAttemptAtMs ? { lastAttemptAt: new Date(sync.lastAttemptAtMs).toISOString() } : {}),
        ...(sync.lastSuccessAtMs ? { lastSuccessAt: new Date(sync.lastSuccessAtMs).toISOString() } : {}),
        ...(sync.lastErrorCode ? { lastErrorCode: sync.lastErrorCode } : {}),
      },
    });
  });

  app.get('/v1/home/telemetry/history', async (request, reply) => {
    if (!canViewTelemetry(request)) return reply.code(403).send({ error: 'forbidden' });
    if (!deps.homeTelemetry) return reply.code(503).send({ error: 'home_telemetry_unavailable' });
    const parsed = historyQuerySchema.safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ error: 'home_telemetry_query_invalid' });
    const fromMs = Date.parse(parsed.data.from);
    const toMs = Date.parse(parsed.data.to);
    if (fromMs >= toMs || toMs - fromMs > 3 * 366 * 86_400_000) {
      return reply.code(400).send({ error: 'home_telemetry_query_invalid' });
    }
    const tracked = deps.homeTelemetry.listEntities(deps.env.ACTIVE_HOME_ID)
      .some((entity) => entity.entityId === parsed.data.entityId);
    if (!tracked) return reply.code(404).send({ error: 'home_telemetry_entity_not_found' });
    reply.header('cache-control', 'no-store');
    return reply.send({
      homeId: deps.env.ACTIVE_HOME_ID,
      entityId: parsed.data.entityId,
      from: new Date(fromMs).toISOString(),
      to: new Date(toMs).toISOString(),
      points: deps.homeTelemetry.history({
        homeId: deps.env.ACTIVE_HOME_ID,
        entityId: parsed.data.entityId,
        fromMs,
        toMs,
        limit: parsed.data.limit,
      }),
    });
  });
}
