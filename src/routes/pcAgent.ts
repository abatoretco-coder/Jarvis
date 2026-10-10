import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { getRequestPrincipal } from '../identity/requestIdentity';
import type { AppDeps } from '../server';

const pollSchema = z.object({ spotifyRunning: z.boolean() }).strict();
const completeSchema = z.object({ commandId: z.string().uuid(), success: z.boolean() }).strict();

function isPcAgent(request: Parameters<typeof getRequestPrincipal>[0]): boolean {
  const principal = getRequestPrincipal(request);
  return principal?.kind === 'service' && principal.serviceId === 'pc-agent';
}

export function registerPcAgentRoutes(app: FastifyInstance, deps: AppDeps): void {
  app.post('/v1/pc-agent/poll', async (request, reply) => {
    if (!isPcAgent(request)) return reply.code(403).send({ error: 'pc_agent_required' });
    const parsed = pollSchema.safeParse(request.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: 'pc_agent_status_invalid' });
    const command = deps.pcAgentBroker?.reportStatus(parsed.data) ?? null;
    return reply.send({ command });
  });

  app.post('/v1/pc-agent/commands/complete', async (request, reply) => {
    if (!isPcAgent(request)) return reply.code(403).send({ error: 'pc_agent_required' });
    const parsed = completeSchema.safeParse(request.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: 'pc_agent_completion_invalid' });
    const accepted = deps.pcAgentBroker?.complete(parsed.data.commandId, parsed.data.success) ?? false;
    if (!accepted) return reply.code(409).send({ error: 'pc_agent_command_stale' });
    return reply.send({ status: 'accepted' });
  });
}

