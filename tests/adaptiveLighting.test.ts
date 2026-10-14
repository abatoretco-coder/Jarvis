import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, jest, test } from '@jest/globals';

import { createConversationDb } from '../src/conversation/repositories/SqliteRepositories';
import type { HomeAssistantClient } from '../src/haClient';
import { resolveAdaptiveLightingTarget, resolveLightingPhase } from '../src/home/AdaptiveLightingPolicy';
import { HomeAdaptiveLightingService } from '../src/home/HomeAdaptiveLightingService';
import { type AdaptiveLightingRoomConfig, HomeCatalog } from '../src/home/HomeCatalog';
import { HomeRuntimeStateRepository } from '../src/home/HomeRuntimeStateRepository';

const roots: string[] = [];
afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

const room: AdaptiveLightingRoomConfig = {
  roomId: 'living',
  deviceIds: ['living-light'],
  phases: {
    dawn: { brightnessPercent: 45, colorTemperatureKelvin: 3_200 },
    day: { brightnessPercent: 55, colorTemperatureKelvin: 3_900 },
    dusk: { brightnessPercent: 35, colorTemperatureKelvin: 2_800 },
    night: { brightnessPercent: 40, colorTemperatureKelvin: 2_600 },
  },
  dimmedPhases: {
    dawn: { brightnessPercent: 15, colorTemperatureKelvin: 2_500 },
    day: { brightnessPercent: 20, colorTemperatureKelvin: 2_800 },
    dusk: { brightnessPercent: 12, colorTemperatureKelvin: 2_400 },
    night: { brightnessPercent: 8, colorTemperatureKelvin: 2_200 },
  },
};

describe('room lighting target policy', () => {
  test('uses fixed Europe/Paris winter hours independently of the sun', () => {
    expect(resolveLightingPhase(new Date('2026-01-15T05:59:00.000Z'))).toBe('night');
    expect(resolveLightingPhase(new Date('2026-01-15T06:00:00.000Z'))).toBe('dawn');
    expect(resolveLightingPhase(new Date('2026-01-15T08:00:00.000Z'))).toBe('day');
    expect(resolveLightingPhase(new Date('2026-01-15T17:00:00.000Z'))).toBe('dusk');
    expect(resolveLightingPhase(new Date('2026-01-15T22:00:00.000Z'))).toBe('night');
  });

  test('starts evening at 20:00 in summer and morning ends at 10:00 on weekends', () => {
    expect(resolveLightingPhase(new Date('2026-07-15T17:59:00.000Z'))).toBe('day');
    expect(resolveLightingPhase(new Date('2026-07-15T18:00:00.000Z'))).toBe('dusk');
    expect(resolveLightingPhase(new Date('2026-01-17T08:59:00.000Z'))).toBe('dawn');
    expect(resolveLightingPhase(new Date('2026-01-17T09:00:00.000Z'))).toBe('day');
  });

  test('uses only the configured room curves', () => {
    const on = resolveAdaptiveLightingTarget({
      room,
      mode: 'on',
      now: new Date('2026-01-15T12:00:00.000Z'),
    });
    const dimmed = resolveAdaptiveLightingTarget({
      room,
      mode: 'dimmed',
      now: new Date('2026-01-15T12:00:00.000Z'),
    });

    expect(on).toEqual({ phase: 'day', brightnessPercent: 55, colorTemperatureKelvin: 3_900 });
    expect(dimmed).toMatchObject({ brightnessPercent: 20, colorTemperatureKelvin: 2_800 });
  });
});

