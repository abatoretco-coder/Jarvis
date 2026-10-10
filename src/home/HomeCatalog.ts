import { createHash, randomUUID } from 'node:crypto';
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, relative, resolve } from 'node:path';

import type { HomeAssistantClient } from '../haClient';
import { isHassState } from '../hass';
import {
  getDefaultPresetForDomain,
  getHomePreset,
  HOME_PRESETS,
  type HomePreset,
} from './devicePresets';

type Point = [number, number];
type RiskLevel = 'low' | 'moderate' | 'high';
export type HomeActionName =
  | 'turn_on'
  | 'turn_off'
  | 'toggle'
  | 'play_pause'
  | 'start'
  | 'return_to_base'
  | 'locate'
  | 'set_suction_mode'
  | 'set_mop_mode'
  | 'set_temperature'
  | 'set_hvac_mode'
  | 'set_preset_mode'
  | 'set_temperature_offset'
  | 'set_child_lock'
  | 'set_preheating'
  | 'set_operation_mode'
  | 'set_away_mode'
  | 'set_eco_mode'
  | 'set_boost_mode'
  | 'set_antilegionella'
  | 'open'
  | 'close'
  | 'stop'
  | 'set_brightness'
  | 'set_volume'
  | 'volume_up'
  | 'volume_down'
  | 'mute'
  | 'unmute'
  | 'media_play'
  | 'media_pause'
  | 'media_stop'
  | 'media_next'
  | 'media_previous'
  | 'play_channel'
  | 'select_source'
  | 'select_sound_output'
  | 'remote_key'
  | 'empty_dust_bin'
  | 'wash_mop'
  | 'start_mop_drying'
  | 'stop_mop_drying';
export type HomeQuickAction = {
  quickActionId: string;
  name: string;
  icon: 'light' | 'climate' | 'media' | 'vacuum' | 'home';
  deviceId: string;
  action: HomeActionName;
  value?: number;
  option?: string;
  voicePhrases: string[];
  sortOrder: number;
};
export type DeterministicHomeVoiceAction = {
  name: string;
  deviceId: string;
  action: 'set_volume';
  value: number;
};
export type HomeScene = {
  sceneId: string;
  name: string;
  icon: HomeQuickAction['icon'];
  steps: Array<{ deviceId: string; action: HomeActionName; value?: number; option?: string }>;
  voicePhrases: string[];
  sortOrder: number;
};
export type HomeRoutine = {
  routineId: string;
  name: string;
  enabled: boolean;
  sceneId: string;
  trigger: { type: 'time'; at: string; weekdays: number[] };
};
export type DevicePlacement = {
  x: number;
  y: number;
  z: number;
  rotationDeg: number;
  scale: number;
};
type DeviceMapping = {
  deviceId: string;
  entityId?: string;
  name?: string;
  presetId: string;
  placement: DevicePlacement;
  robot?: RobotEntityMapping;
  television?: TelevisionEntityMapping;
  climate?: ClimateEntityMapping;
  environment?: EnvironmentEntityMapping;
  waterHeater?: WaterHeaterEntityMapping;
};
type EnvironmentEntityMapping = {
  humidityEntityId?: string;
  batteryEntityId?: string;
};
const environmentEntityDomains: Record<keyof EnvironmentEntityMapping, string> = {
  humidityEntityId: 'sensor',
  batteryEntityId: 'sensor',
};
type WaterHeaterEntityMapping = {
  ecoEntityId?: string;
  boostEntityId?: string;
  antiLegionellaEntityId?: string;
  heatingEntityId?: string;
  powerEntityId?: string;
  energyEntityId?: string;
  showersEntityId?: string;
  heatingTimeEntityId?: string;
};
const waterHeaterEntityDomains: Record<keyof WaterHeaterEntityMapping, string> = {
  ecoEntityId: 'switch',
  boostEntityId: 'switch',
  antiLegionellaEntityId: 'switch',
  heatingEntityId: 'binary_sensor',
  powerEntityId: 'sensor',
  energyEntityId: 'sensor',
  showersEntityId: 'sensor',
  heatingTimeEntityId: 'sensor',
};
type ClimateEntityMapping = {
  offsetEntityId?: string;
  windowEntityId?: string;
  presenceEntityId?: string;
  childLockEntityId?: string;
  preheatingEntityId?: string;
  powerEntityId?: string;
  energyEntityId?: string;
};
const climateEntityDomains: Record<keyof ClimateEntityMapping, string> = {
  offsetEntityId: 'number',
  windowEntityId: 'binary_sensor',
  presenceEntityId: 'binary_sensor',
  childLockEntityId: 'switch',
  preheatingEntityId: 'switch',
  powerEntityId: 'sensor',
  energyEntityId: 'sensor',
};
type TelevisionEntityMapping = {
  wakeOnLanMac?: string;
  wakeOnLanBroadcastAddress?: string;
  spotifySource?: string;
};
type RobotEntityMapping = {
  batteryEntityId?: string;
  chargingStateEntityId?: string;
  locateEntityId?: string;
  suctionModeEntityId?: string;
  mopModeEntityId?: string;
  emptyDustBinEntityId?: string;
  washMopEntityId?: string;
  startMopDryingEntityId?: string;
  stopMopDryingEntityId?: string;
  cleaningTimeEntityId?: string;
  cleaningAreaEntityId?: string;
  dryingTimeRemainingEntityId?: string;
  totalCleaningTimeEntityId?: string;
  totalCleaningCountEntityId?: string;
  totalCleaningAreaEntityId?: string;
  mainBrushLifeEntityId?: string;
  sideBrushLifeEntityId?: string;
  filterLifeEntityId?: string;
  mopLifeEntityId?: string;
};
const robotEntityDomains: Record<keyof RobotEntityMapping, string> = {
  batteryEntityId: 'sensor',
  chargingStateEntityId: 'sensor',
  locateEntityId: 'button',
  suctionModeEntityId: 'select',
  mopModeEntityId: 'select',
  emptyDustBinEntityId: 'button',
  washMopEntityId: 'button',
  startMopDryingEntityId: 'button',
  stopMopDryingEntityId: 'button',
  cleaningTimeEntityId: 'sensor',
  cleaningAreaEntityId: 'sensor',
  dryingTimeRemainingEntityId: 'sensor',
  totalCleaningTimeEntityId: 'sensor',
  totalCleaningCountEntityId: 'sensor',
  totalCleaningAreaEntityId: 'sensor',
  mainBrushLifeEntityId: 'sensor',
  sideBrushLifeEntityId: 'sensor',
  filterLifeEntityId: 'sensor',
  mopLifeEntityId: 'sensor',
};
type RawDeviceMapping =
  | string
  | {
      deviceId: string;
      entityId?: string;
      name?: string;
      presetId?: string;
      placement?: Partial<DevicePlacement>;
      robot?: Partial<RobotEntityMapping>;
      television?: Partial<TelevisionEntityMapping>;
      climate?: Partial<ClimateEntityMapping>;
      environment?: Partial<EnvironmentEntityMapping>;
      waterHeater?: Partial<WaterHeaterEntityMapping>;
    };

