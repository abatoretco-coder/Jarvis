import { describe, expect, jest, test } from '@jest/globals';

import { type HomeAssistantClient,HomeAssistantRequestError } from '../src/haClient';
import { HomeAssistantRegistrySyncService } from '../src/home/HomeAssistantRegistrySyncService';
import type { HomeCatalog } from '../src/home/HomeCatalog';

const projection = {
  rooms: [{ roomId: 'living', name: 'Séjour', areaId: 'salon' }],
  devices: [{
    deviceId: 'living-tv',
    roomId: 'living',
    entityId: 'media_player.lg_tv',
    name: 'TV',
  }],
};

function catalog() {
  return { getHomeAssistantProjection: jest.fn(() => projection) } as unknown as HomeCatalog;
}

describe('HomeAssistantRegistrySyncService', () => {
  test('previews a non-destructive device alignment against an existing area', async () => {
    const websocketCommand = jest.fn(async (command: { type: string }) => {
      if (command.type === 'config/area_registry/list') return [{ area_id: 'salon', name: 'Salon' }];
      if (command.type === 'config/entity_registry/list') return [{ entity_id: 'media_player.lg_tv', device_id: 'ha-tv' }];
      if (command.type === 'config/device_registry/list') return [{ id: 'ha-tv', area_id: null, name_by_user: null }];
      throw new Error('unexpected_command');
    });
    const service = new HomeAssistantRegistrySyncService(
      { websocketCommand } as unknown as HomeAssistantClient,
      catalog()
    );

    await expect(service.preview()).resolves.toEqual({
      changes: [{ kind: 'update_device', deviceId: 'living-tv', name: 'TV', roomName: 'Séjour' }],
      unchanged: 0,
      skipped: [],
      conflicts: [],
    });
  });

  test('reports direct Home Assistant edits as conflicts and never overwrites them', async () => {
    const websocketCommand = jest.fn(async (command: Record<string, unknown>) => {
      if (command.type === 'config/area_registry/list') return [{ area_id: 'salon', name: 'Salon' }];
      if (command.type === 'config/entity_registry/list') return [{ entity_id: 'media_player.lg_tv', device_id: 'ha-tv' }];
      if (command.type === 'config/device_registry/list') {
        return [{ id: 'ha-tv', area_id: 'salon', name_by_user: 'Télé du séjour' }];
      }
      throw new Error('unexpected_mutation');
    });
    const service = new HomeAssistantRegistrySyncService(
      { websocketCommand } as unknown as HomeAssistantClient,
      catalog()
    );

    await expect(service.apply()).resolves.toMatchObject({
      operationStatus: 'succeeded',
      applied: 0,
      changes: [],
      conflicts: [{
        deviceIds: ['living-tv'],
        reason: 'name_changed_in_home_assistant',
        current: 'Télé du séjour',
        desired: 'TV',
      }],
    });
    expect(websocketCommand).not.toHaveBeenCalledWith(expect.objectContaining({
      type: 'config/device_registry/update',
    }));
  });

  test('creates missing areas, updates devices, and verifies convergence', async () => {
    let created = false;
    let updated = false;
    const websocketCommand = jest.fn(async (command: Record<string, unknown>) => {
      if (command.type === 'config/area_registry/list') {
        return created ? [{ area_id: 'sejour', name: 'Séjour' }] : [];
      }
      if (command.type === 'config/entity_registry/list') {
        return [{ entity_id: 'media_player.lg_tv', device_id: 'ha-tv' }];
      }
      if (command.type === 'config/device_registry/list') {
        return [{ id: 'ha-tv', area_id: updated ? 'sejour' : null, name_by_user: updated ? 'TV' : null }];
      }
      if (command.type === 'config/area_registry/create') {
        created = true;
        return { area_id: 'sejour', name: 'Séjour' };
      }
      if (command.type === 'config/device_registry/update') {
        updated = true;
        return { id: 'ha-tv' };
      }
      throw new Error('unexpected_command');
    });
    const service = new HomeAssistantRegistrySyncService(
      { websocketCommand } as unknown as HomeAssistantClient,
      catalog()
    );

    await expect(service.apply()).resolves.toMatchObject({
      operationStatus: 'succeeded',
      applied: 2,
      changes: [],
    });
  });

  test('reports an uncertain result without retrying a registry mutation', async () => {
    const websocketCommand = jest.fn(async (command: Record<string, unknown>) => {
      if (command.type === 'config/area_registry/list') return [];
      if (command.type === 'config/entity_registry/list') return [{ entity_id: 'media_player.lg_tv', device_id: 'ha-tv' }];
      if (command.type === 'config/device_registry/list') return [{ id: 'ha-tv', area_id: null, name_by_user: null }];
      throw new HomeAssistantRequestError('socket closed', 'transport', true);
    });
    const service = new HomeAssistantRegistrySyncService(
      { websocketCommand } as unknown as HomeAssistantClient,
      catalog()
    );

    await expect(service.apply()).rejects.toMatchObject({
      outcome: 'uncertain',
      applied: 0,
      failures: [{
        change: { kind: 'create_area', roomId: 'living', roomName: 'Séjour' },
        reason: 'request_failed',
      }],
    });
    expect(websocketCommand).toHaveBeenCalledTimes(4);
  });
});
