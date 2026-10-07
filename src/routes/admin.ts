import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import {
  type AdminControlPlaneRepository,
  adminRequestFingerprint,
  parseAuditCursor,
} from '../admin/AdminControlPlaneRepository';
import {
  adminMutationContext,
  requireAdminActor,
  sendAdminMutationError,
} from '../admin/adminHttp';
import { isHassState } from '../hass';
import { HomeCatalog } from '../home/HomeCatalog';
import { getOpenAiResilienceSnapshot } from '../openai/resilience';
import type { AppDeps } from '../server';

const identifierSchema = z
  .string()
  .trim()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9._:-]+$/u);
const roleSchema = z.enum(['owner', 'resident', 'guest']);
const membershipSchema = z
  .object({
    role: roleSchema,
    status: z.enum(['active', 'revoked']),
    confirmation: z.enum(['confirm_privileged_change']).optional(),
  })
  .strict();
const grantPermissions = z.enum(['view', 'control', 'manage', 'stream']);
const grantSchema = z
  .object({
    resourceType: z.enum([
      'domain',
      'area',
      'device',
      'capability',
      'camera',
      'lock',
      'nas.operation',
    ]),
    resourceId: identifierSchema,
    granteeUserId: z.string().uuid().optional(),
    granteeHouseholdId: identifierSchema.optional(),
    permissions: z.array(grantPermissions).min(1).max(4),
    expiresAtMs: z.number().int().positive().optional(),
    confirmation: z.enum(['confirm_sensitive_grant']).optional(),
  })
  .strict()
  .refine((value) => Boolean(value.granteeUserId) !== Boolean(value.granteeHouseholdId), {
    message: 'exactly_one_grantee_required',
  });
const revokeSchema = z.object({ confirmation: z.literal('confirm_integration_revoke') }).strict();
const sensitiveGrantRevocationSchema = z
  .object({
    confirmation: z.literal('confirm_sensitive_grant').optional(),
  })
  .strict();
const auditQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(200).default(50),
    beforeMs: z.coerce.number().int().positive().optional(),
    afterMs: z.coerce.number().int().positive().optional(),
    cursor: z.string().trim().min(1).max(512).optional(),
    actorId: identifierSchema.optional(),
    targetType: identifierSchema.optional(),
    action: z.string().trim().min(1).max(128).optional(),
    outcome: z.enum(['success', 'denied', 'failed']).optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.beforeMs === undefined || value.afterMs === undefined || value.afterMs < value.beforeMs,
    {
      message: 'invalid_audit_period',
    }
  );

function isSensitiveResource(resourceType: string): boolean {
  return resourceType === 'camera' || resourceType === 'lock' || resourceType === 'nas.operation';
}

function models(env: AppDeps['env']): Record<string, string> {
  return {
    router: env.OPENAI_MODEL_ROUTER,
    summary: env.OPENAI_MODEL_SUMMARY,
    agent: env.OPENAI_MODEL_AGENT,
    music: env.OPENAI_MODEL_MUSIC_AGENT,
    synthesis: env.OPENAI_MODEL_SYNTHESIS,
    embeddings: env.SEMANTIC_ROUTER_EMBEDDING_MODEL,
    speechToText: env.OPENAI_STT_MODEL,
    textToSpeech: env.OPENAI_TTS_MODEL,
  };
}