export type HomeRoom = {
  roomId: string;
  name: string;
  type: string;
  polygon: Point[];
  deviceIds: string[];
};
export type HomeDevice = {
  deviceId: string;
  roomId: string;
  domain: string;
  name: string;
  state: string;
  available: boolean;
  mapped: boolean;
  presetId: string;
  placement: DevicePlacement;
  capabilities: string[];
  riskLevel: RiskLevel;
  targetTemperature?: number;
  currentTemperature?: number;
  minTemperature?: number;
  maxTemperature?: number;
  temperatureStep?: number;
  hvacMode?: string;
  hvacModes?: string[];
  hvacAction?: string;
  presetMode?: string;
  presetModes?: string[];
  temperatureOffset?: number;
  temperatureOffsetMin?: number;
  temperatureOffsetMax?: number;
  temperatureOffsetStep?: number;
  windowOpen?: boolean;
  presenceDetected?: boolean;
  childLock?: boolean;
  preheating?: boolean;
  activePowerWatts?: number;
  energyKwh?: number;
  humidityPercent?: number;
  operationMode?: string;
  operationModes?: string[];
  awayMode?: boolean;
  ecoMode?: boolean;
  boostMode?: boolean;
  antiLegionella?: boolean;
  heatingActive?: boolean;
  showersAvailable?: number;
  heatingTimeMinutes?: number;
  volumeLevel?: number;
  muted?: boolean;
  source?: string;
  sourceList?: string[];
  mediaTitle?: string;
  mediaArtist?: string;
  soundOutput?: string;
  soundOutputList?: string[];
  batteryLevel?: number;
  chargingState?: string;
  suctionMode?: string;
  suctionModeOptions?: string[];
  mopMode?: string;
  mopModeOptions?: string[];
  cleaningTimeMinutes?: number;
  cleaningAreaM2?: number;
  dryingTimeRemainingMinutes?: number;
  totalCleaningTimeMinutes?: number;
  totalCleaningCount?: number;
  totalCleaningAreaM2?: number;
  mainBrushLifePercent?: number;
  sideBrushLifePercent?: number;
  filterLifePercent?: number;
  mopLifePercent?: number;
};
export type HomeSnapshot = {
  homeId: string;
  displayName: string;
  controlStatus: 'ready' | 'offline' | 'not_configured';
  geometryQuality: string;
  units: string;
  revision: string;
  rooms: HomeRoom[];
  devices: HomeDevice[];
  quickActions: HomeQuickAction[];
  scenes: HomeScene[];
  routines: HomeRoutine[];
  presets: HomePreset[];
  updatedAt: string;
};

type HomeFile = {
  schemaVersion?: string;
  homeId: string;
  displayName: string;
  geometry: { quality: string; units: string };
  rooms: Array<{ roomId: string; name: string; type: string; polygon: Point[] }>;
  automation?: {
    spaces?: Array<{ roomId: string; entities?: RawDeviceMapping[] }>;
    quickActions?: HomeQuickAction[];
    scenes?: HomeScene[];
    routines?: HomeRoutine[];
  };
  [key: string]: unknown;
};

export type UpsertHomeDevice = {
  expectedRevision: string;
  deviceId: string;
  roomId: string;
  entityId?: string;
  name: string;
  presetId: string;
  placement: DevicePlacement;
};

export type UpsertHomeQuickAction = Omit<HomeQuickAction, 'sortOrder'> & {
  expectedRevision: string;
  sortOrder?: number;
};
export type UpsertHomeScene = Omit<HomeScene, 'sortOrder'> & {
  expectedRevision: string;
  sortOrder?: number;
};
export type UpsertHomeRoutine = HomeRoutine & { expectedRevision: string };

