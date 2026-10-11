import {
  type HomeAssistantClient,
  HomeAssistantRequestError,
} from '../haClient';
import type { HomeCatalog } from './HomeCatalog';

type AreaRegistryEntry = { area_id: string; name: string };
type EntityRegistryEntry = { entity_id: string; device_id?: string | null };
type DeviceRegistryEntry = {
  id: string;
  area_id?: string | null;
  name?: string | null;
  name_by_user?: string | null;
};

export type HomeAssistantSyncChange =
  | { kind: 'create_area'; roomId: string; roomName: string }
  | { kind: 'update_device'; deviceId: string; name: string; roomName: string };

export type HomeAssistantSyncPreview = {
  changes: HomeAssistantSyncChange[];
  unchanged: number;
  skipped: Array<{ deviceId: string; reason: 'entity_not_registered' | 'entity_without_device' }>;
};

export type HomeAssistantSyncResult = HomeAssistantSyncPreview & {
  operationStatus: 'succeeded';
  applied: number;
};

export class HomeAssistantSyncError extends Error {
  constructor(
    public readonly outcome: 'failed' | 'partial' | 'uncertain',
    public readonly applied: number,
    cause?: unknown
  ) {
    super(`home_assistant_sync_${outcome}`, { cause });
    this.name = 'HomeAssistantSyncError';
  }
}

type SyncState = {
  areas: AreaRegistryEntry[];
  entities: EntityRegistryEntry[];
  devices: DeviceRegistryEntry[];
};

function normalizedName(value: string): string {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/gu, '').trim().toLocaleLowerCase('fr');
}

export class HomeAssistantRegistrySyncService {
  constructor(
    private readonly ha: HomeAssistantClient,
    private readonly catalog: HomeCatalog,
    private readonly wait: (milliseconds: number) => Promise<void> =
      (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))
  ) {}

  private async state(): Promise<SyncState> {
    const [areas, entities, devices] = await Promise.all([
      this.ha.websocketCommand<AreaRegistryEntry[]>({ type: 'config/area_registry/list' }),
      this.ha.websocketCommand<EntityRegistryEntry[]>({ type: 'config/entity_registry/list' }),
      this.ha.websocketCommand<DeviceRegistryEntry[]>({ type: 'config/device_registry/list' }),
    ]);
    return { areas, entities, devices };
  }

  private buildPreview(state: SyncState): HomeAssistantSyncPreview {
    const projection = this.catalog.getHomeAssistantProjection();
    const areasById = new Map(state.areas.map((area) => [area.area_id, area]));
    const areasByName = new Map(state.areas.map((area) => [normalizedName(area.name), area]));
    const targetAreaByRoom = new Map<string, AreaRegistryEntry>();
    const changes: HomeAssistantSyncChange[] = [];

    for (const room of projection.rooms) {
      const existing = (room.areaId ? areasById.get(room.areaId) : undefined)
        ?? areasByName.get(normalizedName(room.name));
      if (existing) targetAreaByRoom.set(room.roomId, existing);
      else changes.push({ kind: 'create_area', roomId: room.roomId, roomName: room.name });
    }

    const entitiesById = new Map(state.entities.map((entity) => [entity.entity_id, entity]));
    const devicesById = new Map(state.devices.map((device) => [device.id, device]));
    const desiredByHaDevice = new Map<string, { roomId: string; deviceId: string }>();
    const skipped: HomeAssistantSyncPreview['skipped'] = [];
    let unchanged = 0;

    for (const device of projection.devices) {
      const entity = entitiesById.get(device.entityId);
      if (!entity) {
        skipped.push({ deviceId: device.deviceId, reason: 'entity_not_registered' });
        continue;
      }
      if (!entity.device_id) {
        skipped.push({ deviceId: device.deviceId, reason: 'entity_without_device' });
        continue;
      }
      const duplicate = desiredByHaDevice.get(entity.device_id);
      if (duplicate && duplicate.roomId !== device.roomId) throw new Error('home_assistant_sync_conflict');
      desiredByHaDevice.set(entity.device_id, { roomId: device.roomId, deviceId: device.deviceId });
      const registryDevice = devicesById.get(entity.device_id);
      if (!registryDevice) {
        skipped.push({ deviceId: device.deviceId, reason: 'entity_without_device' });
        continue;
      }
      const room = projection.rooms.find((candidate) => candidate.roomId === device.roomId);
      const area = targetAreaByRoom.get(device.roomId);
      const needsArea = !area || registryDevice.area_id !== area.area_id;
      const needsName = registryDevice.name_by_user !== device.name;
      if (needsArea || needsName) {
        changes.push({
          kind: 'update_device',
          deviceId: device.deviceId,
          name: device.name,
          roomName: room?.name ?? device.roomId,
        });
      } else unchanged += 1;
    }
    return { changes, unchanged, skipped };
  }

  async preview(): Promise<HomeAssistantSyncPreview> {
    return this.buildPreview(await this.state());
  }

  async apply(): Promise<HomeAssistantSyncResult> {
    const projection = this.catalog.getHomeAssistantProjection();
    const initialState = await this.state();
    const preview = this.buildPreview(initialState);
    let applied = 0;

    try {
      for (const change of preview.changes.filter((item) => item.kind === 'create_area')) {
        await this.ha.websocketCommand<AreaRegistryEntry>({
          type: 'config/area_registry/create',
          name: change.roomName,
        }, { mutation: true });
        applied += 1;
      }

      const current = await this.state();
      const areasById = new Map(current.areas.map((area) => [area.area_id, area]));
      const areasByName = new Map(current.areas.map((area) => [normalizedName(area.name), area]));
      const entitiesById = new Map(current.entities.map((entity) => [entity.entity_id, entity]));
      const devicesById = new Map(current.devices.map((device) => [device.id, device]));
      const roomsById = new Map(projection.rooms.map((room) => [room.roomId, room]));

      for (const mapping of projection.devices) {
        const entity = entitiesById.get(mapping.entityId);
        if (!entity?.device_id) continue;
        const registryDevice = devicesById.get(entity.device_id);
        const room = roomsById.get(mapping.roomId);
        if (!registryDevice || !room) continue;
        const area = (room.areaId ? areasById.get(room.areaId) : undefined)
          ?? areasByName.get(normalizedName(room.name));
        if (!area) throw new Error('home_assistant_sync_area_missing');
        if (registryDevice.area_id === area.area_id && registryDevice.name_by_user === mapping.name) continue;
        await this.ha.websocketCommand({
          type: 'config/device_registry/update',
          device_id: registryDevice.id,
          area_id: area.area_id,
          name_by_user: mapping.name,
        }, { mutation: true });
        applied += 1;
      }
      let finalPreview: HomeAssistantSyncPreview | null = null;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        if (attempt > 0) await this.wait(250);
        finalPreview = this.buildPreview(await this.state());
        if (finalPreview.changes.length === 0) {
          return { ...finalPreview, operationStatus: 'succeeded', applied };
        }
      }
      throw new HomeAssistantSyncError('uncertain', applied);
    } catch (error) {
      if (error instanceof HomeAssistantSyncError) throw error;
      const outcome = error instanceof HomeAssistantRequestError && error.operationMayHaveBeenAccepted
        ? 'uncertain'
        : applied > 0
          ? 'partial'
          : 'failed';
      throw new HomeAssistantSyncError(outcome, applied, error);
    }
  }
}
