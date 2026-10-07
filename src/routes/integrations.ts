import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

import { requireUserPrincipal } from '../identity/requestIdentity';
import type { IntegrationService } from '../integrations/IntegrationService';

const beginSchema = z.object({
  kind: z.enum(['personal', 'household_shared']).default('personal'),
  displayName: z.string().trim().min(1).max(100).optional(),
  householdId: z.string().trim().min(1).max(160).regex(/^[A-Za-z0-9:_-]+$/).optional(),
}).strict();

function publicError(error: unknown): { status: number; code: string } {
  const code = error instanceof Error ? error.message : 'integration_failed';
  if (code === 'identity_permission_denied' || code === 'integration_household_admin_required') {
    return { status: 403, code };
  }
  if (code === 'integration_oauth_state_invalid') return { status: 403, code };
  if (code === 'integration_authorization_invalidated') return { status: 403, code };
  if (code === 'integration_connection_exists') return { status: 409, code };
  if (code === 'integration_not_found') return { status: 404, code };
  if (code === 'integration_provider_unavailable') return { status: 503, code };
  if (code === 'integration_consent_denied') return { status: 400, code };
  if (code === 'integration_provider_unknown' || code === 'integration_shared_name_required') {
    return { status: 400, code };
  }
  return { status: 502, code: 'integration_provider_failed' };
}

export function registerIntegrationRoutes(app: FastifyInstance, service: IntegrationService): void {
  app.get('/v1/integrations/providers', async (request) => {
    requireUserPrincipal(request);
    return { providers: service.providerStates() };
  });

  app.get('/v1/integrations', async (request) => {
    const principal = requireUserPrincipal(request);
    return { connections: service.repository.listForUser(principal.userId) };
  });

  app.get('/v1/integrations/households', async (request) => {
    const principal = requireUserPrincipal(request);
    return { households: service.repository.listManagedHouseholds(principal.userId) };
  });

  app.post('/v1/integrations/:provider/authorize', async (request, reply) => {
    const principal = requireUserPrincipal(request);
    const parsed = beginSchema.safeParse(request.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: 'integration_request_invalid' });
    try {
      return reply.send(service.beginAuthorization({
        principal,
        providerKey: (request.params as { provider: string }).provider,
        ...parsed.data,
      }));
    } catch (error) {
      const mapped = publicError(error);
      return reply.code(mapped.status).send({ error: mapped.code });
    }
  });

  app.post('/v1/integrations/:connectionId/reauthorize', async (request, reply) => {
    const principal = requireUserPrincipal(request);
    try {
      return reply.send(service.beginReauthorization({
        principal,
        connectionId: (request.params as { connectionId: string }).connectionId,
      }));
    } catch (error) {
      const mapped = publicError(error);
      return reply.code(mapped.status).send({ error: mapped.code });
    }
  });

  const completeCallback = async (request: FastifyRequest, reply: FastifyReply) => {
    const query = request.query as { state?: string; code?: string; error?: string };
    if (!query.state) return reply.code(400).type('text/plain').send('Transaction OAuth invalide.');
    try {
      await service.completeAuthorization({
        state: query.state,
        code: query.code,
        providerError: query.error,
      });
      return reply.type('text/html; charset=utf-8').send(
        '<!doctype html><html lang="fr"><meta charset="utf-8"><title>Jarvis</title><body><h1>Connexion réussie</h1><p>Vous pouvez fermer cette fenêtre et revenir dans Jarvis.</p></body></html>'
      );
    } catch (error) {
      const mapped = publicError(error);
      return reply.code(mapped.status).type('text/html; charset=utf-8').send(
        '<!doctype html><html lang="fr"><meta charset="utf-8"><title>Jarvis</title><body><h1>Connexion impossible</h1><p>Revenez dans Jarvis pour réessayer.</p></body></html>'
      );
    }
  };
  app.get('/v1/integrations/oauth/callback', completeCallback);
  app.get('/v1/integrations/oauth/google/callback', completeCallback);

  app.delete('/v1/integrations/:connectionId', async (request, reply) => {
    const principal = requireUserPrincipal(request);
    const connectionId = (request.params as { connectionId: string }).connectionId;
    const revoked = await service.revoke(principal, connectionId);
    return revoked ? reply.code(204).send() : reply.code(404).send({ error: 'integration_not_found' });
  });
}
