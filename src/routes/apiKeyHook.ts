import type { FastifyInstance } from 'fastify';

import type { AdminControlPlaneRepository } from '../admin/AdminControlPlaneRepository';
import type { Env } from '../env';
import type { PermissionKey } from '../identity/IdentityRepository';
import type { IdentityService } from '../identity/IdentityService';
import { runWithRequestIdentityContext, setRequestPrincipal } from '../identity/requestIdentity';
import {
  getAuthorizedServicePrincipal,
  normalizeHeaderValue,
  parseAuthorizationBearer,
} from './apiKeyAuth';

function isProtectedV1Route(url?: string): boolean {
  if (!url) return false;
  return url === '/v1' || url.startsWith('/v1/');
}

function isOAuthRoute(url?: string): boolean {
  if (!url) return false;
  return url === '/v1/integrations/oauth/callback'
    || url.startsWith('/v1/integrations/oauth/callback?')
    || url === '/v1/integrations/oauth/google/callback'
    || url.startsWith('/v1/integrations/oauth/google/callback?');
}

function isIngestRoute(url?: string): boolean {
  if (!url) return false;
  return url === '/v1/ingest' || url.startsWith('/v1/ingest?');
}

function normalizeIp(value: string | undefined): string {
  if (!value) return '';
  const trimmed = value.trim();
  if (trimmed.startsWith('::ffff:')) return trimmed.replace('::ffff:', '');
  if (trimmed === '::1') return '127.0.0.1';
  return trimmed;
}

function readClientIp(req: { ip: string }): string {
  return normalizeIp(req.ip);
}

function allowedIngressIps(env: Env): Set<string> {
  if (!env.INGEST_ALLOWLIST_IPS) return new Set();
  return new Set(
    env.INGEST_ALLOWLIST_IPS.split(',')
      .map((item) => normalizeIp(item))
      .filter((item) => item.length > 0)
  );
}

function requiredPermissions(url: string): PermissionKey[] {
  // Ingest dispatches to multiple domains. Authorization is therefore done
  // at the execution boundary once the selected capability is known.
  if (isIngestRoute(url) || url.startsWith('/v1/pending-mutations')) return [];
  if (url.startsWith('/v1/admin/')) return ['admin'];
  if (url.startsWith('/v1/nas/status')) return ['nas.operations'];
  if (url.startsWith('/v1/threads')) return ['history'];
  if (url.startsWith('/v1/mail/')) return ['mail'];
  if (url.startsWith('/v1/todo/')) return ['todo'];
  if (url.startsWith('/v1/calendar/')) return ['calendar'];
  if (url.startsWith('/v1/dashboard')) return ['mail', 'calendar', 'todo'];
  if (url.startsWith('/v1/ha/')) return ['home'];
  if (url.startsWith('/v1/home')) return ['home'];
  if (url.startsWith('/v1/context-cache') || url.startsWith('/v1/oauth/')) return ['admin'];
  return ['chat'];
}

function accountError(status: string): string {
  return status === 'pending' ? 'account_pending' : 'account_unavailable';
}

export function registerApiKeyHook(
  app: FastifyInstance,
  env: Env,
  identityService?: IdentityService,
  adminAudit?: AdminControlPlaneRepository
): void {
  app.addHook('onRequest', (_req, _reply, done) => {
    runWithRequestIdentityContext(done);
  });
  app.addHook('preHandler', async (req, reply) => {
    if (isIngestRoute(req.url)) {
      const allowlist = allowedIngressIps(env);
      if (allowlist.size > 0) {
        const clientIp = readClientIp(req);
        if (!allowlist.has(clientIp)) {
          return reply.code(403).send({
            error: 'forbidden_ip',
            message: 'Client IP is not in INGEST_ALLOWLIST_IPS',
          });
        }
      }
    }

    if (!isProtectedV1Route(req.url)) return;
    // Only the provider callback is public. Its single-use state binds it to
    // the already authenticated user who initiated the transaction.
    if (isOAuthRoute(req.url)) return;

    const servicePrincipal = getAuthorizedServicePrincipal(req, env);
    if (servicePrincipal) {
      if (req.url.startsWith('/v1/integrations')) {
        return reply.code(403).send({ error: 'human_account_required' });
      }
      const permissions = requiredPermissions(req.url);
      if (
        servicePrincipal.permissions &&
        permissions.some((permission) => !servicePrincipal.permissions?.includes(permission))
      ) {
        if (req.url.startsWith('/v1/admin/')) {
          adminAudit?.recordActorAudit({
            actorKind: 'service',
            actorId: servicePrincipal.serviceId,
            action: 'admin.access',
            targetType: 'route',
            targetId: req.url.split('?')[0]?.slice(0, 256),
            outcome: 'denied',
            correlationId: req.id,
            clientIp: req.ip,
          });
        }
        return reply.code(403).send({ error: 'forbidden' });
      }
      setRequestPrincipal(req, servicePrincipal);
      return;
    }

    const bearer = parseAuthorizationBearer(normalizeHeaderValue(req.headers.authorization));
    if (identityService && bearer) {
      let authenticatedUserId: string | undefined;
      try {
        const principal = await identityService.authenticate(bearer);
        authenticatedUserId = principal.userId;
        setRequestPrincipal(req, principal);
        if (req.url.startsWith('/v1/auth/')) {
          if (req.url.startsWith('/v1/auth/sessions')) identityService.assertActive(principal);
          return;
        }
        identityService.assertActive(principal);
        requiredPermissions(req.url).forEach((permission) =>
          identityService.assertPermission(principal, permission)
        );
        return;
      } catch (error) {
        const message = error instanceof Error ? error.message : '';
        if (message.startsWith('identity_account_')) {
          return reply
            .code(403)
            .send({ error: accountError(message.slice('identity_account_'.length)) });
        }
        if (message === 'identity_permission_denied') {
          if (authenticatedUserId && req.url.startsWith('/v1/admin/')) {
            adminAudit?.recordActorAudit({
              actorKind: 'user',
              actorId: authenticatedUserId,
              action: 'admin.access',
              targetType: 'route',
              targetId: req.url.split('?')[0]?.slice(0, 256),
              outcome: 'denied',
              correlationId: req.id,
              clientIp: req.ip,
              clientReference: normalizeHeaderValue(req.headers['user-agent']),
            });
          }
          return reply.code(403).send({ error: 'forbidden' });
        }
        if (message === 'identity_session_revoked') {
          return reply.code(401).send({ error: 'session_revoked' });
        }
        app.log.warn(
          { reason: message === 'oidc_invalid_token' ? 'invalid_token' : 'identity_rejected' },
          'oidc_authentication_failed'
        );
        return reply.code(401).send({ error: 'unauthorized' });
      }
    }

    if (!env.REQUIRE_API_KEY && !env.OIDC_ENABLED) return;
    if (env.OIDC_ENABLED && req.url.startsWith('/v1/auth/')) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
    return reply
      .code(401)
      .send({ error: 'unauthorized', message: 'Missing or invalid credentials' });
  });
}