function fixture(includeFutureLight = false, includeSmartPlugLamp = false, dimmedOffDeviceIds: string[] = []): HomeCatalog {
  const root = mkdtempSync(join(tmpdir(), 'jarvis-room-lighting-'));
  roots.push(root);
  const folder = join(root, 'home-test');
  mkdirSync(folder);
  writeFileSync(join(folder, 'home.json'), JSON.stringify({
    homeId: 'home-test',
    displayName: 'Chez moi',
    geometry: { quality: 'test', units: 'm' },
    rooms: [{ roomId: 'living', name: 'Salon', type: 'living_room', polygon: [[0, 0], [4, 0], [4, 3], [0, 3]] }],
    automation: {
      spaces: [{
        roomId: 'living',
        entities: [{
          deviceId: 'living-light',
          entityId: 'light.living',
          presetId: 'light',
          placement: { x: 1, y: 1, z: 2.4, rotationDeg: 0, scale: 1 },
        }, ...(includeFutureLight ? [{
          deviceId: 'living-wall-light',
          entityId: 'light.living_wall',
          presetId: 'light',
          placement: { x: 2, y: 1, z: 1.4, rotationDeg: 0, scale: 1 },
        }] : []), ...(includeSmartPlugLamp ? [{
          deviceId: 'living-plug-lamp',
          entityId: 'switch.living_lamp',
          presetId: 'plug',
          icon: 'lamp',
          placement: { x: 3, y: 1, z: 0.5, rotationDeg: 0, scale: 1 },
        }] : [])],
      }],
      adaptiveLighting: {
        enabled: true,
        pollSeconds: 30,
        manualOverrideMinutes: 120,
        transitionSeconds: 20,
        rooms: [{ ...room, deviceIds: includeSmartPlugLamp ? [...room.deviceIds, 'living-plug-lamp'] : room.deviceIds, dimmedOffDeviceIds }],
      },
    },
  }));
  return new HomeCatalog(root, 'home-test');
}

function lightState(state = 'on', brightness = 128, kelvin = 3_000) {
  return {
    entity_id: 'light.living',
    state,
    attributes: {
      brightness,
      color_temp_kelvin: kelvin,
      color_mode: 'color_temp',
      supported_color_modes: ['color_temp'],
      min_color_temp_kelvin: 2_000,
      max_color_temp_kelvin: 6_500,
    },
  };
}

