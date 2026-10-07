import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import {
  type AdminControlPlaneRepository,
  adminRequestFingerprint,
} from '../admin/AdminControlPlaneRepository';
import {
  adminMutationContext,
  requireAdminActor,
  sendAdminMutationError,
} from '../admin/adminHttp';
import type { IdentityService } from '../identity/IdentityService';
import { requireUserPrincipal } from '../identity/requestIdentity';

const roleSchema = z.enum(['owner', 'resident', 'guest']);
const statusChangeSchema = z
  .object({
    expected: z.enum(['pending', 'active', 'suspended', 'rejected', 'revoked']),
    next: z.enum(['pending', 'active', 'suspended', 'rejected', 'revoked']),
    confirmation: z.literal('confirm_privileged_change').optional(),
  })
  .strict();
const approvalSchema = z
  .object({
    role: roleSchema,
    confirmation: z.literal('confirm_privileged_change').optional(),
  })
  .strict();
const rolesSchema = z
  .object({
    roles: z.array(roleSchema).min(1).max(1),
    confirmation: z.literal('confirm_privileged_change').optional(),
  })
  .strict();

function publicUser(user: ReturnType<IdentityService['repository']['findAuthorizedUser']>) {
  if (!user) return null;
  return {
    userId: user.userId,
    email: user.email,
    displayName: user.displayName,
    status: user.status,
    roles: user.roles,
    permissions: user.permissions,
  };
}

