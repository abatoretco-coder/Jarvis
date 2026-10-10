import { randomUUID } from 'node:crypto';

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

import type { AuditOutcome } from '../admin/AdminControlPlaneRepository';
import { isHassState } from '../hass';
import { HOME_PRESETS } from '../home/devicePresets';
import { executeCatalogHomeAction, executeCatalogHomeScene } from '../home/HomeActionExecutor';
import { HomeAssistantAutomationService } from '../home/HomeAssistantAutomationService';
import { HomeCatalog } from '../home/HomeCatalog';
import { getRequestPrincipal, hasRequestPermission } from '../identity/requestIdentity';
import type { AppDeps } from '../server';

const deviceIdSchema = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/u);
const revisionSchema = z.string().regex(/^[a-f0-9]{16}$/u);
const actionNameSchema = z.enum([
  'turn_on',
  'turn_off',
  'toggle',
  'play_pause',
  'start',
  'return_to_base',
  'locate',
  'set_suction_mode',
  'set_mop_mode',
  'set_temperature',
  'set_hvac_mode',
  'set_preset_mode',
  'set_temperature_offset',
  'set_child_lock',
  'set_preheating',
  'set_operation_mode',
  'set_away_mode',
  'set_eco_mode',
  'set_boost_mode',
  'set_antilegionella',
  'open',
  'close',
  'stop',
  'set_brightness',
  'set_volume',
  'volume_up',
  'volume_down',
  'mute',
  'unmute',
  'media_play',
  'media_pause',
  'media_stop',
  'media_next',
  'media_previous',
  'play_channel',
  'select_source',
  'select_sound_output',
  'remote_key',
  'empty_dust_bin',
  'wash_mop',
  'start_mop_drying',
  'stop_mop_drying',
]);
const actionSchema = z
  .object({
    deviceId: deviceIdSchema,
    action: actionNameSchema,
    value: z.number().finite().min(-10).max(100).optional(),
    option: z.string().trim().min(1).max(120).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    const needsValue = ['set_temperature', 'set_temperature_offset', 'set_brightness', 'set_volume'].includes(value.action);
    const needsOption = ['select_source', 'select_sound_output', 'remote_key', 'set_suction_mode', 'set_mop_mode', 'play_channel', 'set_hvac_mode', 'set_preset_mode', 'set_child_lock', 'set_preheating', 'set_operation_mode', 'set_away_mode', 'set_eco_mode', 'set_boost_mode', 'set_antilegionella'].includes(value.action);
    if (needsValue && value.value === undefined) {
      context.addIssue({ code: 'custom', message: 'value_required', path: ['value'] });
    }
    if (value.action === 'set_temperature' && value.value !== undefined && (value.value < 5 || value.value > 80)) {
      context.addIssue({ code: 'custom', message: 'temperature_invalid', path: ['value'] });
    }
    if (!needsValue && value.value !== undefined) {
      context.addIssue({ code: 'custom', message: 'unexpected_value', path: ['value'] });
    }
    if (needsOption && value.option === undefined) {
      context.addIssue({ code: 'custom', message: 'option_required', path: ['option'] });
    }
    if (['set_child_lock', 'set_preheating', 'set_away_mode', 'set_eco_mode', 'set_boost_mode', 'set_antilegionella'].includes(value.action) && !['on', 'off'].includes(value.option ?? '')) {
      context.addIssue({ code: 'custom', message: 'switch_option_invalid', path: ['option'] });
    }
    if (!needsOption && value.option !== undefined) {
      context.addIssue({ code: 'custom', message: 'unexpected_option', path: ['option'] });
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
const quickActionSchema = z
  .object({
    expectedRevision: revisionSchema,
    name: z.string().trim().min(1).max(60),
    icon: z.enum(['light', 'climate', 'media', 'vacuum', 'home']),
    deviceId: deviceIdSchema,
    action: actionNameSchema,
    value: z.number().finite().min(-10).max(100).optional(),
    option: z.string().trim().min(1).max(120).optional(),
    voicePhrases: z.array(z.string().trim().min(2).max(80)).max(5).default([]),
    sortOrder: z.number().int().min(0).max(999).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    const needsValue = ['set_temperature', 'set_temperature_offset', 'set_brightness', 'set_volume'].includes(value.action);
    const needsOption = ['select_source', 'select_sound_output', 'remote_key', 'set_suction_mode', 'set_mop_mode', 'play_channel', 'set_hvac_mode', 'set_preset_mode', 'set_child_lock', 'set_preheating', 'set_operation_mode', 'set_away_mode', 'set_eco_mode', 'set_boost_mode', 'set_antilegionella'].includes(value.action);
    if (needsValue && value.value === undefined) {
      context.addIssue({ code: 'custom', message: 'value_required', path: ['value'] });
    }
    if (value.action === 'set_temperature' && value.value !== undefined && (value.value < 5 || value.value > 80)) {
      context.addIssue({ code: 'custom', message: 'temperature_invalid', path: ['value'] });
    }
    if (!needsValue && value.value !== undefined) {
      context.addIssue({ code: 'custom', message: 'unexpected_value', path: ['value'] });
    }
    if (needsOption && value.option === undefined) {
      context.addIssue({ code: 'custom', message: 'option_required', path: ['option'] });
    }
    if (['set_child_lock', 'set_preheating', 'set_away_mode', 'set_eco_mode', 'set_boost_mode', 'set_antilegionella'].includes(value.action) && !['on', 'off'].includes(value.option ?? '')) {
      context.addIssue({ code: 'custom', message: 'switch_option_invalid', path: ['option'] });
    }
    if (!needsOption && value.option !== undefined) {
      context.addIssue({ code: 'custom', message: 'unexpected_option', path: ['option'] });
    }
  });
const sceneSchema = z
  .object({
    expectedRevision: revisionSchema,
    name: z.string().trim().min(1).max(60),
    icon: z.enum(['light', 'climate', 'media', 'vacuum', 'home']),
    quickActionIds: z.array(deviceIdSchema).min(2).max(20),
    voicePhrases: z.array(z.string().trim().min(2).max(80)).max(5).default([]),
  })
  .strict();
const automationIdSchema = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,127}$/u);
const managedAutomationSchema = z
  .object({
    name: z.string().trim().min(1).max(60),
    sceneId: deviceIdSchema,
    at: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/u),
    weekdays: z.array(z.number().int().min(1).max(7)).min(1).max(7),
    enabled: z.boolean().default(true),
  })
  .strict();
