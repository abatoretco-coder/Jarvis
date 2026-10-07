import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';

import type { AuditOutcome } from '../admin/AdminControlPlaneRepository';
import { isHassState } from '../hass';
import { HOME_PRESETS } from '../home/devicePresets';
import { HomeCatalog } from '../home/HomeCatalog';
import { getRequestPrincipal, hasRequestPermission } from '../identity/requestIdentity';
import type { AppDeps } from '../server';

const deviceIdSchema = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/u);
const revisionSchema = z.string().regex(/^[a-f0-9]{16}$/u);
const actionSchema = z
  .object({
    deviceId: deviceIdSchema,
    action: z.enum([
      'turn_on',
      'turn_off',
      'toggle',
      'play_pause',
      'start',
      'return_to_base',
      'set_temperature',
      'open',
      'close',
      'stop',
    ]),
    value: z.number().finite().min(12).max(25).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.action === 'set_temperature' && value.value === undefined) {
      context.addIssue({ code: 'custom', message: 'temperature_required', path: ['value'] });
    }
    if (value.action !== 'set_temperature' && value.value !== undefined) {
      context.addIssue({ code: 'custom', message: 'unexpected_value', path: ['value'] });
    }
  });

const placementSchema = z
  .object({
    x: z.number().finite().min(-100).max(100),
    y: z.number().finite().min(-100).max(100),
    z: z.number().finite().min(0).max(10).default(0),
    rotationDeg: z.number().finite().min(-360).max(360).default(0),
    scale: z.number().finite().min(0.25).max(4).default(1),
  })
  .strict();

const deviceConfigurationSchema = z
  .object({
    expectedRevision: revisionSchema,
    roomId: z.string().min(1).max(80),
    entityId: z
      .string()
      .regex(/^[a-z_]+\.[a-z0-9_]+$/u)
      .optional(),
    name: z.string().trim().min(1).max(100),
    presetId: z.string().min(1).max(40),
    placement: placementSchema,
  })
  .strict();

const deleteConfigurationSchema = z.object({ expectedRevision: revisionSchema }).strict();

const allowedActions: Record<string, readonly string[]> = Object.fromEntries(
  HOME_PRESETS.map((preset) => [preset.domain, preset.capabilities])
);

function serviceFor(domain: string, action: string): string {
  if (domain === 'media_player' && action === 'play_pause') return 'media_play_pause';
  if (domain === 'cover' && ['open', 'close', 'stop'].includes(action)) return `${action}_cover`;
  return action;
}

function canEditHome(request: FastifyRequest): boolean {
  const principal = getRequestPrincipal(request);
  if (!principal) return true;
  if (principal.kind === 'user') return principal.roles.includes('owner');
  return !principal.permissions || principal.permissions.includes('admin');
}

function mutationError(error: unknown): { status: number; code: string } {
  const code = error instanceof Error ? error.message : 'home_config_update_failed';
  if (code === 'home_config_conflict') return { status: 409, code };
  if (code === 'home_device_not_found' || code === 'home_room_not_found') {
    return { status: 404, code };
  }
  if (code === 'home_config_read_only') return { status: 503, code };
  if (code.startsWith('home_')) return { status: 400, code };
  return { status: 500, code: 'home_config_update_failed' };
}

function recordHomeAudit(
  app: FastifyInstance,
  deps: AppDeps,
  request: FastifyRequest,
  input: {
    action: string;
    targetId: string;
    outcome: AuditOutcome;
    metadata?: Record<string, string | number | boolean | null>;
  }
): void {
  const principal = getRequestPrincipal(request);
  try {
    deps.adminAudit?.recordActorAudit({
      actorKind: principal?.kind ?? 'system',
      actorId:
        principal?.kind === 'user'
          ? principal.userId
          : principal?.kind === 'service'
            ? principal.serviceId
            : 'legacy-local',
      action: input.action,
      targetType: 'home.device',
      targetId: input.targetId,
      outcome: input.outcome,
      correlationId: request.id,
      metadata: input.metadata,
    });
  } catch (error) {
    app.log.error(
      { errorCode: error instanceof Error ? error.message : 'home_audit_failed', requestId: request.id },
      'home audit persistence failed'
    );
  }
}

