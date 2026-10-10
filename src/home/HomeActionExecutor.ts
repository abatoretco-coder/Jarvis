import type { HomeAssistantClient, HomeAssistantServiceCall } from '../haClient';
import { isHassState } from '../hass';
import { isStreamDeckHomeActionAllowed, isStreamDeckPrincipal } from '../identity/oidcClientPolicy';
import type { RequestPrincipal } from '../identity/requestIdentity';
import { HOME_PRESETS } from './devicePresets';
import { type HomeActionName, type HomeCatalog, type HomeScene, TV_REMOTE_KEYS } from './HomeCatalog';
import { ensureTelevisionReady } from './TelevisionReadiness';

export type ExecutableHomeAction = {
  deviceId: string;
  action: HomeActionName;
  value?: number;
  option?: string;
};

export type HomeActionExecution =
  | { ok: true; domain: string }
  | {
      ok: false;
      status: 400 | 403 | 404 | 409 | 502 | 503;
      code:
        | 'home_device_not_found'
        | 'home_device_not_mapped'
        | 'home_action_unsupported'
        | 'home_action_option_invalid'
        | 'client_scope_forbidden'
        | 'guest_action_forbidden'
        | 'home_device_state_timeout'
        | 'home_control_unavailable';
      domain?: string;
    };

const allowedActions: Record<string, readonly string[]> = Object.fromEntries(
  HOME_PRESETS.map((preset) => [preset.domain, preset.capabilities])
);

function serviceFor(domain: string, action: string): string {
  if (domain === 'media_player' && action === 'play_pause') return 'media_play_pause';
  if (domain === 'cover' && ['open', 'close', 'stop'].includes(action)) return `${action}_cover`;
  if (domain === 'light' && action === 'set_brightness') return 'turn_on';
  if (domain === 'media_player' && action === 'set_volume') return 'volume_set';
  if (domain === 'media_player' && action === 'media_next') return 'media_next_track';
  if (domain === 'media_player' && action === 'media_previous') return 'media_previous_track';
  if (domain === 'media_player' && action === 'mute') return 'volume_mute';
  if (domain === 'media_player' && action === 'unmute') return 'volume_mute';
  if (domain === 'media_player' && action === 'remote_key') return 'button';
  if (domain === 'media_player' && action === 'play_channel') return 'play_media';
  if (domain === 'vacuum' && ['set_suction_mode', 'set_mop_mode'].includes(action)) return 'select_option';
  if (domain === 'climate' && action === 'set_hvac_mode') return 'set_hvac_mode';
  if (domain === 'climate' && action === 'set_preset_mode') return 'set_preset_mode';
  if (domain === 'water_heater' && action === 'set_operation_mode') return 'set_operation_mode';
  if (domain === 'water_heater' && action === 'set_away_mode') return 'set_away_mode';
  return action;
}

function serviceDataFor(command: ExecutableHomeAction): Record<string, unknown> | undefined {
  if (command.action === 'set_temperature') return { temperature: command.value };
  if (command.action === 'set_hvac_mode') return { hvac_mode: command.option };
  if (command.action === 'set_preset_mode') return { preset_mode: command.option };
  if (command.action === 'set_operation_mode') return { operation_mode: command.option };
  if (command.action === 'set_away_mode') return { away_mode: command.option === 'on' };
  if (command.action === 'set_temperature_offset') return { value: command.value };
  if (command.action === 'set_brightness') return { brightness_pct: command.value };
  if (command.action === 'set_volume') return { volume_level: (command.value ?? 0) / 100 };
  if (command.action === 'mute') return { is_volume_muted: true };
  if (command.action === 'unmute') return { is_volume_muted: false };
  if (command.action === 'select_source') return { source: command.option };
  if (command.action === 'select_sound_output') return { sound_output: command.option };
  if (command.action === 'play_channel') return { media_content_id: command.option, media_content_type: 'channel' };
  if (['set_suction_mode', 'set_mop_mode'].includes(command.action)) return { option: command.option };
  return undefined;
}

export type ResolvedCatalogHomeAction =
  | { ok: true; domain: string; call: HomeAssistantServiceCall }
  | {
      ok: false;
      status: 400 | 404 | 409;
      code: 'home_device_not_found' | 'home_device_not_mapped' | 'home_action_unsupported';
      domain?: string;
    };