const automationStateSchema = z.object({ enabled: z.boolean() }).strict();
const robotParamsSchema = z.object({ deviceId: deviceIdSchema });
const robotQuerySchema = z.object({ days: z.coerce.number().int().min(1).max(30).default(14) });
const robotCleanSchema = z.object({
  rooms: z.array(z.number().int().positive()).min(1).max(20),
  repeat: z.number().int().min(1).max(3).default(1),
  suction: z.number().int().min(0).max(3),
  water: z.number().int().min(1).max(3),
}).strict();

type RobotRoom = { segmentId: number; name: string };

function parseRobotRooms(payload: unknown): RobotRoom[] {
  const response = payload as { service_response?: { devices?: Record<string, { rooms?: unknown[] }> } };
  const devices = response?.service_response?.devices;
  if (!devices || typeof devices !== 'object') return [];
  return Object.values(devices).flatMap((device) =>
    Array.isArray(device.rooms) ? device.rooms.flatMap((room) => {
      const item = room as { segment_id?: unknown; name?: unknown };
      return Number.isInteger(item.segment_id) && Number(item.segment_id) > 0 && typeof item.name === 'string'
        ? [{ segmentId: Number(item.segment_id), name: item.name }]
        : [];
    }) : []
  );
}

function parseRobotHistory(payload: unknown, end: Date) {
  const states = Array.isArray(payload) && Array.isArray(payload[0]) ? payload[0] : [];
  const sessions: Array<{ startedAt: string; endedAt?: string; durationMinutes: number; status: string }> = [];
  let startedAt: Date | null = null;
  for (const raw of states) {
    if (!raw || typeof raw !== 'object') continue;
    const item = raw as { state?: unknown; last_changed?: unknown };
    if (typeof item.state !== 'string' || typeof item.last_changed !== 'string') continue;
    const changedAt = new Date(item.last_changed);
    if (!Number.isFinite(changedAt.getTime())) continue;
    if (item.state === 'cleaning' && !startedAt) startedAt = changedAt;
    if (item.state !== 'cleaning' && startedAt) {
      sessions.push({
        startedAt: startedAt.toISOString(),
        endedAt: changedAt.toISOString(),
        durationMinutes: Math.max(0, Math.round((changedAt.getTime() - startedAt.getTime()) / 60_000)),
        status: item.state === 'error' ? 'error' : 'completed',
      });
      startedAt = null;
    }
  }
  if (startedAt) sessions.push({
    startedAt: startedAt.toISOString(),
    durationMinutes: Math.max(0, Math.round((end.getTime() - startedAt.getTime()) / 60_000)),
    status: 'running',
  });
  return sessions.reverse().slice(0, 50);
}

