import {
  type HomeAssistantClient,
  HomeAssistantRequestError,
  type HomeAssistantServiceCall,
} from '../haClient';
import { isHassState } from '../hass';
import {
  isStreamDeckHomeActionAllowed,
  isStreamDeckPrincipal,
  isStreamDeckSceneActionAllowed,
} from '../identity/oidcClientPolicy';
import type { RequestPrincipal } from '../identity/requestIdentity';
import { HOME_PRESETS } from './devicePresets';
import { homeActionStateAlreadySatisfied, homeActionStateConflict } from './HomeActionPolicy';
import { homeActionTiming } from './HomeActionTiming';
import { type HomeActionName, type HomeCatalog, type HomeScene, isHomeActionValueValid, sceneHasDeviceConflicts, TV_REMOTE_KEYS } from './HomeCatalog';
import { ensureTelevisionReady } from './TelevisionReadiness';

export type ExecutableHomeAction = {
  deviceId: string;
  action: HomeActionName;
  value?: number;
  option?: string;
};

export type ExecutableLightProfile = {
  deviceId: string;
  brightnessPercent: number;
  colorTemperatureKelvin?: number;
  transitionSeconds?: number;
};

export type HomeActionExecution =
  | {
      ok: true;
      domain: string;
      operationStatus: 'succeeded' | 'accepted' | 'uncertain';
      observedState?: string;
    }
  | {
      ok: false;
      status: 400 | 403 | 404 | 409 | 502 | 503;
      code:
        | 'home_device_not_found'
        | 'home_device_not_mapped'
        | 'home_action_unsupported'
        | 'home_action_option_invalid'
        | 'home_action_state_conflict'
        | 'home_action_in_progress'
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
  if (domain === 'light' && ['set_brightness', 'set_color'].includes(action)) return 'turn_on';
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
  if (command.action === 'set_color' && /^#[0-9a-f]{6}$/iu.test(command.option ?? '')) {
    const hex = command.option!.slice(1);
    return { rgb_color: [0, 2, 4].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16)) };
  }
  if (command.action === 'set_volume') return { volume_level: (command.value ?? 0) / 100 };
  if (command.action === 'mute') return { is_volume_muted: true };
  if (command.action === 'unmute') return { is_volume_muted: false };
  if (command.action === 'select_source') return { source: command.option };
  if (command.action === 'select_sound_output') return { sound_output: command.option };
  if (command.action === 'play_channel') return { media_content_id: command.option, media_content_type: 'channel' };
  if (['set_suction_mode', 'set_mop_mode'].includes(command.action)) return { option: command.option };
  return undefined;
}

function numericAttribute(state: unknown, key: string): number | null {
  if (!isHassState(state) || !state.attributes || typeof state.attributes !== 'object') return null;
  const value = Number((state.attributes as Record<string, unknown>)[key]);
  return Number.isFinite(value) ? value : null;
}

function attribute(state: unknown, key: string): unknown {
  return isHassState(state) && state.attributes && typeof state.attributes === 'object'
    ? (state.attributes as Record<string, unknown>)[key]
    : undefined;
}

