import type { FastifyReply, FastifyRequest } from 'fastify';

import type { UserPrincipal } from '../identity/IdentityService';
import { getRequestPrincipal } from '../identity/requestIdentity';
import type {
  AdminControlPlaneRepository,
  AdminMutationContext,
} from './AdminControlPlaneRepository';

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export function requireAdminActor(
  request: FastifyRequest,
  reply: FastifyReply,
  admin?: AdminControlPlaneRepository
): UserPrincipal | undefined {
  const principal = getRequestPrincipal(request);
  if (
    !principal ||
    principal.kind !== 'user' ||
    principal.status !== 'active' ||
    !principal.roles.includes('owner')
  ) {
    if (principal) {
      admin?.recordActorAudit({
        actorKind: principal.kind,
        actorId: principal.kind === 'user' ? principal.userId : principal.serviceId,
        action: 'admin.access',
        targetType: 'route',
        targetId: request.url.split('?')[0]?.slice(0, 256),
        outcome: 'denied',
        correlationId: request.id,
        clientIp: request.ip,
        clientReference: headerValue(request.headers['user-agent']),
      });
    }
    void reply.code(403).send({ error: 'human_admin_required' });
    return undefined;
  }
  return principal;
}

export function adminMutationContext(
  request: FastifyRequest,
  reply: FastifyReply,
  actor: UserPrincipal,
  input: { action: string; targetType: string; targetId?: string }
): AdminMutationContext | undefined {
  const idempotencyKey = headerValue(request.headers['idempotency-key'])?.trim();
  if (!idempotencyKey || !/^[A-Za-z0-9._:-]{8,128}$/u.test(idempotencyKey)) {
    void reply.code(400).send({ error: 'valid_idempotency_key_required' });
    return undefined;
  }
  const suppliedCorrelation = headerValue(request.headers['x-correlation-id'])?.trim();
  const clientReference = headerValue(request.headers['user-agent'])?.trim();
  return {
    actorUserId: actor.userId,
    idempotencyKey,
    action: input.action,
    targetType: input.targetType,
    targetId: input.targetId,
    correlationId: suppliedCorrelation?.slice(0, 160) || request.id,
    clientIp: request.ip,
    clientReference,
  };
}

export function sendAdminMutationError(
  error: unknown,
  reply: FastifyReply,
  admin: AdminControlPlaneRepository,
  context: Omit<AdminMutationContext, 'idempotencyKey'>
): FastifyReply {
  const code = error instanceof Error ? error.message : 'admin_mutation_failed';
  const mapping: Record<string, [number, string]> = {
    admin_idempotency_conflict: [409, 'idempotency_conflict'],
    admin_household_not_found: [404, 'household_not_found'],
    admin_user_not_found: [404, 'user_not_found'],
    admin_user_not_active: [409, 'user_not_active'],
    admin_last_household_owner: [409, 'last_household_owner'],
    admin_grantee_not_found: [404, 'grantee_not_found'],
    admin_grant_permissions_invalid: [400, 'grant_permissions_invalid'],
    admin_grant_expiry_invalid: [400, 'grant_expiry_invalid'],
    admin_grant_not_found_or_revoked: [404, 'grant_not_found_or_revoked'],
    admin_integration_not_found_or_revoked: [404, 'integration_not_found_or_revoked'],
    identity_approval_conflict: [409, 'approval_conflict'],
    identity_invalid_status_transition: [400, 'invalid_status_transition'],
    identity_last_owner: [409, 'last_owner'],
    identity_last_household_owner: [409, 'last_household_owner'],
    identity_single_role_required: [400, 'single_role_required'],
    identity_role_status_invalid: [409, 'role_status_invalid'],
  };
  const mapped = mapping[code];
  admin.recordAudit({
    ...context,
    outcome: 'failed',
    metadata: { errorCode: mapped?.[1] ?? 'mutation_failed' },
  });
  if (mapped) return reply.code(mapped[0]).send({ error: mapped[1] });
  throw error;
}