export function resolveCatalogHomeAction(
  catalog: HomeCatalog,
  command: ExecutableHomeAction
): ResolvedCatalogHomeAction {
  const mapping = catalog.getMapping(command.deviceId);
  if (!mapping) return { ok: false, status: 404, code: 'home_device_not_found' };
  if (!mapping.entityId) return { ok: false, status: 409, code: 'home_device_not_mapped' };
  const domain = mapping.entityId.split('.')[0] ?? '';
  if (!allowedActions[domain]?.includes(command.action)) {
    return { ok: false, status: 400, code: 'home_action_unsupported', domain };
  }
  if (command.action === 'remote_key' && !TV_REMOTE_KEYS.includes(command.option as typeof TV_REMOTE_KEYS[number])) {
    return { ok: false, status: 400, code: 'home_action_unsupported', domain };
  }
  if (['select_source', 'select_sound_output'].includes(command.action) && (!command.option || command.option.length > 120)) {
    return { ok: false, status: 400, code: 'home_action_unsupported', domain };
  }
  if (command.action === 'play_channel' && (!command.option || command.option.length > 60)) {
    return { ok: false, status: 400, code: 'home_action_unsupported', domain };
  }
  if (['set_suction_mode', 'set_mop_mode'].includes(command.action) && (!command.option || command.option.length > 120)) {
    return { ok: false, status: 400, code: 'home_action_unsupported', domain };
  }
  if (domain === 'vacuum' && command.action === 'locate') {
    if (!mapping.robot?.locateEntityId) return { ok: false, status: 400, code: 'home_action_unsupported', domain };
    return {
      ok: true,
      domain,
      call: { domain: 'button', service: 'press', target: { entity_id: mapping.robot.locateEntityId } },
    };
  }
  if (domain === 'vacuum' && ['set_suction_mode', 'set_mop_mode'].includes(command.action)) {
    const target = command.action === 'set_suction_mode'
      ? mapping.robot?.suctionModeEntityId
      : mapping.robot?.mopModeEntityId;
    if (!target) return { ok: false, status: 400, code: 'home_action_unsupported', domain };
    return {
      ok: true,
      domain,
      call: { domain: 'select', service: 'select_option', target: { entity_id: target }, serviceData: serviceDataFor(command) },
    };
  }
  if (domain === 'vacuum' && ['empty_dust_bin', 'wash_mop', 'start_mop_drying', 'stop_mop_drying'].includes(command.action)) {
    const targets = {
      empty_dust_bin: mapping.robot?.emptyDustBinEntityId,
      wash_mop: mapping.robot?.washMopEntityId,
      start_mop_drying: mapping.robot?.startMopDryingEntityId,
      stop_mop_drying: mapping.robot?.stopMopDryingEntityId,
    } as const;
    const target = targets[command.action as keyof typeof targets];
    if (!target) return { ok: false, status: 400, code: 'home_action_unsupported', domain };
    return {
      ok: true,
      domain,
      call: { domain: 'button', service: 'press', target: { entity_id: target } },
    };
  }
  if (domain === 'climate' && command.action === 'set_temperature_offset') {
    if (!mapping.climate?.offsetEntityId) return { ok: false, status: 400, code: 'home_action_unsupported', domain };
    return { ok: true, domain, call: { domain: 'number', service: 'set_value', target: { entity_id: mapping.climate.offsetEntityId }, serviceData: serviceDataFor(command) } };
  }
  if (domain === 'climate' && ['set_child_lock', 'set_preheating'].includes(command.action)) {
    const target = command.action === 'set_child_lock' ? mapping.climate?.childLockEntityId : mapping.climate?.preheatingEntityId;
    if (!target || !['on', 'off'].includes(command.option ?? '')) return { ok: false, status: 400, code: 'home_action_unsupported', domain };
    return { ok: true, domain, call: { domain: 'switch', service: command.option === 'on' ? 'turn_on' : 'turn_off', target: { entity_id: target } } };
  }
  if (domain === 'water_heater' && ['set_eco_mode', 'set_boost_mode', 'set_antilegionella'].includes(command.action)) {
    const targets = {
      set_eco_mode: mapping.waterHeater?.ecoEntityId,
      set_boost_mode: mapping.waterHeater?.boostEntityId,
      set_antilegionella: mapping.waterHeater?.antiLegionellaEntityId,
    } as const;
    const target = targets[command.action as keyof typeof targets];
    if (!target || !['on', 'off'].includes(command.option ?? '')) return { ok: false, status: 400, code: 'home_action_unsupported', domain };
    return { ok: true, domain, call: { domain: 'switch', service: command.option === 'on' ? 'turn_on' : 'turn_off', target: { entity_id: target } } };
  }
  const isWebOsService = domain === 'media_player' && ['remote_key', 'select_sound_output'].includes(command.action);
  return {
    ok: true,
    domain,
    call: {
      domain: isWebOsService ? 'webostv' : domain,
      service: command.action === 'select_sound_output' ? 'select_sound_output' : serviceFor(domain, command.action),
      target: { entity_id: mapping.entityId },
      serviceData: command.action === 'remote_key' ? { button: command.option } : serviceDataFor(command),
    },
  };
}