function expectedActionState(
  state: unknown,
  domain: string,
  command: ExecutableHomeAction
): boolean | null {
  if (!isHassState(state)) return null;
  if (state.state === 'unknown' || state.state === 'unavailable') return false;
  if (command.action === 'turn_off') return state.state === 'off';
  if (command.action === 'turn_on') {
    return ['media_player', 'climate', 'water_heater'].includes(domain)
      ? state.state !== 'off'
      : state.state === 'on';
  }
  if (command.action === 'set_brightness') {
    const brightness = numericAttribute(state, 'brightness');
    return brightness === null || command.value === undefined
      ? null
      : Math.abs((brightness / 255) * 100 - command.value) <= 2;
  }
  if (command.action === 'set_color') {
    const rgb = attribute(state, 'rgb_color');
    const expected = command.option?.match(/[0-9a-f]{2}/giu)?.map((part) => Number.parseInt(part, 16));
    return !Array.isArray(rgb) || !expected || expected.length !== 3
      ? null
      : expected.every((value, index) => Math.abs(Number(rgb[index]) - value) <= 5);
  }
  if (command.action === 'set_temperature') {
    const target = numericAttribute(state, 'temperature');
    return target === null || command.value === undefined ? null : Math.abs(target - command.value) <= 0.2;
  }
  if (command.action === 'set_temperature_offset') {
    const observed = Number(state.state);
    return !Number.isFinite(observed) || command.value === undefined ? null : Math.abs(observed - command.value) <= 0.1;
  }
  if (command.action === 'set_hvac_mode') return state.state === command.option;
  if (command.action === 'set_preset_mode') return attribute(state, 'preset_mode') === command.option;
  if (command.action === 'set_operation_mode') {
    return state.state === command.option
      || attribute(state, 'operation_mode') === command.option
      || attribute(state, 'current_operation') === command.option;
  }
  if (command.action === 'set_away_mode') return attribute(state, 'away_mode') === (command.option === 'on');
  if (['set_eco_mode', 'set_boost_mode', 'set_antilegionella', 'set_child_lock', 'set_preheating'].includes(command.action)) {
    return state.state === command.option;
  }
  if (command.action === 'set_volume') {
    const volume = numericAttribute(state, 'volume_level');
    return volume === null || command.value === undefined ? null : Math.abs(volume * 100 - command.value) <= 2;
  }
  if (command.action === 'mute' || command.action === 'unmute') {
    return attribute(state, 'is_volume_muted') === (command.action === 'mute');
  }
  if (command.action === 'select_source') return attribute(state, 'source') === command.option;
  if (command.action === 'set_suction_mode' || command.action === 'set_mop_mode') return state.state === command.option;
  if (domain === 'vacuum' && command.action === 'start') return state.state === 'cleaning';
  if (domain === 'vacuum' && command.action === 'stop') return ['idle', 'paused', 'docked'].includes(state.state);
  if (domain === 'vacuum' && command.action === 'return_to_base') return ['returning', 'docked'].includes(state.state);
  if (domain === 'media_player' && command.action === 'media_play') return state.state === 'playing';
  if (domain === 'media_player' && command.action === 'media_pause') return state.state === 'paused';
  if (domain === 'media_player' && command.action === 'media_stop') return ['idle', 'off', 'paused'].includes(state.state);
  if (domain === 'cover' && command.action === 'open') return state.state === 'open';
  if (domain === 'cover' && command.action === 'close') return state.state === 'closed';
  return null;
}

function actionHasVerifiableOutcome(domain: string, command: ExecutableHomeAction): boolean {
  return [
    'turn_on', 'turn_off', 'set_brightness', 'set_color', 'set_temperature',
    'set_temperature_offset', 'set_hvac_mode', 'set_preset_mode', 'set_operation_mode',
    'set_away_mode', 'set_eco_mode', 'set_boost_mode', 'set_antilegionella',
    'set_child_lock', 'set_preheating', 'set_volume', 'mute', 'unmute', 'select_source',
    'set_suction_mode', 'set_mop_mode',
  ].includes(command.action)
    || (domain === 'vacuum' && ['start', 'stop', 'return_to_base'].includes(command.action))
    || (domain === 'media_player' && ['media_play', 'media_pause', 'media_stop'].includes(command.action))
    || (domain === 'cover' && ['open', 'close'].includes(command.action));
}