export function registerIdentityRoutes(
  app: FastifyInstance,
  identity: IdentityService,
  admin: AdminControlPlaneRepository
): void {
  app.get('/v1/auth/me', async (request) => publicUser(requireUserPrincipal(request)));

  app.get('/v1/auth/sessions', async (request) => {
    const principal = requireUserPrincipal(request);
    identity.assertActive(principal);
    return { sessions: identity.repository.listSessions(principal.userId) };
  });

  app.post('/v1/auth/logout', async (request, reply) => {
    const principal = requireUserPrincipal(request);
    identity.repository.revokeSession(principal.userId, principal.sessionId);
    return reply.code(204).send();
  });

  app.delete<{ Params: { sessionId: string } }>(
    '/v1/auth/sessions/:sessionId',
    async (request, reply) => {
      const principal = requireUserPrincipal(request);
      const changed = identity.repository.revokeSession(principal.userId, request.params.sessionId);
      return changed
        ? reply.code(204).send()
        : reply.code(404).send({ error: 'session_not_found' });
    }
  );

  app.get('/v1/admin/users', async (request, reply) => {
    if (!requireAdminActor(request, reply, admin)) return;
    return { users: identity.repository.listUsers().map(publicUser) };
  });

  app.get<{ Params: { userId: string } }>('/v1/admin/users/:userId', async (request, reply) => {
    if (!requireAdminActor(request, reply, admin)) return;
    const userId = z.string().uuid().safeParse(request.params.userId);
    if (!userId.success) return reply.code(400).send({ error: 'invalid_user_id' });
    const user = identity.repository.findAuthorizedUser(userId.data);
    if (!user) return reply.code(404).send({ error: 'user_not_found' });
    return {
      ...publicUser(user),
      ...admin.getUserMetadata(userId.data),
      memberships: admin.listUserMemberships(userId.data),
    };
  });

  app.post<{ Params: { userId: string }; Body: unknown }>(
    '/v1/admin/users/:userId/approve',
    async (request, reply) => {
      const actor = requireAdminActor(request, reply, admin);
      if (!actor) return;
      const userId = z.string().uuid().safeParse(request.params.userId);
      if (!userId.success) return reply.code(400).send({ error: 'invalid_user_id' });
      const body = approvalSchema.safeParse(request.body);
      if (!body.success) return reply.code(400).send({ error: 'invalid_role' });
      if (
        body.data.role === 'owner' &&
        (!actor.roles.includes('owner') || body.data.confirmation !== 'confirm_privileged_change')
      ) {
        admin.recordAudit({
          actorUserId: actor.userId,
          action: 'user.approve',
          targetType: 'user',
          targetId: userId.data,
          outcome: 'denied',
        });
        return reply.code(403).send({ error: 'owner_confirmation_required' });
      }
      const context = adminMutationContext(request, reply, actor, {
        action: 'user.approve',
        targetType: 'user',
        targetId: userId.data,
      });
      if (!context) return;
      try {
        const result = admin.executeMutation(
          context,
          adminRequestFingerprint(context.action, context.targetId, body.data),
          () => publicUser(identity.repository.approveUser(userId.data, body.data.role)),
          { role: body.data.role }
        );
        if (result.replayed) reply.header('idempotent-replay', 'true');
        return result.value;
      } catch (error) {
        return sendAdminMutationError(error, reply, admin, context);
      }
    }
  );

  app.put<{ Params: { userId: string }; Body: unknown }>(
    '/v1/admin/users/:userId/roles',
    async (request, reply) => {
      const actor = requireAdminActor(request, reply, admin);
      if (!actor) return;
      const userId = z.string().uuid().safeParse(request.params.userId);
      if (!userId.success) return reply.code(400).send({ error: 'invalid_user_id' });
      const parsed = rolesSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: 'invalid_roles' });
      const target = identity.repository.findAuthorizedUser(userId.data);
      if (!target) return reply.code(404).send({ error: 'user_not_found' });
      const privilegedChange =
        target.roles.includes('owner') || parsed.data.roles.includes('owner');
      if (
        privilegedChange &&
        (!actor.roles.includes('owner') || parsed.data.confirmation !== 'confirm_privileged_change')
      ) {
        admin.recordAudit({
          actorUserId: actor.userId,
          action: 'user.roles.replace',
          targetType: 'user',
          targetId: userId.data,
          outcome: 'denied',
        });
        return reply.code(403).send({ error: 'owner_confirmation_required' });
      }
      const context = adminMutationContext(request, reply, actor, {
        action: 'user.roles.replace',
        targetType: 'user',
        targetId: userId.data,
      });
      if (!context) return;
      try {
        const result = admin.executeMutation(
          context,
          adminRequestFingerprint(context.action, context.targetId, parsed.data),
          () => publicUser(identity.repository.replaceRoles(userId.data, parsed.data.roles)),
          { roles: parsed.data.roles.join(',') }
        );
        if (result.replayed) reply.header('idempotent-replay', 'true');
        return result.value;
      } catch (error) {
        return sendAdminMutationError(error, reply, admin, context);
      }
    }
  );

  app.patch<{ Params: { userId: string }; Body: unknown }>(
    '/v1/admin/users/:userId/status',
    async (request, reply) => {
      const actor = requireAdminActor(request, reply, admin);
      if (!actor) return;
      const userId = z.string().uuid().safeParse(request.params.userId);
      if (!userId.success) return reply.code(400).send({ error: 'invalid_user_id' });
      const parsed = statusChangeSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: 'invalid_status_change' });
      if (parsed.data.expected === 'pending' && parsed.data.next === 'active') {
        return reply.code(400).send({ error: 'approval_role_required' });
      }
      const target = identity.repository.findAuthorizedUser(userId.data);
      if (!target) return reply.code(404).send({ error: 'user_not_found' });
      if (target.roles.includes('owner') && !actor.roles.includes('owner')) {
        admin.recordAudit({
          actorUserId: actor.userId,
          action: 'user.status.change',
          targetType: 'user',
          targetId: userId.data,
          outcome: 'denied',
        });
        return reply.code(403).send({ error: 'owner_required' });
      }
      if (
        target.roles.includes('owner') &&
        parsed.data.confirmation !== 'confirm_privileged_change'
      ) {
        admin.recordAudit({
          actorUserId: actor.userId,
          action: 'user.status.change',
          targetType: 'user',
          targetId: userId.data,
          outcome: 'denied',
        });
        return reply.code(403).send({ error: 'owner_confirmation_required' });
      }
      if (
        parsed.data.next === 'revoked' &&
        parsed.data.confirmation !== 'confirm_privileged_change'
      ) {
        admin.recordAudit({
          actorUserId: actor.userId,
          action: 'user.status.change',
          targetType: 'user',
          targetId: userId.data,
          outcome: 'denied',
        });
        return reply.code(403).send({ error: 'revocation_confirmation_required' });
      }
      const context = adminMutationContext(request, reply, actor, {
        action: 'user.status.change',
        targetType: 'user',
        targetId: userId.data,
      });
      if (!context) return;
      try {
        const result = admin.executeMutation(
          context,
          adminRequestFingerprint(context.action, context.targetId, parsed.data),
          () => {
            const changed = identity.repository.changeStatusSafely(
              userId.data,
              parsed.data.expected,
              parsed.data.next
            );
            if (!changed) throw new Error('identity_status_conflict');
            return publicUser(identity.repository.findAuthorizedUser(userId.data));
          },
          { expected: parsed.data.expected, next: parsed.data.next }
        );
        if (result.replayed) reply.header('idempotent-replay', 'true');
        return result.value;
      } catch (error) {
        if (error instanceof Error && error.message === 'identity_status_conflict') {
          admin.recordAudit({
            ...context,
            outcome: 'failed',
            metadata: { errorCode: 'status_conflict' },
          });
          return reply.code(409).send({ error: 'status_conflict' });
        }
        return sendAdminMutationError(error, reply, admin, context);
      }
    }
  );
}