export async function executeCatalogHomeAction(input: {
  catalog: HomeCatalog;
  ha?: HomeAssistantClient;
  principal?: RequestPrincipal;
  command: ExecutableHomeAction;
  wait?: (milliseconds: number) => Promise<void>;
  televisionPollAttempts?: number;
}): Promise<HomeActionExecution> {
  const resolved = resolveCatalogHomeAction(input.catalog, input.command);
  if (!resolved.ok) return resolved;
  const { domain } = resolved;
  if (
    input.principal?.kind === 'user'
    && isStreamDeckPrincipal(input.principal)
    && !isStreamDeckHomeActionAllowed(domain, input.command.action)
  ) {
    return { ok: false, status: 403, code: 'client_scope_forbidden', domain };
  }
  if (
    input.principal?.kind === 'user' &&
    input.principal.roles.includes('guest') &&
    !['light', 'media_player'].includes(domain)
  ) {
    return { ok: false, status: 403, code: 'guest_action_forbidden', domain };
  }
  if (!input.ha) {
    return { ok: false, status: 503, code: 'home_control_unavailable', domain };
  }
  try {
    if (['set_suction_mode', 'set_mop_mode', 'set_hvac_mode', 'set_preset_mode', 'set_operation_mode'].includes(input.command.action)) {
      const entityId = resolved.call.target?.entity_id;
      if (typeof entityId !== 'string') {
        return { ok: false, status: 400, code: 'home_action_unsupported', domain };
      }
      const targetState = await input.ha.getState(entityId);
      const optionKey = input.command.action === 'set_hvac_mode' ? 'hvac_modes' : input.command.action === 'set_preset_mode' ? 'preset_modes' : input.command.action === 'set_operation_mode' ? 'operation_list' : 'options';
      const options = isHassState(targetState) && targetState.attributes && typeof targetState.attributes === 'object'
        ? (targetState.attributes as Record<string, unknown>)[optionKey]
        : undefined;
      if (!Array.isArray(options) || !options.includes(input.command.option)) {
        return { ok: false, status: 400, code: 'home_action_option_invalid', domain };
      }
    }
    if (input.command.action === 'set_temperature') {
      const entityId = resolved.call.target?.entity_id;
      const targetState = typeof entityId === 'string' ? await input.ha.getState(entityId) : undefined;
      const attrs = isHassState(targetState) && targetState.attributes && typeof targetState.attributes === 'object' ? targetState.attributes as Record<string, unknown> : {};
      const min = typeof attrs.min_temp === 'number' ? attrs.min_temp : 5;
      const max = typeof attrs.max_temp === 'number' ? attrs.max_temp : 35;
      if (input.command.value === undefined || input.command.value < min || input.command.value > max) return { ok: false, status: 400, code: 'home_action_option_invalid', domain };
    }
    if (input.command.action === 'set_away_mode') {
      const entityId = resolved.call.target?.entity_id;
      const targetState = typeof entityId === 'string' ? await input.ha.getState(entityId) : undefined;
      const attrs = isHassState(targetState) && targetState.attributes && typeof targetState.attributes === 'object'
        ? targetState.attributes as Record<string, unknown>
        : {};
      if (typeof attrs.away_mode !== 'boolean') {
        return { ok: false, status: 400, code: 'home_action_unsupported', domain };
      }
    }
    if (input.command.action === 'set_temperature_offset') {
      const entityId = resolved.call.target?.entity_id;
      const targetState = typeof entityId === 'string' ? await input.ha.getState(entityId) : undefined;
      const attrs = isHassState(targetState) && targetState.attributes && typeof targetState.attributes === 'object' ? targetState.attributes as Record<string, unknown> : {};
      const min = typeof attrs.min === 'number' ? attrs.min : -10;
      const max = typeof attrs.max === 'number' ? attrs.max : 10;
      if (input.command.value === undefined || input.command.value < min || input.command.value > max) return { ok: false, status: 400, code: 'home_action_option_invalid', domain };
    }
    const mapping = input.catalog.getMapping(input.command.deviceId);
    if (
      domain === 'media_player' &&
      mapping?.presetId === 'television' &&
      input.command.action === 'turn_on' &&
      typeof mapping.entityId === 'string'
    ) {
      const readiness = await ensureTelevisionReady({
        ha: input.ha,
        entityId: mapping.entityId,
        ...(mapping.television?.wakeOnLanMac
          ? { wakeOnLanMac: mapping.television.wakeOnLanMac }
          : {}),
        ...(mapping.television?.wakeOnLanBroadcastAddress
          ? { wakeOnLanBroadcastAddress: mapping.television.wakeOnLanBroadcastAddress }
          : {}),
        ...(input.wait ? { wait: input.wait } : {}),
        ...(input.televisionPollAttempts === undefined
          ? {}
          : { pollAttempts: input.televisionPollAttempts }),
      });
      if (!readiness.ok) {
        return {
          ok: false,
          status: readiness.code === 'television_state_timeout' ? 503 : 502,
          code:
            readiness.code === 'television_state_timeout'
              ? 'home_device_state_timeout'
              : 'home_control_unavailable',
          domain,
        };
      }
    } else {
      await input.ha.callService(resolved.call);
    }
  } catch {
    return { ok: false, status: 502, code: 'home_control_unavailable', domain };
  }
  return { ok: true, domain };
}