export function registerAdminRoutes(
  app: FastifyInstance,
  deps: AppDeps,
  admin: AdminControlPlaneRepository
): void {
  let homeCatalog: HomeCatalog | null = null;
  try {
    homeCatalog = new HomeCatalog(
      deps.env.HOME_CONFIG_ROOT,
      deps.env.ACTIVE_HOME_ID,
      deps.env.HOME_DATA_ROOT
    );
  } catch {
    // Inventory remains useful when the optional home map is not configured yet.
  }
  app.get('/v1/admin/permissions', async (request, reply) => {
    if (!requireAdminActor(request, reply, admin)) return;
    return {
      rolePermissions: admin.listRolePermissions(),
      grantResourceTypes: [
        'domain',
        'area',
        'device',
        'capability',
        'camera',
        'lock',
        'nas.operation',
      ],
      grantPermissions: grantPermissions.options,
    };
  });

  app.get('/v1/admin/households', async (request, reply) => {
    if (!requireAdminActor(request, reply, admin)) return;
    return { households: admin.listHouseholds() };
  });

  app.get<{ Params: { householdId: string } }>(
    '/v1/admin/households/:householdId/members',
    async (request, reply) => {
      if (!requireAdminActor(request, reply, admin)) return;
      const householdId = identifierSchema.safeParse(request.params.householdId);
      if (!householdId.success) return reply.code(400).send({ error: 'invalid_household_id' });
      return { members: admin.listMemberships(householdId.data) };
    }
  );

  app.put<{ Params: { householdId: string; userId: string }; Body: unknown }>(
    '/v1/admin/households/:householdId/members/:userId',
    async (request, reply) => {
      const actor = requireAdminActor(request, reply, admin);
      if (!actor) return;
      const householdId = identifierSchema.safeParse(request.params.householdId);
      const userId = z.string().uuid().safeParse(request.params.userId);
      const body = membershipSchema.safeParse(request.body);
      if (!householdId.success || !userId.success || !body.success) {
        return reply.code(400).send({ error: 'invalid_membership' });
      }
      const currentMembership = admin.getMembership(householdId.data, userId.data);
      const privilegedChange = currentMembership?.role === 'owner' || body.data.role === 'owner';
      if (
        privilegedChange &&
        (!actor.roles.includes('owner') || body.data.confirmation !== 'confirm_privileged_change')
      ) {
        admin.recordAudit({
          actorUserId: actor.userId,
          action: 'household.membership.change',
          targetType: 'user',
          targetId: userId.data,
          outcome: 'denied',
        });
        return reply.code(403).send({ error: 'owner_confirmation_required' });
      }
      const context = adminMutationContext(request, reply, actor, {
        action: 'household.membership.change',
        targetType: 'user',
        targetId: userId.data,
      });
      if (!context) return;
      try {
        const result = admin.executeMutation(
          context,
          adminRequestFingerprint(context.action, context.targetId, body.data),
          () =>
            admin.setMembership({
              householdId: householdId.data,
              userId: userId.data,
              role: body.data.role,
              status: body.data.status,
            }),
          { householdId: householdId.data, role: body.data.role, status: body.data.status }
        );
        if (result.replayed) reply.header('idempotent-replay', 'true');
        return result.value;
      } catch (error) {
        return sendAdminMutationError(error, reply, admin, context);
      }
    }
  );

  app.get('/v1/admin/grants', async (request, reply) => {
    if (!requireAdminActor(request, reply, admin)) return;
    return { grants: admin.listGrants() };
  });

  app.post<{ Body: unknown }>('/v1/admin/grants', async (request, reply) => {
    const actor = requireAdminActor(request, reply, admin);
    if (!actor) return;
    const body = grantSchema.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid_grant' });
    if (
      isSensitiveResource(body.data.resourceType) &&
      (!actor.roles.includes('owner') || body.data.confirmation !== 'confirm_sensitive_grant')
    ) {
      admin.recordAudit({
        actorUserId: actor.userId,
        action: 'grant.create',
        targetType: body.data.resourceType,
        targetId: body.data.resourceId,
        outcome: 'denied',
      });
      return reply.code(403).send({ error: 'owner_confirmation_required' });
    }
    const context = adminMutationContext(request, reply, actor, {
      action: 'grant.create',
      targetType: body.data.resourceType,
      targetId: body.data.resourceId,
    });
    if (!context) return;
    try {
      const result = admin.executeMutation(
        context,
        adminRequestFingerprint(context.action, context.targetId, body.data),
        () => admin.createGrant({ ...body.data, createdByUserId: actor.userId }),
        { permissions: body.data.permissions.join(',') }
      );
      if (result.replayed) reply.header('idempotent-replay', 'true');
      return reply.code(201).send(result.value);
    } catch (error) {
      return sendAdminMutationError(error, reply, admin, context);
    }
  });

  app.delete<{ Params: { grantId: string }; Body: unknown }>(
    '/v1/admin/grants/:grantId',
    async (request, reply) => {
      const actor = requireAdminActor(request, reply, admin);
      if (!actor) return;
      const grantId = z.string().uuid().safeParse(request.params.grantId);
      if (!grantId.success) return reply.code(400).send({ error: 'invalid_grant_id' });
      const body = sensitiveGrantRevocationSchema.safeParse(request.body ?? {});
      if (!body.success) return reply.code(400).send({ error: 'invalid_grant_revocation' });
      const grant = admin.getGrant(grantId.data);
      if (!grant) return reply.code(404).send({ error: 'grant_not_found_or_revoked' });
      if (
        isSensitiveResource(String(grant.resourceType)) &&
        (!actor.roles.includes('owner') || body.data.confirmation !== 'confirm_sensitive_grant')
      ) {
        admin.recordAudit({
          actorUserId: actor.userId,
          action: 'grant.revoke',
          targetType: 'grant',
          targetId: grantId.data,
          outcome: 'denied',
        });
        return reply.code(403).send({ error: 'owner_confirmation_required' });
      }
      const context = adminMutationContext(request, reply, actor, {
        action: 'grant.revoke',
        targetType: 'grant',
        targetId: grantId.data,
      });
      if (!context) return;
      try {
        const result = admin.executeMutation(
          context,
          adminRequestFingerprint(context.action, context.targetId, body.data),
          () => admin.revokeGrant(grantId.data)
        );
        if (result.replayed) reply.header('idempotent-replay', 'true');
        return result.value;
      } catch (error) {
        return sendAdminMutationError(error, reply, admin, context);
      }
    }
  );

  app.get('/v1/admin/integrations', async (request, reply) => {
    if (!requireAdminActor(request, reply, admin)) return;
    return { integrations: admin.listIntegrations() };
  });

  app.post<{ Params: { connectionId: string }; Body: unknown }>(
    '/v1/admin/integrations/:connectionId/revoke',
    async (request, reply) => {
      const actor = requireAdminActor(request, reply, admin);
      if (!actor) return;
      const connectionId = identifierSchema.safeParse(request.params.connectionId);
      const body = revokeSchema.safeParse(request.body);
      if (!connectionId.success || !body.success)
        return reply.code(400).send({ error: 'revocation_confirmation_required' });
      const context = adminMutationContext(request, reply, actor, {
        action: 'integration.revoke',
        targetType: 'integration',
        targetId: connectionId.data,
      });
      if (!context) return;
      try {
        const result = admin.executeMutation(
          context,
          adminRequestFingerprint(context.action, context.targetId, body.data),
          () => admin.revokeIntegration(connectionId.data)
        );
        if (result.replayed) reply.header('idempotent-replay', 'true');
        return result.value;
      } catch (error) {
        return sendAdminMutationError(error, reply, admin, context);
      }
    }
  );

  app.get('/v1/admin/audit', async (request, reply) => {
    if (!requireAdminActor(request, reply, admin)) return;
    const query = auditQuerySchema.safeParse(request.query);
    if (!query.success) return reply.code(400).send({ error: 'invalid_audit_query' });
    const cursor = query.data.cursor ? parseAuditCursor(query.data.cursor) : undefined;
    if (query.data.cursor && !cursor)
      return reply.code(400).send({ error: 'invalid_audit_cursor' });
    return admin.listAudit({ ...query.data, cursor: cursor ?? undefined });
  });

  app.get('/v1/admin/services', async (request, reply) => {
    if (!requireAdminActor(request, reply, admin)) return;
    const haStatus = deps.ha ? await deps.ha.probeHealth() : 'not_configured';
    return {
      version: '0.1.0',
      services: [
        { key: 'jarvis-api', status: 'ok', configured: true },
        {
          key: 'identity',
          status: deps.env.OIDC_ENABLED ? 'configured' : 'not_configured',
          configured: deps.env.OIDC_ENABLED,
        },
        { key: 'home-assistant', status: haStatus, configured: Boolean(deps.ha) },
        {
          key: 'openai',
          status: deps.env.OPENAI_API_KEY ? 'configured' : 'not_configured',
          configured: Boolean(deps.env.OPENAI_API_KEY),
        },
        {
          key: 'spotify',
          status: deps.spotifyWebApi.isConfigured() ? 'configured' : 'not_configured',
          configured: deps.spotifyWebApi.isConfigured(),
        },
        {
          key: 'nas-status',
          status: deps.nasStatus?.isConfigured() ? 'configured' : 'not_configured',
          configured: Boolean(deps.nasStatus?.isConfigured()),
        },
      ],
    };
  });

  app.get('/v1/admin/ai', async (request, reply) => {
    if (!requireAdminActor(request, reply, admin)) return;
    return {
      provider: deps.env.LLM_PROVIDER,
      configured: Boolean(deps.env.OPENAI_API_KEY),
      models: models(deps.env),
      telemetry: getOpenAiResilienceSnapshot(),
    };
  });

  app.get('/v1/admin/home/inventory', async (request, reply) => {
    if (!requireAdminActor(request, reply, admin)) return;
    if (!deps.ha) return reply.code(503).send({ error: 'home_assistant_not_configured' });
    try {
      const raw = await deps.ha.getStates();
      const activeGrants = admin.listActiveGrants();
      const entities = (Array.isArray(raw) ? raw : [])
        .filter(isHassState)
        .map((state) => {
          const attributes =
            state.attributes && typeof state.attributes === 'object'
              ? (state.attributes as Record<string, unknown>)
              : {};
          const areaId = typeof attributes.area_id === 'string' ? attributes.area_id : undefined;
          return {
            entityId: state.entity_id,
            domain: state.entity_id.split('.')[0],
            name:
              typeof attributes.friendly_name === 'string' ? attributes.friendly_name : undefined,
            availability:
              state.state === 'unavailable' || state.state === 'unknown'
                ? 'unavailable'
                : 'available',
            areaId,
            mapped: Boolean(homeCatalog?.hasEntityId(state.entity_id)),
            grantIds: activeGrants
              .filter(
                (grant) =>
                  (grant.resourceType === 'device' && grant.resourceId === state.entity_id) ||
                  (grant.resourceType === 'domain' &&
                    grant.resourceId === state.entity_id.split('.')[0]) ||
                  (grant.resourceType === 'area' && grant.resourceId === areaId)
              )
              .map((grant) => grant.grantId),
          };
        })
        .sort((left, right) => left.entityId.localeCompare(right.entityId));
      const areas = [
        ...new Set(
          entities.map((entity) => entity.areaId).filter((value): value is string => Boolean(value))
        ),
      ].sort();
      return {
        areas,
        entities,
        unmappedEntityIds: entities
          .filter((entity) => !entity.mapped)
          .map((entity) => entity.entityId),
      };
    } catch {
      return reply.code(503).send({ error: 'home_assistant_unavailable' });
    }
  });

  app.get('/v1/admin/operations', async (request, reply) => {
    if (!requireAdminActor(request, reply, admin)) return;
    return {
      operations: [
        {
          key: 'grant.revoke',
          available: true,
          reversible: false,
          confirmation: 'idempotency_key',
        },
        {
          key: 'integration.revoke',
          available: true,
          reversible: false,
          confirmation: 'explicit_and_idempotency_key',
        },
        { key: 'user.suspend', available: true, reversible: true, confirmation: 'idempotency_key' },
        {
          key: 'nas.restart_service',
          available: false,
          reversible: true,
          confirmation: 'reauthentication',
          reason: 'not_implemented',
        },
      ],
    };
  });
}