function canEditHome(request: FastifyRequest): boolean {
  const principal = getRequestPrincipal(request);
  if (!principal) return true;
  if (principal.kind === 'user') return principal.roles.includes('owner');
  return principal.permissions.includes('admin');
}

function canViewAutomations(request: FastifyRequest): boolean {
  const principal = getRequestPrincipal(request);
  if (!principal) return true;
  if (principal.kind === 'service') return principal.permissions.includes('home');
  return !principal.roles.includes('guest');
}

function mutationError(error: unknown): { status: number; code: string } {
  const code = error instanceof Error ? error.message : 'home_config_update_failed';
  if (code === 'home_config_conflict') return { status: 409, code };
  if (code === 'home_device_not_found' || code === 'home_room_not_found') {
    return { status: 404, code };
  }
  if (code === 'home_quick_action_not_found') return { status: 404, code };
  if (code === 'home_scene_not_found' || code === 'home_routine_not_found') {
    return { status: 404, code };
  }
  if (code === 'home_automation_not_found') return { status: 404, code };
  if (code === 'home_automation_not_managed') return { status: 409, code };
  if (code === 'home_automation_invalid') return { status: 400, code };
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
    targetType?:
      | 'home.device'
      | 'home.quick_action'
      | 'home.scene'
      | 'home.routine'
      | 'home.automation';
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
      targetType: input.targetType ?? 'home.device',
      targetId: input.targetId,
      outcome: input.outcome,
      correlationId: request.id,
      metadata: input.metadata,
    });
  } catch (error) {
    app.log.error(
      {
        errorCode: error instanceof Error ? error.message : 'home_audit_failed',
        requestId: request.id,
      },
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
  deps.homeCatalog = catalog ?? undefined;
  const automationService =
    catalog && deps.ha ? new HomeAssistantAutomationService(deps.ha, catalog) : null;

  async function executeHomeAction(
    request: FastifyRequest,
    reply: FastifyReply,
    input: z.infer<typeof actionSchema>,
    auditTargetId = input.deviceId,
    auditTargetType: 'home.device' | 'home.quick_action' = 'home.device'
  ) {
    if (!hasRequestPermission(request, 'home')) {
      recordHomeAudit(app, deps, request, {
        action: `home.action.${input.action}`,
        targetType: auditTargetType,
        targetId: auditTargetId,
        outcome: 'denied',
        metadata: { errorCode: 'forbidden' },
      });
      return reply.code(403).send({ error: 'forbidden' });
    }
    if (!catalog) return reply.code(503).send({ error: 'home_config_unavailable' });
    const principal = getRequestPrincipal(request);
    const result = await executeCatalogHomeAction({
      catalog,
      ha: deps.ha,
      principal,
      command: input,
    });
    if (!result.ok) {
      recordHomeAudit(app, deps, request, {
        action: `home.action.${input.action}`,
        targetType: auditTargetType,
        targetId: auditTargetId,
        outcome: result.status === 403 ? 'denied' : 'failed',
        metadata: {
          ...(result.domain ? { domain: result.domain } : {}),
          errorCode: result.code,
        },
      });
      return reply.code(result.status).send({ error: result.code });
    }
    recordHomeAudit(app, deps, request, {
      action: `home.action.${input.action}`,
      targetType: auditTargetType,
      targetId: auditTargetId,
      outcome: 'success',
      metadata: { domain: result.domain },
    });
    return reply.code(200).send({ status: 'ok', deviceId: input.deviceId });
  }

  app.get('/v1/home', async (request, reply) => {
    if (!hasRequestPermission(request, 'home')) return reply.code(403).send({ error: 'forbidden' });
    if (!catalog) return reply.code(503).send({ error: 'home_config_unavailable' });
    reply.header('cache-control', 'no-store');
    const snapshot = await catalog.snapshot(deps.ha);
    if (snapshot.controlStatus !== 'ready') {
      app.log.debug({ controlStatus: snapshot.controlStatus }, 'home control unavailable');
    }
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
    const visibleScenes = snapshot.scenes.filter((scene) =>
      scene.steps.every((step) => visibleIds.has(step.deviceId))
    );
    const visibleSceneIds = new Set(visibleScenes.map((scene) => scene.sceneId));
    return {
      ...snapshot,
      canEdit: canEditHome(request) && catalog.isWritable(),
      availableHomes: [{ homeId: snapshot.homeId, displayName: snapshot.displayName }],
      devices: visibleDevices,
      quickActions: snapshot.quickActions.filter((action) => visibleIds.has(action.deviceId)),
      scenes: visibleScenes,
      routines: snapshot.routines.filter((routine) => visibleSceneIds.has(routine.sceneId)),
      rooms: snapshot.rooms.map((room) => ({
        ...room,
        deviceIds: room.deviceIds.filter((id) => visibleIds.has(id)),
      })),
    };
  });

  app.get('/v1/home/lights', async (request, reply) => {
    if (!hasRequestPermission(request, 'home')) return reply.code(403).send({ error: 'forbidden' });
    if (!catalog) return reply.code(503).send({ error: 'home_config_unavailable' });
    reply.header('cache-control', 'no-store');
    const snapshot = await catalog.snapshot(deps.ha);
    return {
      devices: snapshot.devices
        .filter((device) => device.domain === 'light')
        .map((device) => ({
          deviceId: device.deviceId,
          domain: device.domain,
          name: device.name,
          state: device.state,
          available: device.available,
          mapped: device.mapped,
          roomId: device.roomId,
        })),
    };
  });

  app.get('/v1/home/devices/:deviceId/robot', async (request, reply) => {
    if (!hasRequestPermission(request, 'home') || !canViewAutomations(request)) {
      return reply.code(403).send({ error: 'forbidden' });
    }
    if (!catalog || !deps.ha) return reply.code(503).send({ error: 'home_assistant_unavailable' });
    const params = robotParamsSchema.safeParse(request.params);
    const query = robotQuerySchema.safeParse(request.query);
    if (!params.success || !query.success) return reply.code(400).send({ error: 'robot_request_invalid' });
    const mapping = catalog.getMapping(params.data.deviceId);
    if (!mapping?.entityId || !mapping.entityId.startsWith('vacuum.')) {
      return reply.code(404).send({ error: 'robot_not_found' });
    }
    const end = new Date();
    const start = new Date(end.getTime() - query.data.days * 86_400_000);
    const [historyResult, roomsResult] = await Promise.allSettled([
      deps.ha.getHistory(mapping.entityId, start, end),
      deps.ha.callService({ domain: 'xiaomi_vacuum_local', service: 'get_rooms', returnResponse: true }),
    ]);
    return reply.send({
      rooms: roomsResult.status === 'fulfilled' ? parseRobotRooms(roomsResult.value.data) : [],
      roomCleaningAvailable: roomsResult.status === 'fulfilled' && parseRobotRooms(roomsResult.value.data).length > 0,
      history: historyResult.status === 'fulfilled' ? parseRobotHistory(historyResult.value, end) : [],
      historyAvailable: historyResult.status === 'fulfilled',
    });
  });

  app.post('/v1/home/devices/:deviceId/robot/clean', async (request, reply) => {
    if (!hasRequestPermission(request, 'home') || !canViewAutomations(request)) {
      return reply.code(403).send({ error: 'forbidden' });
    }
    if (!catalog || !deps.ha) return reply.code(503).send({ error: 'home_assistant_unavailable' });
    const params = robotParamsSchema.safeParse(request.params);
    const body = robotCleanSchema.safeParse(request.body);
    if (!params.success || !body.success) return reply.code(400).send({ error: 'robot_clean_invalid' });
    const mapping = catalog.getMapping(params.data.deviceId);
    if (!mapping?.entityId || !mapping.entityId.startsWith('vacuum.')) {
      return reply.code(404).send({ error: 'robot_not_found' });
    }
    try {
      const roomResponse = await deps.ha.callService({
        domain: 'xiaomi_vacuum_local', service: 'get_rooms', returnResponse: true,
      });
      const known = new Set(parseRobotRooms(roomResponse.data).map((room) => room.segmentId));
      if (known.size === 0) return reply.code(409).send({ error: 'robot_rooms_unavailable' });
      if (body.data.rooms.some((room) => !known.has(room))) {
        return reply.code(400).send({ error: 'robot_room_unknown' });
      }
      await deps.ha.callService({
        domain: 'xiaomi_vacuum_local',
        service: 'clean_rooms',
        serviceData: body.data,
        returnResponse: true,
      });
      return reply.send({ status: 'ok' });
    } catch (error) {
      app.log.warn({ errorCode: error instanceof Error ? error.message : 'robot_connector_failed' }, 'robot room clean failed');
      return reply.code(502).send({ error: 'robot_connector_failed' });
    }
  });

  app.get('/v1/home/automations', async (request, reply) => {
    if (!hasRequestPermission(request, 'home') || !canViewAutomations(request)) {
      return reply.code(403).send({ error: 'forbidden' });
    }
    if (!automationService) {
      return reply.code(503).send({ error: 'home_assistant_not_configured' });
    }
    try {
      reply.header('cache-control', 'no-store');
      return reply.code(200).send({
        items: await automationService.list(),
        canManage: canEditHome(request),
      });
    } catch {
      return reply.code(502).send({ error: 'home_assistant_unavailable' });
    }
  });

  app.post('/v1/home/automations', async (request, reply) => {
    if (!hasRequestPermission(request, 'home') || !canEditHome(request)) {
      recordHomeAudit(app, deps, request, {
        action: 'home.automation.create',
        targetType: 'home.automation',
        targetId: 'new',
        outcome: 'denied',
        metadata: { errorCode: 'forbidden' },
      });
      return reply.code(403).send({ error: 'forbidden' });
    }
    if (!automationService) {
      return reply.code(503).send({ error: 'home_assistant_not_configured' });
    }
    const parsed = managedAutomationSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'home_automation_invalid' });
    try {
      const created = await automationService.create(parsed.data);
      recordHomeAudit(app, deps, request, {
        action: 'home.automation.create',
        targetType: 'home.automation',
        targetId: created.automationId,
        outcome: 'success',
        metadata: { sceneId: parsed.data.sceneId },
      });
      return reply.code(201).send(created);
    } catch (error) {
      const mapped = mutationError(error);
      return reply
        .code(mapped.status === 500 ? 502 : mapped.status)
        .send({ error: mapped.status === 500 ? 'home_assistant_unavailable' : mapped.code });
    }
  });

  app.put<{ Params: { automationId: string }; Body: unknown }>(
    '/v1/home/automations/:automationId',
    async (request, reply) => {
      if (!hasRequestPermission(request, 'home') || !canEditHome(request)) {
        return reply.code(403).send({ error: 'forbidden' });
      }
      if (!automationService) {
        return reply.code(503).send({ error: 'home_assistant_not_configured' });
      }
      const id = automationIdSchema.safeParse(request.params.automationId);
      const body = managedAutomationSchema.safeParse(request.body);
      if (!id.success || !body.success) {
        return reply.code(400).send({ error: 'home_automation_invalid' });
      }
      try {
        await automationService.update(id.data, body.data);
        recordHomeAudit(app, deps, request, {
          action: 'home.automation.update',
          targetType: 'home.automation',
          targetId: id.data,
          outcome: 'success',
          metadata: { sceneId: body.data.sceneId },
        });
        return reply.code(200).send({ status: 'ok' });
      } catch (error) {
        const mapped = mutationError(error);
        return reply
          .code(mapped.status === 500 ? 502 : mapped.status)
          .send({ error: mapped.status === 500 ? 'home_assistant_unavailable' : mapped.code });
      }
    }
  );

  app.patch<{ Params: { automationId: string }; Body: unknown }>(
    '/v1/home/automations/:automationId/state',
    async (request, reply) => {
      if (!hasRequestPermission(request, 'home') || !canEditHome(request)) {
        return reply.code(403).send({ error: 'forbidden' });
      }
      if (!automationService) {
        return reply.code(503).send({ error: 'home_assistant_not_configured' });
      }
      const id = automationIdSchema.safeParse(request.params.automationId);
      const body = automationStateSchema.safeParse(request.body);
      if (!id.success || !body.success) {
        return reply.code(400).send({ error: 'home_automation_invalid' });
      }
      try {
        await automationService.setEnabled(id.data, body.data.enabled);
        recordHomeAudit(app, deps, request, {
          action: body.data.enabled ? 'home.automation.enable' : 'home.automation.disable',
          targetType: 'home.automation',
          targetId: id.data,
          outcome: 'success',
        });
        return reply.code(200).send({ status: 'ok' });
      } catch (error) {
        const mapped = mutationError(error);
        return reply
          .code(mapped.status === 500 ? 502 : mapped.status)
          .send({ error: mapped.status === 500 ? 'home_assistant_unavailable' : mapped.code });
      }
    }
  );

  app.post<{ Params: { automationId: string } }>(
    '/v1/home/automations/:automationId/run',
    async (request, reply) => {
      if (!hasRequestPermission(request, 'home') || !canEditHome(request)) {
        return reply.code(403).send({ error: 'forbidden' });
      }
      if (!automationService) {
        return reply.code(503).send({ error: 'home_assistant_not_configured' });
      }
      const id = automationIdSchema.safeParse(request.params.automationId);
      if (!id.success) return reply.code(400).send({ error: 'home_automation_invalid' });
      try {
        await automationService.run(id.data);
        recordHomeAudit(app, deps, request, {
          action: 'home.automation.run',
          targetType: 'home.automation',
          targetId: id.data,
          outcome: 'success',
        });
        return reply.code(200).send({ status: 'ok' });
      } catch (error) {
        const mapped = mutationError(error);
        return reply
          .code(mapped.status === 500 ? 502 : mapped.status)
          .send({ error: mapped.status === 500 ? 'home_assistant_unavailable' : mapped.code });
      }
    }
  );

  app.delete<{ Params: { automationId: string } }>(
    '/v1/home/automations/:automationId',
    async (request, reply) => {
      if (!hasRequestPermission(request, 'home') || !canEditHome(request)) {
        return reply.code(403).send({ error: 'forbidden' });
      }
      if (!automationService) {
        return reply.code(503).send({ error: 'home_assistant_not_configured' });
      }
      const id = automationIdSchema.safeParse(request.params.automationId);
      if (!id.success) return reply.code(400).send({ error: 'home_automation_invalid' });
      try {
        await automationService.delete(id.data);
        recordHomeAudit(app, deps, request, {
          action: 'home.automation.delete',
          targetType: 'home.automation',
          targetId: id.data,
          outcome: 'success',
        });
        return reply.code(204).send();
      } catch (error) {
        const mapped = mutationError(error);
        return reply
          .code(mapped.status === 500 ? 502 : mapped.status)
          .send({ error: mapped.status === 500 ? 'home_assistant_unavailable' : mapped.code });
      }
    }
  );

  app.get('/v1/home/configuration', async (request, reply) => {
    if (!catalog) return reply.code(503).send({ error: 'home_config_unavailable' });
    if (!hasRequestPermission(request, 'home') || !canEditHome(request)) {
      return reply.code(403).send({ error: 'forbidden' });
    }
    if (!deps.ha) return reply.code(502).send({ error: 'home_assistant_unavailable' });
    let rawStates: unknown;
    try {
      rawStates = await deps.ha.getStates();
    } catch (error) {
      app.log.warn(
        { errorCode: error instanceof Error ? error.message : 'home_assistant_unavailable' },
        'home configuration states unavailable'
      );
      return reply.code(502).send({ error: 'home_assistant_unavailable' });
    }
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
    if (!parsed.success) return reply.code(400).send({ error: 'home_action_invalid' });
    return executeHomeAction(request, reply, parsed.data);
  });

  app.post('/v1/home/quick-actions', async (request, reply) => {
    if (!catalog) return reply.code(503).send({ error: 'home_config_unavailable' });
    if (!hasRequestPermission(request, 'home') || !canEditHome(request)) {
      return reply.code(403).send({ error: 'forbidden' });
    }
    const parsed = quickActionSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'home_quick_action_invalid' });
    const quickActionId = `action-${randomUUID()}`;
    try {
      catalog.upsertQuickAction({ quickActionId, ...parsed.data });
      recordHomeAudit(app, deps, request, {
        action: 'home.quick_action.create',
        targetType: 'home.quick_action',
        targetId: quickActionId,
        outcome: 'success',
      });
      return reply.code(201).send({
        revision: catalog.getRevision(),
        quickAction: catalog.getQuickAction(quickActionId),
      });
    } catch (error) {
      const mapped = mutationError(error);
      return reply.code(mapped.status).send({ error: mapped.code });
    }
  });

  app.delete<{ Params: { quickActionId: string }; Body: unknown }>(
    '/v1/home/quick-actions/:quickActionId',
    async (request, reply) => {
      if (!catalog) return reply.code(503).send({ error: 'home_config_unavailable' });
      if (!hasRequestPermission(request, 'home') || !canEditHome(request)) {
        return reply.code(403).send({ error: 'forbidden' });
      }
      const id = deviceIdSchema.safeParse(request.params.quickActionId);
      const body = deleteConfigurationSchema.safeParse(request.body);
      if (!id.success || !body.success) {
        return reply.code(400).send({ error: 'home_quick_action_invalid' });
      }
      try {
        catalog.deleteQuickAction(id.data, body.data.expectedRevision);
        recordHomeAudit(app, deps, request, {
          action: 'home.quick_action.delete',
          targetType: 'home.quick_action',
          targetId: id.data,
          outcome: 'success',
        });
        return reply.code(204).send();
      } catch (error) {
        const mapped = mutationError(error);
        return reply.code(mapped.status).send({ error: mapped.code });
      }
    }
  );

  app.post<{ Params: { quickActionId: string } }>(
    '/v1/home/quick-actions/:quickActionId/run',
    async (request, reply) => {
      if (!hasRequestPermission(request, 'home')) {
        return reply.code(403).send({ error: 'forbidden' });
      }
      if (!catalog) return reply.code(503).send({ error: 'home_config_unavailable' });
      const id = deviceIdSchema.safeParse(request.params.quickActionId);
      if (!id.success) return reply.code(400).send({ error: 'home_quick_action_invalid' });
      const quickAction = catalog.getQuickAction(id.data);
      if (!quickAction) return reply.code(404).send({ error: 'home_quick_action_not_found' });
      return executeHomeAction(
        request,
        reply,
        quickAction,
        quickAction.quickActionId,
        'home.quick_action'
      );
    }
  );

  app.post('/v1/home/scenes', async (request, reply) => {
    if (!catalog) return reply.code(503).send({ error: 'home_config_unavailable' });
    if (!hasRequestPermission(request, 'home') || !canEditHome(request)) {
      return reply.code(403).send({ error: 'forbidden' });
    }
    const parsed = sceneSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'home_scene_invalid' });
    const actions = parsed.data.quickActionIds.map((id) => catalog?.getQuickAction(id));
    if (actions.some((action) => !action)) {
      return reply.code(400).send({ error: 'home_scene_invalid' });
    }
    const sceneId = `scene-${randomUUID()}`;
    try {
      catalog.upsertScene({
        sceneId,
        expectedRevision: parsed.data.expectedRevision,
        name: parsed.data.name,
        icon: parsed.data.icon,
        voicePhrases: parsed.data.voicePhrases,
        steps: actions.map((action) => ({
          deviceId: action!.deviceId,
          action: action!.action,
          ...(action!.value === undefined ? {} : { value: action!.value }),
          ...(action!.option === undefined ? {} : { option: action!.option }),
        })),
      });
      recordHomeAudit(app, deps, request, {
        action: 'home.scene.create',
        targetType: 'home.scene',
        targetId: sceneId,
        outcome: 'success',
        metadata: { stepCount: actions.length },
      });
      return reply.code(201).send({ revision: catalog.getRevision(), scene: catalog.getScene(sceneId) });
    } catch (error) {
      const mapped = mutationError(error);
      return reply.code(mapped.status).send({ error: mapped.code });
    }
  });

  app.post<{ Params: { sceneId: string } }>('/v1/home/scenes/:sceneId/run', async (request, reply) => {
    if (!hasRequestPermission(request, 'home')) return reply.code(403).send({ error: 'forbidden' });
    if (!catalog) return reply.code(503).send({ error: 'home_config_unavailable' });
    const id = deviceIdSchema.safeParse(request.params.sceneId);
    const scene = id.success ? catalog.getScene(id.data) : undefined;
    if (!scene) return reply.code(404).send({ error: 'home_scene_not_found' });
    const result = await executeCatalogHomeScene({
      catalog,
      scene,
      ha: deps.ha,
      principal: getRequestPrincipal(request),
    });
    recordHomeAudit(app, deps, request, {
      action: 'home.scene.run',
      targetType: 'home.scene',
      targetId: scene.sceneId,
      outcome: result.status === 'success' ? 'success' : 'failed',
      metadata: { status: result.status, failedSteps: result.steps.filter((step) => step.status === 'failed').length },
    });
    const failureStatus =
      result.errorCode === 'guest_action_forbidden'
        ? 403
        : result.errorCode === 'home_device_not_mapped'
          ? 409
          : result.errorCode === 'home_action_unsupported'
            ? 400
            : 502;
    return reply.code(result.status === 'failed' ? failureStatus : 200).send(result);
  });

  app.delete<{ Params: { sceneId: string }; Body: unknown }>(
    '/v1/home/scenes/:sceneId',
    async (request, reply) => {
      if (!catalog) return reply.code(503).send({ error: 'home_config_unavailable' });
      if (!hasRequestPermission(request, 'home') || !canEditHome(request)) return reply.code(403).send({ error: 'forbidden' });
      const id = deviceIdSchema.safeParse(request.params.sceneId);
      const body = deleteConfigurationSchema.safeParse(request.body);
      if (!id.success || !body.success) return reply.code(400).send({ error: 'home_scene_invalid' });
      try {
        catalog.deleteScene(id.data, body.data.expectedRevision);
        recordHomeAudit(app, deps, request, {
          action: 'home.scene.delete',
          targetType: 'home.scene',
          targetId: id.data,
          outcome: 'success',
        });
        return reply.code(204).send();
      } catch (error) {
        const mapped = mutationError(error);
        return reply.code(mapped.status).send({ error: mapped.code });
      }
    }
  );

  app.post('/v1/home/routines', async (_request, reply) => {
    return reply.code(410).send({ error: 'home_routines_moved_to_home_assistant' });
  });

  app.delete<{ Params: { routineId: string }; Body: unknown }>(
    '/v1/home/routines/:routineId',
    async (request, reply) => {
      if (!catalog) return reply.code(503).send({ error: 'home_config_unavailable' });
      if (!hasRequestPermission(request, 'home') || !canEditHome(request)) return reply.code(403).send({ error: 'forbidden' });
      const id = deviceIdSchema.safeParse(request.params.routineId);
      const body = deleteConfigurationSchema.safeParse(request.body);
      if (!id.success || !body.success) return reply.code(400).send({ error: 'home_routine_invalid' });
      try {
        catalog.deleteRoutine(id.data, body.data.expectedRevision);
        recordHomeAudit(app, deps, request, {
          action: 'home.routine.delete',
          targetType: 'home.routine',
          targetId: id.data,
          outcome: 'success',
        });
        return reply.code(204).send();
      } catch (error) {
        const mapped = mutationError(error);
        return reply.code(mapped.status).send({ error: mapped.code });
      }
    }
  );
}