export type HomeSceneExecution = {
  status: 'success' | 'partial' | 'failed';
  errorCode?: string;
  steps: Array<{
    deviceId: string;
    action: HomeActionName;
    status: 'success' | 'failed';
    error?: string;
  }>;
};

export async function executeCatalogHomeScene(input: {
  catalog: HomeCatalog;
  scene: HomeScene;
  ha?: HomeAssistantClient;
  principal?: RequestPrincipal;
}): Promise<HomeSceneExecution> {
  // Preflight every step first so a denied or malformed scene never executes partially.
  for (const step of input.scene.steps) {
    const resolved = resolveCatalogHomeAction(input.catalog, step);
    if (!resolved.ok) {
      return {
        status: 'failed',
        errorCode: resolved.code,
        steps: input.scene.steps.map((candidate) => ({
          deviceId: candidate.deviceId,
          action: candidate.action,
          status: 'failed',
          error: candidate.deviceId === step.deviceId ? resolved.code : 'scene_preflight_failed',
        })),
      };
    }
    const { domain } = resolved;
    if (
      input.principal?.kind === 'user' &&
      input.principal.roles.includes('guest') &&
      !['light', 'media_player'].includes(domain)
    ) {
      return {
        status: 'failed',
        errorCode: 'guest_action_forbidden',
        steps: [{ deviceId: step.deviceId, action: step.action, status: 'failed', error: 'guest_action_forbidden' }],
      };
    }
  }
  const executions = await Promise.all(
    input.scene.steps.map(async (step) => {
      const result = await executeCatalogHomeAction({ ...input, command: step });
      return result.ok
        ? { deviceId: step.deviceId, action: step.action, status: 'success' as const }
        : { deviceId: step.deviceId, action: step.action, status: 'failed' as const, error: result.code };
    })
  );
  const successCount = executions.filter((step) => step.status === 'success').length;
  return {
    status:
      successCount === executions.length ? 'success' : successCount === 0 ? 'failed' : 'partial',
    steps: executions,
    ...(successCount === 0 && executions[0]?.error ? { errorCode: executions[0].error } : {}),
  };
}
