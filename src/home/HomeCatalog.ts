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
};
type RawDeviceMapping =
  | string
  | {
      deviceId: string;
      entityId?: string;
      name?: string;
      presetId?: string;
      placement?: Partial<DevicePlacement>;
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
};
export type HomeSnapshot = {
  homeId: string;
  displayName: string;
  geometryQuality: string;
  units: string;
  revision: string;
  rooms: HomeRoom[];
  devices: HomeDevice[];
  presets: HomePreset[];
  updatedAt: string;
};

type HomeFile = {
  schemaVersion?: string;
  homeId: string;
  displayName: string;
  geometry: { quality: string; units: string };
  rooms: Array<{ roomId: string; name: string; type: string; polygon: Point[] }>;
  automation?: { spaces?: Array<{ roomId: string; entities?: RawDeviceMapping[] }> };
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

const entityIdPattern = /^[a-z_]+\.[a-z0-9_]+$/u;
const deviceIdPattern = /^[a-z0-9][a-z0-9_-]{0,63}$/u;

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
  for (let current = 0, previous = polygon.length - 1; current < polygon.length; previous = current++) {
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
  if (
    !value ||
    !deviceIdPattern.test(value.deviceId) ||
    (entityId !== undefined && !entityIdPattern.test(entityId)) ||
    (value.name !== undefined && (!value.name.trim() || value.name.length > 100)) ||
    !preset ||
    (domain !== undefined && preset.domain !== domain) ||
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
    const mapping = normalizeMapping(input, room);
    if (!mapping) throw new Error('home_device_invalid');
    const duplicateEntity = input.entityId
      ? [...this.mappingsByDeviceId.values()].find(
          (candidate) => candidate.entityId === input.entityId && candidate.deviceId !== input.deviceId
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
    nextHome.automation = { spaces };
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
    const raw = ha ? await ha.getStates().catch(() => []) : [];
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
          preset.domain === 'climate' && typeof attributes.temperature === 'number'
            ? attributes.temperature
            : undefined;
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
          capabilities: [...preset.capabilities],
          riskLevel: preset.riskLevel,
          ...(targetTemperature === undefined ? {} : { targetTemperature }),
        });
      }
    }
    return {
      homeId: this.home.homeId,
      displayName: this.home.displayName,
      geometryQuality: this.home.geometry.quality,
      units: this.home.geometry.units,
      revision: this.revision,
      rooms: this.home.rooms.map((room) => ({
        ...room,
        deviceIds: (this.mappingsByRoom.get(room.roomId) ?? []).map((mapping) => mapping.deviceId),
      })),
      devices,
      presets: HOME_PRESETS.map((preset) => ({ ...preset, capabilities: [...preset.capabilities] })),
      updatedAt: new Date().toISOString(),
    };
  }
}