describe('room lighting modes', () => {
  test('automatically includes a newly mapped light in the room group', () => {
    expect(fixture(true).getRoomLightDeviceIds('living')).toEqual(['living-light', 'living-wall-light']);
  });

  test('applies dimmed, maximum, on and off through the same room service', async () => {
    const states = [
      { entity_id: 'weather.home', state: 'cloudy', attributes: { cloud_coverage: 50 } },
      lightState(),
    ];
    const callService = jest.fn(async (_input: unknown) => ({ status: 200, data: [] }));
    const service = new HomeAdaptiveLightingService(
      fixture(),
      {
        getStates: jest.fn(async () => states),
        getState: jest.fn(async () => states[1]),
        callService,
      } as unknown as HomeAssistantClient,
      { info: jest.fn(), warn: jest.fn() }
    );
    const noon = new Date('2026-01-15T12:00:00.000Z');

    await service.setRoomMode('living', 'dimmed', noon);
    expect(callService).toHaveBeenLastCalledWith(expect.objectContaining({
      service: 'turn_on',
      serviceData: expect.objectContaining({ brightness_pct: 20, color_temp_kelvin: 2_800 }),
    }));
    await service.setRoomMode('living', 'on', noon);
    expect(callService).toHaveBeenLastCalledWith(expect.objectContaining({
      service: 'turn_on',
      serviceData: expect.objectContaining({ brightness_pct: 55, color_temp_kelvin: 3_900 }),
    }));
    await service.setRoomMode('living', 'maximum', noon);
    expect(callService).toHaveBeenLastCalledWith(expect.objectContaining({
      service: 'turn_on',
      serviceData: expect.objectContaining({ brightness_pct: 100, color_temp_kelvin: 3_900 }),
    }));
    await service.setRoomMode('living', 'off', noon);
    expect(callService).toHaveBeenLastCalledWith(expect.objectContaining({ service: 'turn_off' }));
  });

  test('includes a non-dimmable smart-plug lamp without sending unsupported colour data', async () => {
    const states = [
      { entity_id: 'weather.home', state: 'cloudy', attributes: { cloud_coverage: 50 } },
      lightState(),
      { entity_id: 'switch.living_lamp', state: 'off', attributes: {} },
    ];
    const callService = jest.fn(async (_input: unknown) => ({ status: 200, data: [] }));
    const service = new HomeAdaptiveLightingService(
      fixture(false, true),
      {
        getStates: jest.fn(async () => states),
        getState: jest.fn(async (entityId: string) => states.find((state) => state.entity_id === entityId)),
        callService,
      } as unknown as HomeAssistantClient,
      { info: jest.fn(), warn: jest.fn() }
    );

    await service.setRoomMode('living', 'dimmed', new Date('2026-01-15T12:00:00.000Z'));

    expect(callService).toHaveBeenCalledWith({
      domain: 'switch',
      service: 'turn_on',
      target: { entity_id: 'switch.living_lamp' },
      serviceData: undefined,
    });
  });

  test('keeps configured accent lamps off in dimmed mode and restores them in maximum mode', async () => {
    const states = [lightState(), { entity_id: 'switch.living_lamp', state: 'on', attributes: {} }];
    const callService = jest.fn(async (_input: unknown) => ({ status: 200, data: [] }));
    const service = new HomeAdaptiveLightingService(
      fixture(false, true, ['living-plug-lamp']),
      {
        getStates: jest.fn(async () => states),
        getState: jest.fn(async (entityId: string) => states.find((state) => state.entity_id === entityId)),
        callService,
      } as unknown as HomeAssistantClient,
      { info: jest.fn(), warn: jest.fn() }
    );

    await service.setRoomMode('living', 'dimmed', new Date('2026-01-15T12:00:00.000Z'));
    expect(callService).toHaveBeenCalledWith(expect.objectContaining({
      domain: 'switch', service: 'turn_off', target: { entity_id: 'switch.living_lamp' },
    }));
    callService.mockClear();
    await service.setRoomMode('living', 'maximum', new Date('2026-01-15T12:00:00.000Z'));
    expect(callService).toHaveBeenCalledWith(expect.objectContaining({
      domain: 'switch', service: 'turn_on', target: { entity_id: 'switch.living_lamp' },
    }));
  });

  test('does not change a selected mode merely because the clock crosses a phase boundary', async () => {
    const states = [
      { entity_id: 'weather.home', state: 'cloudy', attributes: { cloud_coverage: 50 } },
      lightState(),
    ];
    const callService = jest.fn(async (_input: unknown) => ({ status: 200, data: [] }));
    const service = new HomeAdaptiveLightingService(
      fixture(),
      {
        getStates: jest.fn(async () => states),
        getState: jest.fn(async () => states[1]),
        callService,
      } as unknown as HomeAssistantClient,
      { info: jest.fn(), warn: jest.fn() }
    );

    await service.setRoomMode('living', 'on', new Date('2026-01-15T17:30:00.000Z'));
    callService.mockClear();
    await service.tick(new Date('2026-01-15T22:30:00.000Z'));
    expect(callService).not.toHaveBeenCalled();
  });

  test('restores the selected room profile after a powered-off bulb reconnects', async () => {
    const states = [
      { entity_id: 'weather.home', state: 'cloudy', attributes: { cloud_coverage: 50 } },
      lightState(),
    ];
    const callService = jest.fn(async (_input: unknown) => ({ status: 200, data: [] }));
    const service = new HomeAdaptiveLightingService(
      fixture(),
      {
        getStates: jest.fn(async () => states),
        getState: jest.fn(async () => states[1]),
        callService,
      } as unknown as HomeAssistantClient,
      { info: jest.fn(), warn: jest.fn() }
    );
    const noon = new Date('2026-01-15T12:00:00.000Z');

    await service.setRoomMode('living', 'dimmed', noon);
    states[1] = lightState('unavailable', 0, 2_800);
    await service.tick(new Date(noon.getTime() + 60_000));
    states[1] = lightState('on', 255, 4_000);
    callService.mockClear();
    await service.tick(new Date(noon.getTime() + 120_000));
    expect(callService).toHaveBeenCalledWith(expect.objectContaining({
      service: 'turn_on',
      serviceData: expect.objectContaining({ brightness_pct: 20, color_temp_kelvin: 2_800 }),
    }));
  });

  test('leaves a per-light customization alone until a room mode is selected again', async () => {
    const states = [
      { entity_id: 'weather.home', state: 'cloudy', attributes: { cloud_coverage: 50 } },
      lightState(),
    ];
    const callService = jest.fn(async (_input: unknown) => ({ status: 200, data: [] }));
    const service = new HomeAdaptiveLightingService(
      fixture(),
      {
        getStates: jest.fn(async () => states),
        getState: jest.fn(async () => states[1]),
        callService,
      } as unknown as HomeAssistantClient,
      { info: jest.fn(), warn: jest.fn() }
    );
    const noon = new Date('2026-01-15T12:00:00.000Z');

    await service.setRoomMode('living', 'on', noon);
    await service.reconcileActions([{ deviceId: 'living-light', action: 'set_brightness' }]);
    states[1] = lightState('unavailable');
    await service.tick(new Date(noon.getTime() + 60_000));
    states[1] = lightState('on', 25, 2_200);
    callService.mockClear();
    await service.tick(new Date(noon.getTime() + 120_000));
    expect(callService).not.toHaveBeenCalled();
  });

  test('restores a persisted room intent only when a bulb reconnects after restart', async () => {
    const db = createConversationDb(':memory:');
    const stateRepository = new HomeRuntimeStateRepository(db);
    const states = [
      { entity_id: 'weather.home', state: 'cloudy', attributes: { cloud_coverage: 50 } },
      lightState(),
    ];
    const callService = jest.fn(async (_input: unknown) => ({ status: 200, data: [] }));
    const ha = {
      getStates: jest.fn(async () => states),
      getState: jest.fn(async () => states[1]),
      callService,
    } as unknown as HomeAssistantClient;
    const noon = new Date('2026-01-15T12:00:00.000Z');
    await new HomeAdaptiveLightingService(
      fixture(), ha, { info: jest.fn(), warn: jest.fn() }, stateRepository
    ).setRoomMode('living', 'dimmed', noon);

    const restarted = new HomeAdaptiveLightingService(
      fixture(), ha, { info: jest.fn(), warn: jest.fn() }, stateRepository
    );
    callService.mockClear();
    await restarted.tick(new Date(noon.getTime() + 1_000));
    expect(callService).not.toHaveBeenCalled();
    states[1] = lightState('unavailable');
    await restarted.tick(new Date(noon.getTime() + 31_000));
    states[1] = lightState('on', 255, 4_000);
    await restarted.tick(new Date(noon.getTime() + 62_000));

    expect(callService).toHaveBeenCalledWith(expect.objectContaining({
      service: 'turn_on',
      serviceData: expect.objectContaining({ brightness_pct: 20, color_temp_kelvin: 2_800 }),
    }));
    states[1] = lightState('on', 51, 2_800);
    await restarted.tick(new Date(noon.getTime() + 90_000));
    await restarted.tick(new Date(noon.getTime() + 130_000));
    expect(stateRepository.listLightingIntents()).toEqual([
      expect.objectContaining({ roomId: 'living', mode: 'dimmed' }),
    ]);
    db.close();
  });

  test('releases the persisted room intent after a manual Home Assistant change', async () => {
    const db = createConversationDb(':memory:');
    const stateRepository = new HomeRuntimeStateRepository(db);
    const states = [
      { entity_id: 'weather.home', state: 'cloudy', attributes: { cloud_coverage: 50 } },
      lightState(),
    ];
    const callService = jest.fn(async () => ({ status: 200, data: [] }));
    const service = new HomeAdaptiveLightingService(
      fixture(),
      {
        getStates: jest.fn(async () => states),
        getState: jest.fn(async () => states[1]),
        callService,
      } as unknown as HomeAssistantClient,
      { info: jest.fn(), warn: jest.fn() },
      stateRepository
    );
    const noon = new Date('2026-01-15T12:00:00.000Z');
    await service.setRoomMode('living', 'dimmed', noon);
    states[1] = lightState('on', 51, 2_800);
    await service.tick(new Date(noon.getTime() + 30_000));
    states[1] = lightState('on', 200, 4_000);
    callService.mockClear();
    await service.tick(new Date(noon.getTime() + 90_000));

    expect(callService).not.toHaveBeenCalled();
    expect(stateRepository.listLightingIntents()).toEqual([]);
    db.close();
  });
});