const entityIdPattern = /^[a-z_]+\.[a-z0-9_]+$/u;
const deviceIdPattern = /^[a-z0-9][a-z0-9_-]{0,63}$/u;
const quickActionIdPattern = /^[a-z0-9][a-z0-9_-]{0,63}$/u;
const quickActionIcons = new Set(['light', 'climate', 'media', 'vacuum', 'home']);
const quickActionNames = new Set<HomeActionName>([
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

export const TV_REMOTE_KEYS = [
  'HOME', 'BACK', 'UP', 'DOWN', 'LEFT', 'RIGHT', 'ENTER', 'EXIT', 'INFO',
  'MENU', 'GUIDE', 'CHANNELUP', 'CHANNELDOWN', 'RED', 'GREEN', 'YELLOW', 'BLUE',
  '0', '1', '2', '3', '4', '5', '6', '7', '8', '9',
] as const;
const tvRemoteKeys = new Set<string>(TV_REMOTE_KEYS);

function isActionValueValid(
  action: HomeActionName,
  value: number | undefined,
  option: string | undefined
): boolean {
  if (action === 'set_temperature') return typeof value === 'number' && value >= 5 && value <= 80;
  if (action === 'set_temperature_offset') return typeof value === 'number' && value >= -10 && value <= 10;
  if (['set_child_lock', 'set_preheating', 'set_away_mode', 'set_eco_mode', 'set_boost_mode', 'set_antilegionella'].includes(action)) {
    return value === undefined && (option === 'on' || option === 'off');
  }
  if (action === 'set_brightness' || action === 'set_volume') {
    return typeof value === 'number' && value >= 0 && value <= 100;
  }
  if (['select_source', 'select_sound_output', 'set_suction_mode', 'set_mop_mode', 'set_hvac_mode', 'set_preset_mode', 'set_operation_mode'].includes(action)) {
    return value === undefined && typeof option === 'string' && option.trim().length >= 1 && option.length <= 120;
  }
  if (action === 'play_channel') {
    return value === undefined && typeof option === 'string' && option.trim().length >= 1 && option.length <= 60;
  }
  if (action === 'remote_key') {
    return value === undefined && typeof option === 'string' && tvRemoteKeys.has(option);
  }
  return value === undefined && option === undefined;
}

export function normalizeVoicePhrase(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/gu, '')
    .toLocaleLowerCase('fr-FR')
    .replace(/[^a-z0-9]+/gu, ' ')
    .trim();
}

function normalizeVoiceCommand(value: string): string {
  return normalizeVoicePhrase(value).replace(
    /^(?:(?:hey|ok) )?(?:jarvis|jervis)\s+/u,
    ''
  );
}

export function inferDeterministicTvVolumeAction(
  text: string,
  televisionMappings: ReadonlyArray<{ deviceId: string; name?: string }>
): DeterministicHomeVoiceAction | undefined {
  const normalized = normalizeVoicePhrase(text);
  if (
    televisionMappings.length !== 1 ||
    !/\b(?:met|mets|regle|fixe)\b/u.test(normalized) ||
    !/\b(?:son|volume)\b/u.test(normalized) ||
    !(/\b(?:tele|television|tv)\b/u.test(normalized) || /\bde la telephone\b/u.test(normalized)) ||
    /\b(?:et|puis|ensuite)\b/u.test(normalized)
  ) {
    return undefined;
  }
  const valueMatch = normalized.match(/\b(?:a|au)\s+(\d{1,3})\b/u);
  if (!valueMatch) return undefined;
  const value = Number(valueMatch[1]);
  if (!Number.isInteger(value) || value < 0 || value > 100) return undefined;
  const television = televisionMappings[0] as { deviceId: string; name?: string };
  return {
    name: television.name ?? 'Télévision',
    deviceId: television.deviceId,
    action: 'set_volume',
    value,
  };
}

function normalizeQuickAction(value: HomeQuickAction): HomeQuickAction | null {
  const voicePhrases = [
    ...new Set((value.voicePhrases ?? []).map(normalizeVoicePhrase).filter(Boolean)),
  ];
  if (
    !quickActionIdPattern.test(value.quickActionId) ||
    typeof value.name !== 'string' ||
    !value.name.trim() ||
    value.name.trim().length > 60 ||
    !quickActionIcons.has(value.icon) ||
    !deviceIdPattern.test(value.deviceId) ||
    !quickActionNames.has(value.action) ||
    voicePhrases.length > 5 ||
    voicePhrases.some((phrase) => phrase.length < 2 || phrase.length > 80) ||
    !Number.isInteger(value.sortOrder) ||
    value.sortOrder < 0 ||
    value.sortOrder > 999 ||
    !isActionValueValid(value.action, value.value, value.option)
  ) {
    return null;
  }
  return {
    quickActionId: value.quickActionId,
    name: value.name.trim(),
    icon: value.icon,
    deviceId: value.deviceId,
    action: value.action,
    ...(value.value === undefined ? {} : { value: value.value }),
    ...(value.option === undefined ? {} : { option: value.option.trim() }),
    voicePhrases,
    sortOrder: value.sortOrder,
  };
}

function normalizeScene(value: HomeScene): HomeScene | null {
  const voicePhrases = [
    ...new Set((value.voicePhrases ?? []).map(normalizeVoicePhrase).filter(Boolean)),
  ];
  if (
    !quickActionIdPattern.test(value.sceneId) ||
    typeof value.name !== 'string' ||
    !value.name.trim() ||
    value.name.trim().length > 60 ||
    !quickActionIcons.has(value.icon) ||
    !Array.isArray(value.steps) ||
    value.steps.length < 2 ||
    value.steps.length > 20 ||
    voicePhrases.length > 5 ||
    voicePhrases.some((phrase) => phrase.length < 2 || phrase.length > 80) ||
    !Number.isInteger(value.sortOrder) ||
    value.sortOrder < 0 ||
    value.sortOrder > 999
  ) return null;
  const steps = value.steps.map((step) => {
    if (
      !deviceIdPattern.test(step.deviceId) ||
      !quickActionNames.has(step.action) ||
      !isActionValueValid(step.action, step.value, step.option)
    ) return null;
    return {
      deviceId: step.deviceId,
      action: step.action,
      ...(step.value === undefined ? {} : { value: step.value }),
      ...(step.option === undefined ? {} : { option: step.option.trim() }),
    };
  });
  if (steps.some((step) => step === null)) return null;
  return {
    sceneId: value.sceneId,
    name: value.name.trim(),
    icon: value.icon,
    steps: steps as HomeScene['steps'],
    voicePhrases,
    sortOrder: value.sortOrder,
  };
}

function normalizeRoutine(value: HomeRoutine): HomeRoutine | null {
  const weekdays = [...new Set(value.trigger?.weekdays ?? [])].sort();
  if (
    !quickActionIdPattern.test(value.routineId) ||
    typeof value.name !== 'string' ||
    !value.name.trim() ||
    value.name.trim().length > 60 ||
    typeof value.enabled !== 'boolean' ||
    !quickActionIdPattern.test(value.sceneId) ||
    value.trigger?.type !== 'time' ||
    !/^([01]\d|2[0-3]):[0-5]\d$/u.test(value.trigger.at) ||
    weekdays.length < 1 ||
    weekdays.some((day) => !Number.isInteger(day) || day < 1 || day > 7)
  ) return null;
  return {
    routineId: value.routineId,
    name: value.name.trim(),
    enabled: value.enabled,
    sceneId: value.sceneId,
    trigger: { type: 'time', at: value.trigger.at, weekdays },
  };
}

function assertWithin(root: string, candidate: string): void {
  const pathFromRoot = relative(root, candidate);
  if (pathFromRoot.startsWith('..') || resolve(root, pathFromRoot) !== candidate) {
    throw new Error('home_config_path_invalid');
  }
}

function roomCenter(polygon: Point[]): Point {
  return [
    polygon.reduce((sum, point) => sum + point[0], 0) / polygon.length,
    polygon.reduce((sum, point) => sum + point[1], 0) / polygon.length,
  ];
}

function pointInPolygon(point: Point, polygon: Point[]): boolean {
  let inside = false;
  for (
    let current = 0, previous = polygon.length - 1;
    current < polygon.length;
    previous = current++
  ) {
    const [currentX, currentY] = polygon[current] as Point;
    const [previousX, previousY] = polygon[previous] as Point;
    const crosses =
      currentY > point[1] !== previousY > point[1] &&
      point[0] <
        ((previousX - currentX) * (point[1] - currentY)) / (previousY - currentY) + currentX;
    if (crosses) inside = !inside;
  }
  return inside;
}

function normalizePlacement(
  value: Partial<DevicePlacement> | undefined,
  fallback: Point
): DevicePlacement | null {
  const placement = {
    x: value?.x ?? fallback[0],
    y: value?.y ?? fallback[1],
    z: value?.z ?? 0,
    rotationDeg: value?.rotationDeg ?? 0,
    scale: value?.scale ?? 1,
  };
  if (
    !Object.values(placement).every(Number.isFinite) ||
    placement.z < 0 ||
    placement.z > 10 ||
    placement.rotationDeg < -360 ||
    placement.rotationDeg > 360 ||
    placement.scale < 0.25 ||
    placement.scale > 4
  ) {
    return null;
  }
  return placement;
}

function normalizeMapping(
  value: RawDeviceMapping,
  room: HomeFile['rooms'][number]
): DeviceMapping | null {
  const fallback = roomCenter(room.polygon);
  if (typeof value === 'string') {
    if (!entityIdPattern.test(value)) return null;
    const domain = value.split('.')[0] ?? '';
    const preset = getDefaultPresetForDomain(domain);
    if (!preset) return null;
    return {
      deviceId: value.replace('.', '_'),
      entityId: value,
      presetId: preset.presetId,
      placement: normalizePlacement(undefined, fallback) as DevicePlacement,
    };
  }
  const entityId = value.entityId?.trim();
  const domain = entityId?.split('.')[0];
  const preset = value.presetId
    ? getHomePreset(value.presetId)
    : domain
      ? getDefaultPresetForDomain(domain)
      : undefined;
  const placement = normalizePlacement(value.placement, fallback);
  const robotEntries = value.robot
    ? Object.entries(value.robot).filter((entry): entry is [keyof RobotEntityMapping, string] =>
        Object.hasOwn(robotEntityDomains, entry[0]) &&
        typeof entry[1] === 'string' &&
        entry[1].trim().length > 0
      )
    : [];
  const robot = robotEntries.length > 0
    ? Object.fromEntries(robotEntries.map(([key, entity]) => [key, entity.trim()])) as RobotEntityMapping
    : undefined;
  const television = value.television
    ? {
        ...(typeof value.television.wakeOnLanMac === 'string' ? { wakeOnLanMac: value.television.wakeOnLanMac.trim().toUpperCase() } : {}),
        ...(typeof value.television.wakeOnLanBroadcastAddress === 'string' ? { wakeOnLanBroadcastAddress: value.television.wakeOnLanBroadcastAddress.trim() } : {}),
        ...(typeof value.television.spotifySource === 'string' ? { spotifySource: value.television.spotifySource.trim() } : {}),
      }
    : undefined;
  const climateEntries = value.climate
    ? Object.entries(value.climate).filter((entry): entry is [keyof ClimateEntityMapping, string] =>
        Object.hasOwn(climateEntityDomains, entry[0]) &&
        typeof entry[1] === 'string' &&
        entry[1].trim().length > 0
      )
    : [];
  const climate = climateEntries.length > 0
    ? Object.fromEntries(climateEntries.map(([key, entity]) => [key, entity.trim()])) as ClimateEntityMapping
    : undefined;
  const environmentEntries = value.environment
    ? Object.entries(value.environment).filter((entry): entry is [keyof EnvironmentEntityMapping, string] =>
        Object.hasOwn(environmentEntityDomains, entry[0]) && typeof entry[1] === 'string' && entry[1].trim().length > 0)
    : [];
  const environment = environmentEntries.length > 0
    ? Object.fromEntries(environmentEntries.map(([key, entity]) => [key, entity.trim()])) as EnvironmentEntityMapping
    : undefined;
  const waterHeaterEntries = value.waterHeater
    ? Object.entries(value.waterHeater).filter((entry): entry is [keyof WaterHeaterEntityMapping, string] =>
        Object.hasOwn(waterHeaterEntityDomains, entry[0]) && typeof entry[1] === 'string' && entry[1].trim().length > 0)
    : [];
  const waterHeater = waterHeaterEntries.length > 0
    ? Object.fromEntries(waterHeaterEntries.map(([key, entity]) => [key, entity.trim()])) as WaterHeaterEntityMapping
    : undefined;
  const validTelevision = !television || (
    (!television.wakeOnLanMac || /^([0-9A-F]{2}:){5}[0-9A-F]{2}$/u.test(television.wakeOnLanMac)) &&
    (!television.wakeOnLanBroadcastAddress || /^(?:\d{1,3}\.){3}\d{1,3}$/u.test(television.wakeOnLanBroadcastAddress)) &&
    (!television.spotifySource || television.spotifySource.length <= 120)
  );
  if (
    !value ||
    !deviceIdPattern.test(value.deviceId) ||
    (entityId !== undefined && !entityIdPattern.test(entityId)) ||
    (value.name !== undefined && (!value.name.trim() || value.name.length > 100)) ||
    !preset ||
    (domain !== undefined && preset.domain !== domain) ||
    (value.robot !== undefined && (preset.domain !== 'vacuum' || !robot)) ||
    (robot && Object.entries(robot).some(([key, candidate]) =>
      !entityIdPattern.test(candidate) || candidate.split('.')[0] !== robotEntityDomains[key as keyof RobotEntityMapping]
    )) ||
    (value.robot !== undefined && Object.keys(value.robot).some((key) => !Object.hasOwn(robotEntityDomains, key))) ||
    (value.television !== undefined && (preset.presetId !== 'television' || !validTelevision || Object.keys(value.television).some((key) => !['wakeOnLanMac', 'wakeOnLanBroadcastAddress', 'spotifySource'].includes(key)))) ||
    (value.climate !== undefined && (preset.domain !== 'climate' || !climate)) ||
    (climate && Object.entries(climate).some(([key, candidate]) =>
      !entityIdPattern.test(candidate) || candidate.split('.')[0] !== climateEntityDomains[key as keyof ClimateEntityMapping]
    )) ||
    (value.climate !== undefined && Object.keys(value.climate).some((key) => !Object.hasOwn(climateEntityDomains, key))) ||
    (value.environment !== undefined && (preset.domain !== 'sensor' || !environment)) ||
    (environment && Object.entries(environment).some(([key, candidate]) => !entityIdPattern.test(candidate) || candidate.split('.')[0] !== environmentEntityDomains[key as keyof EnvironmentEntityMapping])) ||
    (value.environment !== undefined && Object.keys(value.environment).some((key) => !Object.hasOwn(environmentEntityDomains, key))) ||
    (value.waterHeater !== undefined && (preset.domain !== 'water_heater' || !waterHeater)) ||
    (waterHeater && Object.entries(waterHeater).some(([key, candidate]) => !entityIdPattern.test(candidate) || candidate.split('.')[0] !== waterHeaterEntityDomains[key as keyof WaterHeaterEntityMapping])) ||
    (value.waterHeater !== undefined && Object.keys(value.waterHeater).some((key) => !Object.hasOwn(waterHeaterEntityDomains, key))) ||
    !placement ||
    !pointInPolygon([placement.x, placement.y], room.polygon)
  ) {
    return null;
  }
  return {
    deviceId: value.deviceId,
    ...(entityId ? { entityId } : {}),
    ...(value.name ? { name: value.name.trim() } : {}),
    presetId: preset.presetId,
    placement,
    ...(robot ? { robot } : {}),
    ...(television ? { television } : {}),
    ...(climate ? { climate } : {}),
    ...(environment ? { environment } : {}),
    ...(waterHeater ? { waterHeater } : {}),
  };
}

function validateHome(value: unknown, expectedId: string): HomeFile {
  if (!value || typeof value !== 'object') throw new Error('home_config_invalid');
  const home = value as HomeFile;
  if (
    home.homeId !== expectedId ||
    !home.displayName ||
    !home.geometry?.quality ||
    !home.geometry.units ||
    !Array.isArray(home.rooms)
  ) {
    throw new Error('home_config_invalid');
  }
  const roomIds = new Set<string>();
  for (const room of home.rooms) {
    if (
      !room.roomId ||
      roomIds.has(room.roomId) ||
      !room.name ||
      !room.type ||
      !Array.isArray(room.polygon) ||
      room.polygon.length < 3 ||
      room.polygon.some(
        (point) =>
          !Array.isArray(point) ||
          point.length !== 2 ||
          point.some((coordinate) => !Number.isFinite(coordinate))
      )
    ) {
      throw new Error('home_config_invalid');
    }
    roomIds.add(room.roomId);
  }
  return home;
}

function seedWritableHome(templateRoot: string, dataRoot: string, homeId: string): string {
  const source = resolve(templateRoot, homeId);
  const destination = resolve(dataRoot, homeId);
  assertWithin(resolve(templateRoot), source);
  assertWithin(resolve(dataRoot), destination);
  if (existsSync(resolve(destination, 'home.json'))) return destination;
  mkdirSync(dataRoot, { recursive: true });
  const temporary = `${destination}.${randomUUID()}.tmp`;
  try {
    cpSync(source, temporary, { recursive: true, errorOnExist: true });
    renameSync(temporary, destination);
  } catch (error) {
    rmSync(temporary, { recursive: true, force: true });
    if (!existsSync(resolve(destination, 'home.json'))) throw error;
  }
  return destination;
}

export class HomeCatalog {
  private home!: HomeFile;
  private revision = '';
  private readonly homeFile: string;
  private readonly writable: boolean;
  private readonly homeId: string;
  private readonly mappingsByRoom = new Map<string, DeviceMapping[]>();
  private readonly mappingsByDeviceId = new Map<string, DeviceMapping>();
  private quickActions: HomeQuickAction[] = [];
  private scenes: HomeScene[] = [];
  private routines: HomeRoutine[] = [];

  constructor(configRoot: string, homeId: string, dataRoot?: string) {
    const templateRoot = resolve(configRoot);
    const homeRoot = dataRoot?.trim()
      ? seedWritableHome(templateRoot, resolve(dataRoot), homeId)
      : resolve(templateRoot, homeId);
    this.homeFile = resolve(homeRoot, 'home.json');
    assertWithin(homeRoot, this.homeFile);
    this.homeId = homeId;
    this.writable = Boolean(dataRoot?.trim());
    this.reload();
  }

  private reload(): void {
    const raw = readFileSync(this.homeFile, 'utf8');
    const home = validateHome(JSON.parse(raw) as unknown, this.homeId);
    const validRooms = new Map(home.rooms.map((room) => [room.roomId, room]));
    const entityIds = new Set<string>();
    const mappingsByRoom = new Map<string, DeviceMapping[]>();
    const mappingsByDeviceId = new Map<string, DeviceMapping>();
    for (const space of home.automation?.spaces ?? []) {
      const room = validRooms.get(space.roomId);
      if (!room || mappingsByRoom.has(space.roomId)) throw new Error('home_config_invalid');
      const mappings: DeviceMapping[] = [];
      for (const rawMapping of space.entities ?? []) {
        const mapping = normalizeMapping(rawMapping, room);
        if (
          !mapping ||
          mappingsByDeviceId.has(mapping.deviceId) ||
          (mapping.entityId !== undefined && entityIds.has(mapping.entityId))
        ) {
          throw new Error('home_config_invalid');
        }
        mappings.push(mapping);
        mappingsByDeviceId.set(mapping.deviceId, mapping);
        if (mapping.entityId) entityIds.add(mapping.entityId);
      }
      mappingsByRoom.set(space.roomId, mappings);
    }
    this.home = home;
    this.revision = createHash('sha256').update(raw).digest('hex').slice(0, 16);
    this.mappingsByRoom.clear();
    this.mappingsByDeviceId.clear();
    for (const [key, mappings] of mappingsByRoom) this.mappingsByRoom.set(key, mappings);
    for (const [key, mapping] of mappingsByDeviceId) this.mappingsByDeviceId.set(key, mapping);
    const quickActionIds = new Set<string>();
    const voicePhrases = new Set<string>();
    this.quickActions = (home.automation?.quickActions ?? []).map((rawAction) => {
      const action = normalizeQuickAction(rawAction);
      if (
        !action ||
        quickActionIds.has(action.quickActionId) ||
        !mappingsByDeviceId.has(action.deviceId)
      ) {
        throw new Error('home_config_invalid');
      }
      for (const phrase of action.voicePhrases) {
        if (voicePhrases.has(phrase)) throw new Error('home_voice_phrase_conflict');
        voicePhrases.add(phrase);
      }
      quickActionIds.add(action.quickActionId);
      return action;
    });
    const sceneIds = new Set<string>();
    this.scenes = (home.automation?.scenes ?? []).map((rawScene) => {
      const scene = normalizeScene(rawScene);
      if (!scene || sceneIds.has(scene.sceneId)) throw new Error('home_config_invalid');
      for (const step of scene.steps) {
        const mapping = mappingsByDeviceId.get(step.deviceId);
        const preset = mapping ? getHomePreset(mapping.presetId) : undefined;
        if (!preset?.capabilities.includes(step.action)) throw new Error('home_config_invalid');
      }
      for (const phrase of scene.voicePhrases) {
        if (voicePhrases.has(phrase)) throw new Error('home_voice_phrase_conflict');
        voicePhrases.add(phrase);
      }
      sceneIds.add(scene.sceneId);
      return scene;
    });
    const routineIds = new Set<string>();
    this.routines = (home.automation?.routines ?? []).map((rawRoutine) => {
      const routine = normalizeRoutine(rawRoutine);
      if (!routine || routineIds.has(routine.routineId) || !sceneIds.has(routine.sceneId)) {
        throw new Error('home_config_invalid');
      }
      routineIds.add(routine.routineId);
      return routine;
    });
  }

  isWritable(): boolean {
    return this.writable;
  }

  getRevision(): string {
    return this.revision;
  }

  getMapping(deviceId: string): DeviceMapping | undefined {
    return this.mappingsByDeviceId.get(deviceId);
  }

  getQuickActions(): HomeQuickAction[] {
    return structuredClone(this.quickActions).sort(
      (left, right) => left.sortOrder - right.sortOrder || left.name.localeCompare(right.name, 'fr')
    );
  }

  getQuickAction(quickActionId: string): HomeQuickAction | undefined {
    return this.getQuickActions().find((action) => action.quickActionId === quickActionId);
  }

  findQuickActionByVoicePhrase(text: string): HomeQuickAction | undefined {
    const normalized = normalizeVoiceCommand(text);
    return this.getQuickActions().find((action) => action.voicePhrases.includes(normalized));
  }

  inferDeterministicVoiceAction(text: string): DeterministicHomeVoiceAction | undefined {
    const televisions = [...this.mappingsByDeviceId.values()]
      .filter((mapping) => mapping.presetId === 'television' && mapping.entityId?.startsWith('media_player.'))
      .map((mapping) => ({ deviceId: mapping.deviceId, name: mapping.name }));
    return inferDeterministicTvVolumeAction(text, televisions);
  }

  getScenes(): HomeScene[] {
    return structuredClone(this.scenes).sort(
      (left, right) => left.sortOrder - right.sortOrder || left.name.localeCompare(right.name, 'fr')
    );
  }

  getScene(sceneId: string): HomeScene | undefined {
    return this.getScenes().find((scene) => scene.sceneId === sceneId);
  }

  findSceneByVoicePhrase(text: string): HomeScene | undefined {
    const normalized = normalizeVoiceCommand(text);
    return this.getScenes().find((scene) => scene.voicePhrases.includes(normalized));
  }

  getRoutines(): HomeRoutine[] {
    return structuredClone(this.routines).sort((left, right) => left.name.localeCompare(right.name, 'fr'));
  }

  upsertScene(input: UpsertHomeScene): void {
    if (!this.writable) throw new Error('home_config_read_only');
    if (input.expectedRevision !== this.revision) throw new Error('home_config_conflict');
    const scene = normalizeScene({ ...input, sortOrder: input.sortOrder ?? this.scenes.length });
    if (!scene) throw new Error('home_scene_invalid');
    for (const step of scene.steps) {
      const mapping = this.mappingsByDeviceId.get(step.deviceId);
      const preset = mapping ? getHomePreset(mapping.presetId) : undefined;
      if (!preset?.capabilities.includes(step.action)) throw new Error('home_scene_invalid');
    }
    const reservedPhrases = [...this.quickActions, ...this.scenes.filter((item) => item.sceneId !== scene.sceneId)]
      .flatMap((item) => item.voicePhrases);
    if (scene.voicePhrases.some((phrase) => reservedPhrases.includes(phrase))) {
      throw new Error('home_voice_phrase_conflict');
    }
    const nextHome = structuredClone(this.home);
    nextHome.automation = {
      ...nextHome.automation,
      spaces: nextHome.automation?.spaces ?? [],
      quickActions: nextHome.automation?.quickActions ?? [],
      scenes: [...(nextHome.automation?.scenes ?? []).filter((item) => item.sceneId !== scene.sceneId), scene],
      routines: nextHome.automation?.routines ?? [],
    };
    this.persist(nextHome);
  }

  deleteScene(sceneId: string, expectedRevision: string): void {
    if (!this.writable) throw new Error('home_config_read_only');
    if (expectedRevision !== this.revision) throw new Error('home_config_conflict');
    if (!this.scenes.some((scene) => scene.sceneId === sceneId)) throw new Error('home_scene_not_found');
    const nextHome = structuredClone(this.home);
    nextHome.automation = {
      ...nextHome.automation,
      spaces: nextHome.automation?.spaces ?? [],
      quickActions: nextHome.automation?.quickActions ?? [],
      scenes: (nextHome.automation?.scenes ?? []).filter((scene) => scene.sceneId !== sceneId),
      routines: (nextHome.automation?.routines ?? []).filter((routine) => routine.sceneId !== sceneId),
    };
    this.persist(nextHome);
  }

  upsertRoutine(input: UpsertHomeRoutine): void {
    if (!this.writable) throw new Error('home_config_read_only');
    if (input.expectedRevision !== this.revision) throw new Error('home_config_conflict');
    const routine = normalizeRoutine(input);
    if (!routine || !this.scenes.some((scene) => scene.sceneId === routine.sceneId)) {
      throw new Error('home_routine_invalid');
    }
    const nextHome = structuredClone(this.home);
    nextHome.automation = {
      ...nextHome.automation,
      spaces: nextHome.automation?.spaces ?? [],
      quickActions: nextHome.automation?.quickActions ?? [],
      scenes: nextHome.automation?.scenes ?? [],
      routines: [...(nextHome.automation?.routines ?? []).filter((item) => item.routineId !== routine.routineId), routine],
    };
    this.persist(nextHome);
  }

  deleteRoutine(routineId: string, expectedRevision: string): void {
    if (!this.writable) throw new Error('home_config_read_only');
    if (expectedRevision !== this.revision) throw new Error('home_config_conflict');
    if (!this.routines.some((routine) => routine.routineId === routineId)) throw new Error('home_routine_not_found');
    const nextHome = structuredClone(this.home);
    nextHome.automation = {
      ...nextHome.automation,
      spaces: nextHome.automation?.spaces ?? [],
      quickActions: nextHome.automation?.quickActions ?? [],
      scenes: nextHome.automation?.scenes ?? [],
      routines: (nextHome.automation?.routines ?? []).filter((routine) => routine.routineId !== routineId),
    };
    this.persist(nextHome);
  }

  upsertQuickAction(input: UpsertHomeQuickAction): void {
    if (!this.writable) throw new Error('home_config_read_only');
    if (input.expectedRevision !== this.revision) throw new Error('home_config_conflict');
    const action = normalizeQuickAction({
      ...input,
      sortOrder: input.sortOrder ?? this.quickActions.length,
    });
    const mapping = action ? this.mappingsByDeviceId.get(action.deviceId) : undefined;
    const preset = mapping ? getHomePreset(mapping.presetId) : undefined;
    if (!action || !mapping || !preset?.capabilities.includes(action.action)) {
      throw new Error('home_quick_action_invalid');
    }
    const collision = this.quickActions.some(
      (candidate) =>
        candidate.quickActionId !== action.quickActionId &&
        candidate.voicePhrases.some((phrase) => action.voicePhrases.includes(phrase))
    );
    if (collision) throw new Error('home_voice_phrase_conflict');
    const nextHome = structuredClone(this.home);
    const spaces = nextHome.automation?.spaces ?? [];
    const quickActions = (nextHome.automation?.quickActions ?? []).filter(
      (candidate) => candidate.quickActionId !== action.quickActionId
    );
    nextHome.automation = { ...nextHome.automation, spaces, quickActions: [...quickActions, action] };
    this.persist(nextHome);
  }

  deleteQuickAction(quickActionId: string, expectedRevision: string): void {
    if (!this.writable) throw new Error('home_config_read_only');
    if (expectedRevision !== this.revision) throw new Error('home_config_conflict');
    if (!this.quickActions.some((action) => action.quickActionId === quickActionId)) {
      throw new Error('home_quick_action_not_found');
    }
    const nextHome = structuredClone(this.home);
    nextHome.automation = {
      ...nextHome.automation,
      spaces: nextHome.automation?.spaces ?? [],
      quickActions: (nextHome.automation?.quickActions ?? []).filter(
        (action) => action.quickActionId !== quickActionId
      ),
    };
    this.persist(nextHome);
  }

  getMappedEntities(): Array<{ deviceId: string; entityId: string }> {
    return [...this.mappingsByDeviceId.values()].flatMap((mapping) =>
      mapping.entityId ? [{ deviceId: mapping.deviceId, entityId: mapping.entityId }] : []
    );
  }

  hasEntityId(entityId: string): boolean {
    return [...this.mappingsByDeviceId.values()].some((mapping) => mapping.entityId === entityId);
  }

  upsertDevice(input: UpsertHomeDevice): void {
    if (!this.writable) throw new Error('home_config_read_only');
    if (input.expectedRevision !== this.revision) throw new Error('home_config_conflict');
    const nextHome = structuredClone(this.home);
    const room = nextHome.rooms.find((candidate) => candidate.roomId === input.roomId);
    if (!room) throw new Error('home_room_not_found');
    const current = this.mappingsByDeviceId.get(input.deviceId);
    const mapping = normalizeMapping({
      ...input,
      ...(current?.presetId === input.presetId && current.entityId === input.entityId && current.robot
        ? { robot: current.robot }
        : {}),
      ...(current?.presetId === input.presetId && current.entityId === input.entityId && current.television
        ? { television: current.television }
        : {}),
      ...(current?.presetId === input.presetId && current.entityId === input.entityId && current.climate
        ? { climate: current.climate }
        : {}),
      ...(current?.presetId === input.presetId && current.entityId === input.entityId && current.environment
        ? { environment: current.environment }
        : {}),
      ...(current?.presetId === input.presetId && current.entityId === input.entityId && current.waterHeater
        ? { waterHeater: current.waterHeater }
        : {}),
    }, room);
    if (!mapping) throw new Error('home_device_invalid');
    const duplicateEntity = input.entityId
      ? [...this.mappingsByDeviceId.values()].find(
          (candidate) =>
            candidate.entityId === input.entityId && candidate.deviceId !== input.deviceId
        )
      : undefined;
    if (duplicateEntity) throw new Error('home_entity_already_mapped');
    const spaces = nextHome.automation?.spaces ?? [];
    for (const space of spaces) {
      space.entities = (space.entities ?? []).filter((candidate) => {
        const candidateId =
          typeof candidate === 'string' ? candidate.replace('.', '_') : candidate.deviceId;
        return candidateId !== input.deviceId;
      });
    }
    let target = spaces.find((space) => space.roomId === input.roomId);
    if (!target) {
      target = { roomId: input.roomId, entities: [] };
      spaces.push(target);
    }
    target.entities = [...(target.entities ?? []), mapping];
    nextHome.automation = {
      ...nextHome.automation,
      spaces,
      quickActions: nextHome.automation?.quickActions ?? [],
    };
    this.persist(nextHome);
  }

  deleteDevice(deviceId: string, expectedRevision: string): void {
    if (!this.writable) throw new Error('home_config_read_only');
    if (expectedRevision !== this.revision) throw new Error('home_config_conflict');
    if (!this.mappingsByDeviceId.has(deviceId)) throw new Error('home_device_not_found');
    const nextHome = structuredClone(this.home);
    for (const space of nextHome.automation?.spaces ?? []) {
      space.entities = (space.entities ?? []).filter((candidate) => {
        const candidateId =
          typeof candidate === 'string' ? candidate.replace('.', '_') : candidate.deviceId;
        return candidateId !== deviceId;
      });
    }
    if (nextHome.automation) {
      nextHome.automation.quickActions = (nextHome.automation.quickActions ?? []).filter(
        (action) => action.deviceId !== deviceId
      );
      nextHome.automation.scenes = (nextHome.automation.scenes ?? []).filter(
        (scene) => !scene.steps.some((step) => step.deviceId === deviceId)
      );
      const remainingSceneIds = new Set((nextHome.automation.scenes ?? []).map((scene) => scene.sceneId));
      nextHome.automation.routines = (nextHome.automation.routines ?? []).filter(
        (routine) => remainingSceneIds.has(routine.sceneId)
      );
    }
    this.persist(nextHome);
  }

  private persist(nextHome: HomeFile): void {
    const temporary = `${this.homeFile}.${randomUUID()}.tmp`;
    const rollback = `${this.homeFile}.${randomUUID()}.rollback.tmp`;
    const backup = `${this.homeFile}.previous`;
    const previous = readFileSync(this.homeFile, 'utf8');
    const serialized = `${JSON.stringify(nextHome, null, 2)}\n`;
    validateHome(JSON.parse(serialized) as unknown, this.homeId);
    try {
      mkdirSync(dirname(this.homeFile), { recursive: true });
      writeFileSync(temporary, serialized, { flag: 'wx', mode: 0o600 });
      copyFileSync(this.homeFile, backup);
      renameSync(temporary, this.homeFile);
      this.reload();
    } catch (error) {
      try {
        writeFileSync(rollback, previous, { flag: 'wx', mode: 0o600 });
        renameSync(rollback, this.homeFile);
        this.reload();
      } catch {
        // Preserve the original failure; the .previous file remains available for recovery.
      }
      throw error;
    } finally {
      rmSync(temporary, { force: true });
      rmSync(rollback, { force: true });
    }
  }

  async snapshot(ha?: HomeAssistantClient): Promise<HomeSnapshot> {
    let controlStatus: HomeSnapshot['controlStatus'] = ha ? 'ready' : 'not_configured';
    let raw: unknown = [];
    if (ha) {
      try {
        raw = await ha.getStates();
        if (!Array.isArray(raw)) controlStatus = 'offline';
      } catch {
        controlStatus = 'offline';
      }
    }
    const states = new Map(
      (Array.isArray(raw) ? raw : []).filter(isHassState).map((state) => [state.entity_id, state])
    );
    const devices: HomeDevice[] = [];
    for (const [roomId, mappings] of this.mappingsByRoom) {
      for (const mapping of mappings) {
        const state = mapping.entityId ? states.get(mapping.entityId) : undefined;
        const attributes =
          state?.attributes && typeof state.attributes === 'object'
            ? (state.attributes as Record<string, unknown>)
            : {};
        const preset = getHomePreset(mapping.presetId) as HomePreset;
        const targetTemperature =
          ['climate', 'water_heater'].includes(preset.domain) && typeof attributes.temperature === 'number'
            ? attributes.temperature
            : undefined;
        const primarySensorValue = preset.domain === 'sensor'
          && attributes.device_class === 'temperature'
          && state
          && Number.isFinite(Number(state.state))
          ? Number(state.state)
          : undefined;
        const currentTemperature = ['climate', 'water_heater'].includes(preset.domain) && typeof attributes.current_temperature === 'number'
          ? attributes.current_temperature : primarySensorValue;
        const minTemperature = ['climate', 'water_heater'].includes(preset.domain) && typeof attributes.min_temp === 'number'
          ? attributes.min_temp : undefined;
        const maxTemperature = ['climate', 'water_heater'].includes(preset.domain) && typeof attributes.max_temp === 'number'
          ? attributes.max_temp : undefined;
        const temperatureStep = ['climate', 'water_heater'].includes(preset.domain) && typeof attributes.target_temp_step === 'number'
          ? attributes.target_temp_step : undefined;
        const stringOptions = (value: unknown, limit = 20): string[] | undefined => Array.isArray(value)
          ? value.filter((option): option is string => typeof option === 'string').slice(0, limit)
          : undefined;
        const volumeLevel =
          preset.domain === 'media_player' && typeof attributes.volume_level === 'number'
            ? Math.round(attributes.volume_level * 100)
            : undefined;
        const sourceList =
          preset.domain === 'media_player' && Array.isArray(attributes.source_list)
            ? attributes.source_list.filter((value): value is string => typeof value === 'string').slice(0, 100)
            : undefined;
        const soundOutputList =
          preset.domain === 'media_player' && Array.isArray(attributes.sound_output_list)
            ? attributes.sound_output_list.filter((value): value is string => typeof value === 'string').slice(0, 50)
            : undefined;
        const companionState = (entityId: string | undefined) => entityId ? states.get(entityId) : undefined;
        const batteryState = companionState(mapping.robot?.batteryEntityId);
        const offsetState = companionState(mapping.climate?.offsetEntityId);
        const windowState = companionState(mapping.climate?.windowEntityId);
        const presenceState = companionState(mapping.climate?.presenceEntityId);
        const childLockState = companionState(mapping.climate?.childLockEntityId);
        const preheatingState = companionState(mapping.climate?.preheatingEntityId);
        const environmentBatteryState = companionState(mapping.environment?.batteryEntityId);
        const ecoState = companionState(mapping.waterHeater?.ecoEntityId);
        const boostState = companionState(mapping.waterHeater?.boostEntityId);
        const antiLegionellaState = companionState(mapping.waterHeater?.antiLegionellaEntityId);
        const heatingState = companionState(mapping.waterHeater?.heatingEntityId);
        const chargingState = companionState(mapping.robot?.chargingStateEntityId);
        const suctionModeState = companionState(mapping.robot?.suctionModeEntityId);
        const mopModeState = companionState(mapping.robot?.mopModeEntityId);
        const numericCompanion = (entityId: string | undefined): number | undefined => {
          const candidate = companionState(entityId);
          const parsed = candidate ? Number(candidate.state) : Number.NaN;
          return Number.isFinite(parsed) ? parsed : undefined;
        };
        const percentageCompanion = (entityId: string | undefined): number | undefined => {
          const candidate = numericCompanion(entityId);
          return candidate === undefined ? undefined : Math.max(0, Math.min(100, Math.round(candidate)));
        };
        const batteryLevel = batteryState && Number.isFinite(Number(batteryState.state))
          ? Math.max(0, Math.min(100, Math.round(Number(batteryState.state))))
          : undefined;
        const selectOptions = (candidate: typeof suctionModeState): string[] | undefined => {
          const options = candidate?.attributes && typeof candidate.attributes === 'object'
            ? (candidate.attributes as Record<string, unknown>).options
            : undefined;
          return Array.isArray(options)
            ? options.filter((option): option is string => typeof option === 'string').slice(0, 20)
            : undefined;
        };
        const suctionModeOptions = selectOptions(suctionModeState);
        const mopModeOptions = selectOptions(mopModeState);
        const cleaningTimeMinutes = numericCompanion(mapping.robot?.cleaningTimeEntityId);
        const cleaningAreaM2 = numericCompanion(mapping.robot?.cleaningAreaEntityId);
        const dryingTimeRemainingMinutes = numericCompanion(mapping.robot?.dryingTimeRemainingEntityId);
        const totalCleaningTimeMinutes = numericCompanion(mapping.robot?.totalCleaningTimeEntityId);
        const totalCleaningCount = numericCompanion(mapping.robot?.totalCleaningCountEntityId);
        const totalCleaningAreaM2 = numericCompanion(mapping.robot?.totalCleaningAreaEntityId);
        const mainBrushLifePercent = percentageCompanion(mapping.robot?.mainBrushLifeEntityId);
        const sideBrushLifePercent = percentageCompanion(mapping.robot?.sideBrushLifeEntityId);
        const filterLifePercent = percentageCompanion(mapping.robot?.filterLifeEntityId);
        const mopLifePercent = percentageCompanion(mapping.robot?.mopLifeEntityId);
        const capabilities = preset.capabilities.filter((action) => {
          if (action === 'locate') return Boolean(mapping.robot?.locateEntityId);
          if (action === 'set_suction_mode') return Boolean(mapping.robot?.suctionModeEntityId);
          if (action === 'set_mop_mode') return Boolean(mapping.robot?.mopModeEntityId);
          if (action === 'empty_dust_bin') return Boolean(mapping.robot?.emptyDustBinEntityId);
          if (action === 'wash_mop') return Boolean(mapping.robot?.washMopEntityId);
          if (action === 'start_mop_drying') return Boolean(mapping.robot?.startMopDryingEntityId);
          if (action === 'stop_mop_drying') return Boolean(mapping.robot?.stopMopDryingEntityId);
          if (action === 'set_hvac_mode') return Boolean(stringOptions(attributes.hvac_modes)?.length);
          if (action === 'set_preset_mode') return Boolean(stringOptions(attributes.preset_modes)?.length);
          if (action === 'set_temperature_offset') return Boolean(mapping.climate?.offsetEntityId);
          if (action === 'set_child_lock') return Boolean(mapping.climate?.childLockEntityId);
          if (action === 'set_preheating') return Boolean(mapping.climate?.preheatingEntityId);
          if (action === 'set_operation_mode') return Boolean(stringOptions(attributes.operation_list)?.length);
          if (action === 'set_away_mode') return typeof attributes.away_mode === 'boolean';
          if (action === 'set_eco_mode') return Boolean(mapping.waterHeater?.ecoEntityId);
          if (action === 'set_boost_mode') return Boolean(mapping.waterHeater?.boostEntityId);
          if (action === 'set_antilegionella') return Boolean(mapping.waterHeater?.antiLegionellaEntityId);
          return true;
        });
        devices.push({
          deviceId: mapping.deviceId,
          roomId,
          domain: preset.domain,
          name:
            mapping.name ??
            (typeof attributes.friendly_name === 'string'
              ? attributes.friendly_name
              : preset.label),
          state: state?.state ?? (mapping.entityId ? 'unavailable' : 'not_configured'),
          available: Boolean(state && !['unavailable', 'unknown'].includes(state.state)),
          mapped: Boolean(mapping.entityId),
          presetId: preset.presetId,
          placement: mapping.placement,
          capabilities,
          riskLevel: preset.riskLevel,
          ...(targetTemperature === undefined ? {} : { targetTemperature }),
          ...(currentTemperature === undefined ? {} : { currentTemperature }),
          ...(minTemperature === undefined ? {} : { minTemperature }),
          ...(maxTemperature === undefined ? {} : { maxTemperature }),
          ...(temperatureStep === undefined ? {} : { temperatureStep }),
          ...(preset.domain === 'climate' && state ? { hvacMode: state.state } : {}),
          ...(stringOptions(attributes.hvac_modes) ? { hvacModes: stringOptions(attributes.hvac_modes) } : {}),
          ...(typeof attributes.hvac_action === 'string' ? { hvacAction: attributes.hvac_action } : {}),
          ...(typeof attributes.preset_mode === 'string' ? { presetMode: attributes.preset_mode } : {}),
          ...(stringOptions(attributes.preset_modes) ? { presetModes: stringOptions(attributes.preset_modes) } : {}),
          ...(offsetState && Number.isFinite(Number(offsetState.state)) ? { temperatureOffset: Number(offsetState.state) } : {}),
          ...(offsetState?.attributes && typeof offsetState.attributes === 'object' && typeof (offsetState.attributes as Record<string, unknown>).min === 'number' ? { temperatureOffsetMin: (offsetState.attributes as Record<string, number>).min } : {}),
          ...(offsetState?.attributes && typeof offsetState.attributes === 'object' && typeof (offsetState.attributes as Record<string, unknown>).max === 'number' ? { temperatureOffsetMax: (offsetState.attributes as Record<string, number>).max } : {}),
          ...(offsetState?.attributes && typeof offsetState.attributes === 'object' && typeof (offsetState.attributes as Record<string, unknown>).step === 'number' ? { temperatureOffsetStep: (offsetState.attributes as Record<string, number>).step } : {}),
          ...(windowState ? { windowOpen: windowState.state === 'on' } : {}),
          ...(presenceState ? { presenceDetected: presenceState.state === 'on' } : {}),
          ...(childLockState ? { childLock: childLockState.state === 'on' } : {}),
          ...(preheatingState ? { preheating: preheatingState.state === 'on' } : {}),
          ...(numericCompanion(mapping.climate?.powerEntityId) === undefined ? {} : { activePowerWatts: numericCompanion(mapping.climate?.powerEntityId) }),
          ...(numericCompanion(mapping.climate?.energyEntityId) === undefined ? {} : { energyKwh: numericCompanion(mapping.climate?.energyEntityId) }),
          ...(numericCompanion(mapping.environment?.humidityEntityId) === undefined ? {} : { humidityPercent: numericCompanion(mapping.environment?.humidityEntityId) }),
          ...(environmentBatteryState && Number.isFinite(Number(environmentBatteryState.state)) ? { batteryLevel: Math.max(0, Math.min(100, Math.round(Number(environmentBatteryState.state)))) } : {}),
          ...(typeof attributes.current_operation === 'string' ? { operationMode: attributes.current_operation } : {}),
          ...(stringOptions(attributes.operation_list) ? { operationModes: stringOptions(attributes.operation_list) } : {}),
          ...(typeof attributes.away_mode === 'boolean' ? { awayMode: attributes.away_mode } : {}),
          ...(ecoState ? { ecoMode: ecoState.state === 'on' } : {}),
          ...(boostState ? { boostMode: boostState.state === 'on' } : {}),
          ...(antiLegionellaState ? { antiLegionella: antiLegionellaState.state === 'on' } : {}),
          ...(heatingState ? { heatingActive: heatingState.state === 'on' } : {}),
          ...(numericCompanion(mapping.waterHeater?.powerEntityId) === undefined ? {} : { activePowerWatts: numericCompanion(mapping.waterHeater?.powerEntityId) }),
          ...(numericCompanion(mapping.waterHeater?.energyEntityId) === undefined ? {} : { energyKwh: numericCompanion(mapping.waterHeater?.energyEntityId) }),
          ...(numericCompanion(mapping.waterHeater?.showersEntityId) === undefined ? {} : { showersAvailable: numericCompanion(mapping.waterHeater?.showersEntityId) }),
          ...(numericCompanion(mapping.waterHeater?.heatingTimeEntityId) === undefined ? {} : { heatingTimeMinutes: numericCompanion(mapping.waterHeater?.heatingTimeEntityId) }),
          ...(volumeLevel === undefined ? {} : { volumeLevel }),
          ...(typeof attributes.is_volume_muted === 'boolean' ? { muted: attributes.is_volume_muted } : {}),
          ...(typeof attributes.source === 'string' ? { source: attributes.source } : {}),
          ...(sourceList === undefined ? {} : { sourceList }),
          ...(typeof attributes.media_title === 'string' ? { mediaTitle: attributes.media_title } : {}),
          ...(typeof attributes.media_artist === 'string' ? { mediaArtist: attributes.media_artist } : {}),
          ...(typeof attributes.sound_output === 'string' ? { soundOutput: attributes.sound_output } : {}),
          ...(soundOutputList === undefined ? {} : { soundOutputList }),
          ...(batteryLevel === undefined ? {} : { batteryLevel }),
          ...(chargingState ? { chargingState: chargingState.state } : {}),
          ...(suctionModeState ? { suctionMode: suctionModeState.state } : {}),
          ...(suctionModeOptions ? { suctionModeOptions } : {}),
          ...(mopModeState ? { mopMode: mopModeState.state } : {}),
          ...(mopModeOptions ? { mopModeOptions } : {}),
          ...(cleaningTimeMinutes === undefined ? {} : { cleaningTimeMinutes }),
          ...(cleaningAreaM2 === undefined ? {} : { cleaningAreaM2 }),
          ...(dryingTimeRemainingMinutes === undefined ? {} : { dryingTimeRemainingMinutes }),
          ...(totalCleaningTimeMinutes === undefined ? {} : { totalCleaningTimeMinutes }),
          ...(totalCleaningCount === undefined ? {} : { totalCleaningCount }),
          ...(totalCleaningAreaM2 === undefined ? {} : { totalCleaningAreaM2 }),
          ...(mainBrushLifePercent === undefined ? {} : { mainBrushLifePercent }),
          ...(sideBrushLifePercent === undefined ? {} : { sideBrushLifePercent }),
          ...(filterLifePercent === undefined ? {} : { filterLifePercent }),
          ...(mopLifePercent === undefined ? {} : { mopLifePercent }),
        });
      }
    }
    return {
      homeId: this.home.homeId,
      displayName: this.home.displayName,
      controlStatus,
      geometryQuality: this.home.geometry.quality,
      units: this.home.geometry.units,
      revision: this.revision,
      rooms: this.home.rooms.map((room) => ({
        ...room,
        deviceIds: (this.mappingsByRoom.get(room.roomId) ?? []).map((mapping) => mapping.deviceId),
      })),
      devices,
      quickActions: this.getQuickActions(),
      scenes: this.getScenes(),
      routines: this.getRoutines(),
      presets: HOME_PRESETS.map((preset) => ({
        ...preset,
        capabilities: [...preset.capabilities],
      })),
      updatedAt: new Date().toISOString(),
    };
  }
}