export type ResolvedCatalogHomeAction =
  | { ok: true; domain: string; call: HomeAssistantServiceCall }
  | {
      ok: false;
      status: 400 | 404 | 409;
      code: 'home_device_not_found' | 'home_device_not_mapped' | 'home_action_unsupported' | 'home_action_option_invalid';
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
  if (!isHomeActionValueValid(command.action, command.value, command.option)) {
    return { ok: false, status: 400, code: 'home_action_option_invalid', domain };
  }
  if (command.action === 'remote_key' && !TV_REMOTE_KEYS.includes(command.option as typeof TV_REMOTE_KEYS[number])) {
    return { ok: false, status: 400, code: 'home_action_unsupported', domain };
  }
  if (['select_source', 'select_sound_output'].includes(command.action) && (!command.option || command.option.length > 120)) {
    return { ok: false, status: 400, code: 'home_action_unsupported', domain };
  }
  if (command.action === 'set_color' && !/^#[0-9a-f]{6}$/iu.test(command.option ?? '')) {
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
  if (domain === 'media_player' && mapping.presetId === 'television' && command.action === 'type_text') {
    return {
      ok: true,
      domain,
      call: {
        domain: 'webostv',
        service: 'command',
        target: { entity_id: mapping.entityId },
        serviceData: {
          command: 'com.webos.service.ime/insertText',
          payload: { text: command.option, replace: false },
        },
      },
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

export async function executeCatalogLightProfile(input: {
  catalog: HomeCatalog;
  ha: HomeAssistantClient;
  profile: ExecutableLightProfile;
  wait?: (milliseconds: number) => Promise<void>;
  statePollAttempts?: number;
}): Promise<HomeActionExecution> {
  const mapping = input.catalog.getMapping(input.profile.deviceId);
  if (!mapping) return { ok: false, status: 404, code: 'home_device_not_found' };
  if (!mapping.entityId) return { ok: false, status: 409, code: 'home_device_not_mapped' };
  if (!mapping.entityId.startsWith('light.')) {
    return { ok: false, status: 400, code: 'home_action_unsupported', domain: 'light' };
  }
  if (
    !Number.isFinite(input.profile.brightnessPercent)
    || input.profile.brightnessPercent < 1
    || input.profile.brightnessPercent > 100
    || (input.profile.colorTemperatureKelvin !== undefined
      && (!Number.isFinite(input.profile.colorTemperatureKelvin)
        || input.profile.colorTemperatureKelvin < 2_000
        || input.profile.colorTemperatureKelvin > 6_500))
    || (input.profile.transitionSeconds !== undefined
      && (!Number.isFinite(input.profile.transitionSeconds)
        || input.profile.transitionSeconds < 0
        || input.profile.transitionSeconds > 300))
  ) {
    return { ok: false, status: 400, code: 'home_action_option_invalid', domain: 'light' };
  }
  try {
    const state = await input.ha.getState(mapping.entityId);
    const attributes = isHassState(state) && state.attributes && typeof state.attributes === 'object'
      ? state.attributes as Record<string, unknown>
      : {};
    let colorTemperatureKelvin: number | undefined;
    if (input.profile.colorTemperatureKelvin !== undefined) {
      const supportedColorModes = Array.isArray(attributes.supported_color_modes)
        ? attributes.supported_color_modes.filter((mode): mode is string => typeof mode === 'string')
        : [];
      if (!supportedColorModes.includes('color_temp')) {
        return { ok: false, status: 400, code: 'home_action_unsupported', domain: 'light' };
      }
      const minimum = Number(attributes.min_color_temp_kelvin);
      const maximum = Number(attributes.max_color_temp_kelvin);
      colorTemperatureKelvin = Math.round(Math.min(
        Number.isFinite(maximum) ? maximum : 6_500,
        Math.max(Number.isFinite(minimum) ? minimum : 2_000, input.profile.colorTemperatureKelvin)
      ));
    }
    await input.ha.callService({
      domain: 'light',
      service: 'turn_on',
      target: { entity_id: mapping.entityId },
      serviceData: {
        brightness_pct: Math.round(input.profile.brightnessPercent),
        ...(colorTemperatureKelvin === undefined ? {} : { color_temp_kelvin: colorTemperatureKelvin }),
        ...(input.profile.transitionSeconds === undefined
          ? {}
          : { transition: input.profile.transitionSeconds }),
      },
    });
    const wait = input.wait ?? ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
    if ((input.profile.transitionSeconds ?? 0) > 0) {
      await wait(Math.min(300, Math.round(input.profile.transitionSeconds! * 1_000)));
    }
    let readable = false;
    let evidenceAvailable = false;
    for (let attempt = 0; attempt < (input.statePollAttempts ?? 3); attempt += 1) {
      if (attempt > 0) await wait(150);
      try {
        const observed = await input.ha.getState(mapping.entityId);
        if (!isHassState(observed)) continue;
        readable = true;
        if (observed.state === 'unknown' || observed.state === 'unavailable') {
          evidenceAvailable = true;
          continue;
        }
        const brightness = numericAttribute(observed, 'brightness');
        const kelvin = numericAttribute(observed, 'color_temp_kelvin');
        const brightnessMatches = brightness !== null
          && Math.abs((brightness / 255) * 100 - input.profile.brightnessPercent) <= 2;
        const kelvinMatches = colorTemperatureKelvin === undefined
          ? true
          : kelvin !== null && Math.abs(kelvin - colorTemperatureKelvin) <= 75;
        if (brightness !== null && (colorTemperatureKelvin === undefined || kelvin !== null)) evidenceAvailable = true;
        if (observed.state === 'on' && brightnessMatches && kelvinMatches) {
          return { ok: true, domain: 'light', operationStatus: 'succeeded', observedState: observed.state };
        }
      } catch {
        return { ok: true, domain: 'light', operationStatus: 'accepted' };
      }
    }
    if (!readable || !evidenceAvailable) return { ok: true, domain: 'light', operationStatus: 'accepted' };
    return { ok: true, domain: 'light', operationStatus: 'uncertain' };
  } catch (error) {
    if (error instanceof HomeAssistantRequestError && error.operationMayHaveBeenAccepted) {
      return { ok: true, domain: 'light', operationStatus: 'uncertain' };
    }
    return { ok: false, status: 502, code: 'home_control_unavailable', domain: 'light' };
  }
}

const activeCommandsByCatalog = new WeakMap<HomeCatalog, Set<string>>();

export async function executeCatalogHomeAction(input: {
  catalog: HomeCatalog;
  ha?: HomeAssistantClient;
  principal?: RequestPrincipal;
  command: ExecutableHomeAction;
  wait?: (milliseconds: number) => Promise<void>;
  televisionPollAttempts?: number;
  statePollAttempts?: number;
  statePollIntervalMs?: number;
  allowAlreadySatisfied?: boolean;
  streamDeckSceneId?: string;
}): Promise<HomeActionExecution> {
  let active = activeCommandsByCatalog.get(input.catalog);
  if (!active) {
    active = new Set<string>();
    activeCommandsByCatalog.set(input.catalog, active);
  }
  if (active.has(input.command.deviceId)) {
    return { ok: false, status: 409, code: 'home_action_in_progress' };
  }
  active.add(input.command.deviceId);
  try {
    return await executeCatalogHomeActionOnce(input);
  } finally {
    active.delete(input.command.deviceId);
  }
}

async function executeCatalogHomeActionOnce(input: {
  catalog: HomeCatalog;
  ha?: HomeAssistantClient;
  principal?: RequestPrincipal;
  command: ExecutableHomeAction;
  wait?: (milliseconds: number) => Promise<void>;
  televisionPollAttempts?: number;
  statePollAttempts?: number;
  statePollIntervalMs?: number;
  allowAlreadySatisfied?: boolean;
  streamDeckSceneId?: string;
}): Promise<HomeActionExecution> {
  const resolved = resolveCatalogHomeAction(input.catalog, input.command);
  if (!resolved.ok) return resolved;
  const { domain } = resolved;
  if (
    input.principal?.kind === 'user'
    && isStreamDeckPrincipal(input.principal)
    && !(input.streamDeckSceneId
      ? isStreamDeckSceneActionAllowed(input.streamDeckSceneId, domain, input.command.action)
      : isStreamDeckHomeActionAllowed(domain, input.command.action))
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
    const mapping = input.catalog.getMapping(input.command.deviceId);
    let observedPrimaryState: unknown;
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
    if (['set_brightness', 'set_color'].includes(input.command.action)) {
      const entityId = resolved.call.target?.entity_id;
      const targetState = typeof entityId === 'string' ? await input.ha.getState(entityId) : undefined;
      const attrs = isHassState(targetState) && targetState.attributes && typeof targetState.attributes === 'object'
        ? targetState.attributes as Record<string, unknown>
        : {};
      const supportedModes = Array.isArray(attrs.supported_color_modes)
        ? attrs.supported_color_modes.filter((mode): mode is string => typeof mode === 'string')
        : [];
      const supportsBrightness = supportedModes.some((mode) => mode !== 'onoff');
      const supportsColor = supportedModes.some((mode) => ['hs', 'rgb', 'rgbw', 'rgbww', 'xy'].includes(mode));
      if (
        (input.command.action === 'set_brightness' && !supportsBrightness)
        || (input.command.action === 'set_color' && !supportsColor)
      ) {
        return { ok: false, status: 400, code: 'home_action_unsupported', domain };
      }
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
    if ((domain === 'vacuum' || (domain === 'media_player' && mapping?.presetId === 'television')) && mapping?.entityId) {
      const primaryState = await input.ha.getState(mapping.entityId);
      observedPrimaryState = primaryState;
      const dryingSensitiveActions: HomeActionName[] = [
        'start', 'empty_dust_bin', 'wash_mop', 'start_mop_drying', 'stop_mop_drying',
      ];
      const dryingState = domain === 'vacuum'
        && dryingSensitiveActions.includes(input.command.action)
        && mapping.robot?.dryingTimeRemainingEntityId
        ? await input.ha.getState(mapping.robot.dryingTimeRemainingEntityId)
        : undefined;
      const dryingTimeRemainingMinutes = isHassState(dryingState) && Number.isFinite(Number(dryingState.state))
        ? Number(dryingState.state)
        : undefined;
      const conflict = isHassState(primaryState)
        ? homeActionStateConflict({
            domain,
            action: input.command.action,
            state: primaryState.state,
            ...(dryingTimeRemainingMinutes === undefined ? {} : { dryingTimeRemainingMinutes }),
          })
        : 'device_state_unreadable';
      if (conflict) {
        if (
          input.allowAlreadySatisfied
          && isHassState(primaryState)
          && homeActionStateAlreadySatisfied({
            domain,
            action: input.command.action,
            state: primaryState.state,
          })
        ) {
          return {
            ok: true,
            domain,
            operationStatus: 'succeeded',
            observedState: primaryState.state,
          };
        }
        return { ok: false, status: 409, code: 'home_action_state_conflict', domain };
      }
    }
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
        initialState: observedPrimaryState,
        ...(input.televisionPollAttempts === undefined
          ? {}
          : { pollAttempts: input.televisionPollAttempts }),
      });
      if (!readiness.ok) {
        if (readiness.operationStatus === 'uncertain') {
          return { ok: true, domain, operationStatus: 'uncertain' };
        }
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
      return {
        ok: true,
        domain,
        operationStatus: 'succeeded',
        ...(isHassState(readiness.state) ? { observedState: readiness.state.state } : {}),
      };
    } else {
      await input.ha.callService(resolved.call);
    }
  } catch (error) {
    if (error instanceof HomeAssistantRequestError && error.operationMayHaveBeenAccepted) {
      return { ok: true, domain, operationStatus: 'uncertain' };
    }
    return { ok: false, status: 502, code: 'home_control_unavailable', domain };
  }

  const entityId = resolved.call.target?.entity_id;
  if (!actionHasVerifiableOutcome(domain, input.command) || typeof entityId !== 'string') {
    return { ok: true, domain, operationStatus: 'accepted' };
  }

  const wait = input.wait ?? ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  // Some catalog actions target a secondary entity (for example a vacuum's
  // select entity). Use the entity actually mutated so a mode selector does
  // not inherit the much longer robot movement budget.
  const timing = homeActionTiming(resolved.call.domain, input.command.action);
  let stateReadable = false;
  let evidenceAvailable = false;
  for (let attempt = 0; attempt < (input.statePollAttempts ?? timing.pollAttempts); attempt += 1) {
    if (attempt > 0) await wait(input.statePollIntervalMs ?? timing.pollIntervalMs);
    try {
      const state = await input.ha.getState(entityId);
      if (!isHassState(state)) continue;
      stateReadable = true;
      const matches = expectedActionState(state, domain, input.command);
      if (matches === null) {
        return { ok: true, domain, operationStatus: 'accepted', observedState: state.state };
      }
      if (matches !== null) evidenceAvailable = true;
      if (matches === true) {
        return { ok: true, domain, operationStatus: 'succeeded', observedState: state.state };
      }
    } catch {
      // The command was accepted by Home Assistant. A read failure must not be
      // misreported as a confirmed failure; callers can surface it as accepted.
      return { ok: true, domain, operationStatus: 'accepted' };
    }
  }
  if (!stateReadable) return { ok: true, domain, operationStatus: 'accepted' };
  if (!evidenceAvailable) return { ok: true, domain, operationStatus: 'accepted' };
  return { ok: true, domain, operationStatus: 'uncertain' };
}

export type HomeSceneOutcome = 'confirmed' | 'accepted' | 'partial' | 'failed' | 'uncertain';

export type HomeSceneExecution = {
  contractVersion: 2;
  outcome: HomeSceneOutcome;
  status: 'success' | 'partial' | 'failed';
  errorCode?: string;
  steps: Array<{
    deviceId: string;
    action: HomeActionName;
    status: 'success' | 'failed';
    outcome: 'confirmed' | 'accepted' | 'failed' | 'uncertain';
    operationStatus?: 'succeeded' | 'accepted' | 'uncertain';
    error?: string;
  }>;
};

export function aggregateSceneOutcome(
  steps: HomeSceneExecution['steps']
): HomeSceneOutcome {
  const outcomes = new Set(steps.map((step) => step.outcome));
  if (outcomes.size === 1 && outcomes.has('confirmed')) return 'confirmed';
  if (outcomes.size === 1 && outcomes.has('accepted')) return 'accepted';
  if (outcomes.size === 1 && outcomes.has('failed')) return 'failed';
  if (outcomes.has('accepted') || outcomes.has('uncertain')) return 'uncertain';
  return 'partial';
}

export async function executeCatalogHomeScene(input: {
  catalog: HomeCatalog;
  scene: HomeScene;
  ha?: HomeAssistantClient;
  principal?: RequestPrincipal;
}): Promise<HomeSceneExecution> {
  if (sceneHasDeviceConflicts(input.scene.steps)) {
    return {
      contractVersion: 2,
      outcome: 'failed',
      status: 'failed',
      errorCode: 'home_scene_device_conflict',
      steps: input.scene.steps.map((step) => ({
        deviceId: step.deviceId,
        action: step.action,
        status: 'failed',
        outcome: 'failed',
        error: 'home_scene_device_conflict',
      })),
    };
  }
  // Preflight every step first so a denied or malformed scene never executes partially.
  for (const step of input.scene.steps) {
    const resolved = resolveCatalogHomeAction(input.catalog, step);
    if (!resolved.ok) {
      return {
        contractVersion: 2,
        outcome: 'failed',
        status: 'failed',
        errorCode: resolved.code,
        steps: input.scene.steps.map((candidate) => ({
          deviceId: candidate.deviceId,
          action: candidate.action,
          status: 'failed',
          outcome: 'failed',
          error: candidate.deviceId === step.deviceId ? resolved.code : 'scene_preflight_failed',
        })),
      };
    }
    const { domain } = resolved;
    if (
      input.principal?.kind === 'user' &&
      isStreamDeckPrincipal(input.principal) &&
      !isStreamDeckSceneActionAllowed(input.scene.sceneId, domain, step.action)
    ) {
      return {
        contractVersion: 2,
        outcome: 'failed',
        status: 'failed',
        errorCode: 'client_scope_forbidden',
        steps: input.scene.steps.map((candidate) => ({
          deviceId: candidate.deviceId,
          action: candidate.action,
          status: 'failed',
          outcome: 'failed',
          error: candidate.deviceId === step.deviceId ? 'client_scope_forbidden' : 'scene_preflight_failed',
        })),
      };
    }
    if (
      input.principal?.kind === 'user' &&
      input.principal.roles.includes('guest') &&
      !['light', 'media_player'].includes(domain)
    ) {
      return {
        contractVersion: 2,
        outcome: 'failed',
        status: 'failed',
        errorCode: 'guest_action_forbidden',
        steps: [{ deviceId: step.deviceId, action: step.action, status: 'failed', outcome: 'failed', error: 'guest_action_forbidden' }],
      };
    }
  }
  const executions = await Promise.all(
    input.scene.steps.map(async (step) => {
      const result = await executeCatalogHomeAction({
        catalog: input.catalog,
        command: step,
        allowAlreadySatisfied: true,
        streamDeckSceneId: input.scene.sceneId,
        ...(input.ha ? { ha: input.ha } : {}),
        ...(input.principal ? { principal: input.principal } : {}),
      });
      return result.ok
        ? {
            deviceId: step.deviceId,
            action: step.action,
            status: 'success' as const,
            outcome:
              result.operationStatus === 'succeeded'
                ? 'confirmed' as const
                : result.operationStatus === 'accepted'
                  ? 'accepted' as const
                  : 'uncertain' as const,
            operationStatus: result.operationStatus,
          }
        : { deviceId: step.deviceId, action: step.action, status: 'failed' as const, outcome: 'failed' as const, error: result.code };
    })
  );
  const outcome = aggregateSceneOutcome(executions);
  const status = outcome === 'failed' ? 'failed' : outcome === 'partial' || outcome === 'uncertain' ? 'partial' : 'success';
  return {
    contractVersion: 2,
    outcome,
    status,
    steps: executions,
    ...(outcome === 'failed' && executions[0]?.error ? { errorCode: executions[0].error } : {}),
  };
}