export function registerHomeRoutes(app: FastifyInstance, deps: AppDeps): void {
  let catalog: HomeCatalog | null = null;
  try {
    catalog = new HomeCatalog(
      deps.env.HOME_CONFIG_ROOT,
      deps.env.ACTIVE_HOME_ID,
      deps.env.HOME_DATA_ROOT
    );
  } catch (error) {
    app.log.error(
      { errorCode: error instanceof Error ? error.message : 'home_config_invalid' },
      'home catalog unavailable'
    );
  }

  app.get('/v1/home', async (request, reply) => {
    if (!hasRequestPermission(request, 'home')) return reply.code(403).send({ error: 'forbidden' });
    if (!catalog) return reply.code(503).send({ error: 'home_config_unavailable' });
    reply.header('cache-control', 'no-store');
    const snapshot = await catalog.snapshot(deps.ha);
    const principal = getRequestPrincipal(request);
    const guestDomains = new Set(['light', 'media_player']);
    const visibleDevices = snapshot.devices.filter((device) => {
      if (
        device.domain === 'camera' &&
        principal?.permissions &&
        !principal.permissions.includes('cameras')
      )
        return false;
      return (
        principal?.kind !== 'user' ||
        !principal.roles.includes('guest') ||
        guestDomains.has(device.domain)
      );
    });
    const visibleIds = new Set(visibleDevices.map((device) => device.deviceId));
    return {
      ...snapshot,
      canEdit: canEditHome(request) && catalog.isWritable(),
      availableHomes: [{ homeId: snapshot.homeId, displayName: snapshot.displayName }],
      devices: visibleDevices,
      rooms: snapshot.rooms.map((room) => ({
        ...room,
        deviceIds: room.deviceIds.filter((id) => visibleIds.has(id)),
      })),
    };
  });

  app.get('/v1/home/configuration', async (request, reply) => {
    if (!catalog) return reply.code(503).send({ error: 'home_config_unavailable' });
    if (!hasRequestPermission(request, 'home') || !canEditHome(request)) {
      return reply.code(403).send({ error: 'forbidden' });
    }
    const rawStates = deps.ha ? await deps.ha.getStates().catch(() => []) : [];
    const compatibleDomains = new Set(HOME_PRESETS.map((preset) => preset.domain));
    const availableEntities = (Array.isArray(rawStates) ? rawStates : [])
      .filter(isHassState)
      .filter((state) => {
        const domain = state.entity_id.split('.')[0] ?? '';
        return compatibleDomains.has(domain) && !catalog?.hasEntityId(state.entity_id);
      })
      .map((state) => ({
        entityId: state.entity_id,
        domain: state.entity_id.split('.')[0] ?? '',
        name:
          state.attributes &&
          typeof state.attributes === 'object' &&
          typeof (state.attributes as Record<string, unknown>).friendly_name === 'string'
            ? String((state.attributes as Record<string, unknown>).friendly_name)
            : state.entity_id,
      }))
      .slice(0, 500);
    return {
      revision: catalog.getRevision(),
      presets: HOME_PRESETS,
      availableEntities,
      mappedEntities: catalog.getMappedEntities(),
    };
  });

  app.put<{ Params: { deviceId: string }; Body: unknown }>(
    '/v1/home/devices/:deviceId',
    async (request, reply) => {
      if (!catalog) return reply.code(503).send({ error: 'home_config_unavailable' });
      if (!hasRequestPermission(request, 'home') || !canEditHome(request)) {
        return reply.code(403).send({ error: 'forbidden' });
      }
      const deviceId = deviceIdSchema.safeParse(request.params.deviceId);
      const body = deviceConfigurationSchema.safeParse(request.body);
      if (!deviceId.success || !body.success) {
        return reply.code(400).send({ error: 'home_device_invalid' });
      }
      try {
        catalog.upsertDevice({ deviceId: deviceId.data, ...body.data });
        recordHomeAudit(app, deps, request, {
          action: 'home.device.upsert',
          targetId: deviceId.data,
          outcome: 'success',
          metadata: { roomId: body.data.roomId, presetId: body.data.presetId },
        });
        app.log.info(
          { auditAction: 'home.device.upsert', targetId: deviceId.data, requestId: request.id },
          'home configuration updated'
        );
        return reply.code(200).send(await catalog.snapshot(deps.ha));
      } catch (error) {
        const mapped = mutationError(error);
        recordHomeAudit(app, deps, request, {
          action: 'home.device.upsert',
          targetId: deviceId.data,
          outcome: 'failed',
          metadata: { errorCode: mapped.code },
        });
        return reply.code(mapped.status).send({ error: mapped.code });
      }
    }
  );

  app.delete<{ Params: { deviceId: string }; Body: unknown }>(
    '/v1/home/devices/:deviceId',
    async (request, reply) => {
      if (!catalog) return reply.code(503).send({ error: 'home_config_unavailable' });
      if (!hasRequestPermission(request, 'home') || !canEditHome(request)) {
        return reply.code(403).send({ error: 'forbidden' });
      }
      const deviceId = deviceIdSchema.safeParse(request.params.deviceId);
      const body = deleteConfigurationSchema.safeParse(request.body);
      if (!deviceId.success || !body.success) {
        return reply.code(400).send({ error: 'home_device_invalid' });
      }
      try {
        catalog.deleteDevice(deviceId.data, body.data.expectedRevision);
        recordHomeAudit(app, deps, request, {
          action: 'home.device.delete',
          targetId: deviceId.data,
          outcome: 'success',
        });
        app.log.info(
          { auditAction: 'home.device.delete', targetId: deviceId.data, requestId: request.id },
          'home configuration updated'
        );
        return reply.code(204).send();
      } catch (error) {
        const mapped = mutationError(error);
        recordHomeAudit(app, deps, request, {
          action: 'home.device.delete',
          targetId: deviceId.data,
          outcome: 'failed',
          metadata: { errorCode: mapped.code },
        });
        return reply.code(mapped.status).send({ error: mapped.code });
      }
    }
  );

  app.post('/v1/home/actions', async (request, reply) => {
    const parsed = actionSchema.safeParse(request.body);
    if (!hasRequestPermission(request, 'home')) {
      recordHomeAudit(app, deps, request, {
        action: parsed.success ? `home.action.${parsed.data.action}` : 'home.action.request',
        targetId: parsed.success ? parsed.data.deviceId : 'unknown',
        outcome: 'denied',
        metadata: { errorCode: 'forbidden' },
      });
      return reply.code(403).send({ error: 'forbidden' });
    }
    if (!deps.ha) return reply.code(503).send({ error: 'ha_not_configured' });
    if (!catalog) return reply.code(503).send({ error: 'home_config_unavailable' });
    if (!parsed.success) return reply.code(400).send({ error: 'home_action_invalid' });
    const mapping = catalog.getMapping(parsed.data.deviceId);
    if (!mapping) return reply.code(404).send({ error: 'home_device_not_found' });
    if (!mapping.entityId) return reply.code(409).send({ error: 'home_device_not_mapped' });
    const domain = mapping.entityId.split('.')[0] ?? '';
    if (!allowedActions[domain]?.includes(parsed.data.action)) {
      return reply.code(400).send({ error: 'home_action_unsupported' });
    }
    const principal = getRequestPrincipal(request);
    if (
      principal?.kind === 'user' &&
      principal.roles.includes('guest') &&
      !['light', 'media_player'].includes(domain)
    ) {
      recordHomeAudit(app, deps, request, {
        action: `home.action.${parsed.data.action}`,
        targetId: parsed.data.deviceId,
        outcome: 'denied',
        metadata: { domain },
      });
      return reply.code(403).send({ error: 'guest_action_forbidden' });
    }
    const serviceData =
      parsed.data.action === 'set_temperature' ? { temperature: parsed.data.value } : undefined;
    try {
      await deps.ha.callService({
        domain,
        service: serviceFor(domain, parsed.data.action),
        target: { entity_id: mapping.entityId },
        serviceData,
      });
    } catch {
      recordHomeAudit(app, deps, request, {
        action: `home.action.${parsed.data.action}`,
        targetId: parsed.data.deviceId,
        outcome: 'failed',
        metadata: { domain, errorCode: 'home_assistant_unavailable' },
      });
      return reply.code(502).send({ error: 'home_assistant_unavailable' });
    }
    recordHomeAudit(app, deps, request, {
      action: `home.action.${parsed.data.action}`,
      targetId: parsed.data.deviceId,
      outcome: 'success',
      metadata: { domain },
    });
    return reply.code(200).send({ status: 'ok', deviceId: parsed.data.deviceId });
  });
}
