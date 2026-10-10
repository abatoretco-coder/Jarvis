import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, jest, test } from '@jest/globals';
import Fastify from 'fastify';

import type { Env } from '../src/env';
import type { PermissionKey, RoleKey } from '../src/identity/IdentityRepository';
import { setRequestPrincipal } from '../src/identity/requestIdentity';
import { registerHomeRoutes } from '../src/routes/home';
import type { AppDeps } from '../src/server';

const roots: string[] = [];
afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

function setup(
  role: RoleKey = 'guest',
  permissions: PermissionKey[] = ['home'],
  writable = false,
  homeControlConfigured = true,
  clientId?: string
) {
  const root = mkdtempSync(join(tmpdir(), 'jarvis-home-'));
  roots.push(root);
  const folder = join(root, 'home-test');
  mkdirSync(folder);
  writeFileSync(
    join(folder, 'home.json'),
    JSON.stringify({
      homeId: 'home-test',
      displayName: 'Chez moi',
      geometry: { quality: 'approximate', units: 'm' },
      rooms: [
        {
          roomId: 'living',
          name: 'Salon',
          type: 'living_room',
          polygon: [
            [0, 0],
            [4, 0],
            [4, 3],
            [0, 3],
          ],
        },
      ],
      automation: {
        spaces: [
          {
            roomId: 'living',
            entities: [
              { deviceId: 'living-light', entityId: 'light.salon', name: 'Lampe principale' },
              {
                deviceId: 'living-vacuum',
                entityId: 'vacuum.robot',
                robot: {
                  batteryEntityId: 'sensor.robot_battery',
                  chargingStateEntityId: 'sensor.robot_charging',
                  locateEntityId: 'button.robot_locate',
                  suctionModeEntityId: 'select.robot_suction',
                  mopModeEntityId: 'select.robot_mop',
                  emptyDustBinEntityId: 'button.robot_empty',
                  washMopEntityId: 'button.robot_wash_mop',
                  startMopDryingEntityId: 'button.robot_dry_mop',
                  stopMopDryingEntityId: 'button.robot_stop_dry_mop',
                  cleaningTimeEntityId: 'sensor.robot_cleaning_time',
                  cleaningAreaEntityId: 'sensor.robot_cleaning_area',
                  totalCleaningCountEntityId: 'sensor.robot_cleaning_count',
                  mainBrushLifeEntityId: 'sensor.robot_main_brush_life',
                  filterLifeEntityId: 'sensor.robot_filter_life',
                },
              },
              { deviceId: 'living-camera', entityId: 'camera.salon' },
              {
                deviceId: 'living-sensor', entityId: 'sensor.living_temperature', name: 'Tapo T315', presetId: 'sensor',
                environment: { humidityEntityId: 'sensor.living_humidity', batteryEntityId: 'sensor.living_battery' },
              },
              {
                deviceId: 'living-water-heater', entityId: 'water_heater.velis', name: 'Velis Dry', presetId: 'water-heater',
                waterHeater: {
                  ecoEntityId: 'switch.velis_eco', boostEntityId: 'switch.velis_boost',
                  antiLegionellaEntityId: 'switch.velis_antilegionella', heatingEntityId: 'binary_sensor.velis_heating',
                  powerEntityId: 'sensor.velis_power', energyEntityId: 'sensor.velis_energy',
                  showersEntityId: 'sensor.velis_showers', heatingTimeEntityId: 'sensor.velis_heating_time',
                },
              },
              {
                deviceId: 'living-radiator', entityId: 'climate.radiator', name: 'Radiateur', presetId: 'heating',
                climate: {
                  offsetEntityId: 'number.radiator_offset', windowEntityId: 'binary_sensor.radiator_window',
                  childLockEntityId: 'switch.radiator_child_lock', powerEntityId: 'sensor.radiator_power',
                },
              },
              { deviceId: 'living-tv', entityId: 'media_player.lg_tv', name: 'TV du séjour', presetId: 'television' },
            ],
          },
        ],
      },
    })
  );
  const getStates = jest.fn<() => Promise<unknown[]>>(async () => [
    { entity_id: 'light.salon', state: 'on', attributes: { friendly_name: 'Salon' } },
    { entity_id: 'camera.salon', state: 'idle', attributes: { friendly_name: 'Caméra salon' } },
    { entity_id: 'sensor.living_temperature', state: '21.4', attributes: { friendly_name: 'Tapo température', device_class: 'temperature' } },
    { entity_id: 'sensor.living_humidity', state: '54', attributes: { device_class: 'humidity' } },
    { entity_id: 'sensor.living_battery', state: '87', attributes: { device_class: 'battery' } },
    { entity_id: 'water_heater.velis', state: 'on', attributes: { friendly_name: 'Velis Dry', temperature: 55, current_temperature: 49, min_temp: 40, max_temp: 80, target_temp_step: 1, current_operation: 'manual', operation_list: ['manual', 'program'], away_mode: false } },
    { entity_id: 'switch.velis_eco', state: 'on', attributes: {} },
    { entity_id: 'switch.velis_boost', state: 'off', attributes: {} },
    { entity_id: 'switch.velis_antilegionella', state: 'on', attributes: {} },
    { entity_id: 'binary_sensor.velis_heating', state: 'on', attributes: {} },
    { entity_id: 'sensor.velis_power', state: '1500', attributes: {} },
    { entity_id: 'sensor.velis_energy', state: '3.4', attributes: {} },
    { entity_id: 'sensor.velis_showers', state: '2', attributes: {} },
    { entity_id: 'sensor.velis_heating_time', state: '38', attributes: {} },
    { entity_id: 'climate.radiator', state: 'heat', attributes: { friendly_name: 'Radiateur', temperature: 20, current_temperature: 19.2, min_temp: 7, max_temp: 28, target_temp_step: 0.5, hvac_modes: ['off', 'heat'], hvac_action: 'heating', preset_mode: 'comfort', preset_modes: ['eco', 'comfort'] } },
    { entity_id: 'number.radiator_offset', state: '-0.4', attributes: { min: -3, max: 3, step: 0.1 } },
    { entity_id: 'binary_sensor.radiator_window', state: 'off', attributes: {} },
    { entity_id: 'switch.radiator_child_lock', state: 'on', attributes: {} },
    { entity_id: 'sensor.radiator_power', state: '850', attributes: {} },
    { entity_id: 'vacuum.robot', state: 'docked', attributes: { friendly_name: 'Nono' } },
    { entity_id: 'sensor.robot_battery', state: '42', attributes: {} },
    { entity_id: 'sensor.robot_charging', state: 'Charging', attributes: {} },
    { entity_id: 'button.robot_locate', state: 'unknown', attributes: {} },
    { entity_id: 'select.robot_suction', state: 'Strong', attributes: { options: ['Silent', 'Strong'] } },
    { entity_id: 'select.robot_mop', state: 'Medium', attributes: { options: ['Low', 'Medium', 'High'] } },
    { entity_id: 'button.robot_empty', state: 'unknown', attributes: {} },
    { entity_id: 'button.robot_wash_mop', state: 'unknown', attributes: {} },
    { entity_id: 'button.robot_dry_mop', state: 'unknown', attributes: {} },
    { entity_id: 'button.robot_stop_dry_mop', state: 'unknown', attributes: {} },
    { entity_id: 'sensor.robot_cleaning_time', state: '10', attributes: {} },
    { entity_id: 'sensor.robot_cleaning_area', state: '5', attributes: {} },
    { entity_id: 'sensor.robot_cleaning_count', state: '91', attributes: {} },
    { entity_id: 'sensor.robot_main_brush_life', state: '79', attributes: {} },
    { entity_id: 'sensor.robot_filter_life', state: '58', attributes: {} },
    {
      entity_id: 'media_player.lg_tv',
      state: 'playing',
      attributes: {
        friendly_name: 'LG TV',
        volume_level: 0.22,
        is_volume_muted: false,
        source: 'Netflix',
        source_list: ['Netflix', 'HDMI 1'],
        media_title: 'Film',
      },
    },
  ]);
  const savedAutomationIds = new Set<string>();
  const callService = jest.fn(async (input: unknown) => {
    const call = input as { domain?: string; service?: string };
    if (call.domain === 'xiaomi_vacuum_local' && call.service === 'get_rooms') {
      return {
        status: 200,
        data: { service_response: { devices: { robot: { rooms: [
          { segment_id: 2, name: 'Cuisine' },
          { segment_id: 5, name: 'Séjour' },
        ] } } } },
      };
    }
    return { status: 200, data: [] };
  });
  const getHistory = jest.fn(async () => [[
    { entity_id: 'vacuum.robot', state: 'docked', last_changed: '2026-10-08T08:00:00.000Z' },
    { entity_id: 'vacuum.robot', state: 'cleaning', last_changed: '2026-10-08T09:00:00.000Z' },
    { entity_id: 'vacuum.robot', state: 'docked', last_changed: '2026-10-08T09:42:00.000Z' },
  ]]);
  const getState = jest.fn(async (entityId: string) => {
    if (entityId === 'select.robot_suction') {
      return { entity_id: entityId, state: 'Strong', attributes: { options: ['Silent', 'Strong'] } };
    }
    if (entityId === 'select.robot_mop') {
      return { entity_id: entityId, state: 'Medium', attributes: { options: ['Low', 'Medium', 'High'] } };
    }
    if (entityId === 'climate.radiator') {
      return { entity_id: entityId, state: 'heat', attributes: { min_temp: 7, max_temp: 28, hvac_modes: ['off', 'heat'], preset_modes: ['eco', 'comfort'] } };
    }
    if (entityId === 'number.radiator_offset') {
      return { entity_id: entityId, state: '-0.4', attributes: { min: -3, max: 3, step: 0.1 } };
    }
    if (entityId === 'water_heater.velis') {
      return { entity_id: entityId, state: 'on', attributes: { min_temp: 40, max_temp: 80, operation_list: ['manual', 'program'], away_mode: false } };
    }
    throw new Error('not_found');
  });
  const getAutomationConfig = jest.fn(async (id: string) => ({
    alias: id,
    description: 'jarvis-managed:v1:scene=scene-evening',
    triggers: [{ trigger: 'time', at: '19:30:00' }],
    conditions: [{ condition: 'time', weekday: ['mon'] }],
  }));
  const saveAutomationConfig = jest.fn(async (id: string, _config: unknown) => {
    savedAutomationIds.add(id);
    getStates.mockImplementation(async () => [
      { entity_id: 'light.salon', state: 'on', attributes: { friendly_name: 'Salon' } },
      { entity_id: 'camera.salon', state: 'idle', attributes: { friendly_name: 'Caméra salon' } },
      ...[...savedAutomationIds].map((automationId) => ({
        entity_id: `automation.${automationId}`,
        state: 'on',
        attributes: { id: automationId, friendly_name: automationId },
      })),
    ]);
  });
  const deleteAutomationConfig = jest.fn(async () => undefined);
  const recordActorAudit = jest.fn();
  const app = Fastify();
  app.addHook('preHandler', (request, _reply, done) => {
    setRequestPrincipal(request, {
      kind: 'user',
      userId: 'guest-id',
      email: 'guest@example.test',
      displayName: 'Invité',
      status: 'active',
      roles: [role],
      permissions,
      sessionId: 'session',
      clientId,
    });
    done();
  });
  registerHomeRoutes(app, {
    env: {
      HOME_CONFIG_ROOT: root,
      HOME_DATA_ROOT: writable ? join(root, 'runtime-homes') : '',
      ACTIVE_HOME_ID: 'home-test',
    } as Env,
    ha: homeControlConfigured
      ? ({
          getStates,
          getState,
          getHistory,
          callService,
          getAutomationConfig,
          saveAutomationConfig,
          deleteAutomationConfig,
        } as unknown as AppDeps['ha'])
      : undefined,
    spotifyWebApi: {} as AppDeps['spotifyWebApi'],
    adminAudit: { recordActorAudit } as unknown as AppDeps['adminAudit'],
  });
  return {
    app,
    callService,
    getStates,
    getState,
    getHistory,
    getAutomationConfig,
    saveAutomationConfig,
    deleteAutomationConfig,
    recordActorAudit,
  };
}

describe('home routes', () => {
  test('returns deterministic robot rooms and cleaning history to household members', async () => {
    const resident = setup('resident', ['home']);
    const response = await resident.app.inject({
      method: 'GET',
      url: '/v1/home/devices/living-vacuum/robot?days=7',
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      roomCleaningAvailable: true,
      rooms: [{ segmentId: 2, name: 'Cuisine' }, { segmentId: 5, name: 'Séjour' }],
      history: [{ durationMinutes: 42, status: 'completed' }],
    });
    expect(resident.getHistory).toHaveBeenCalledTimes(1);
    await resident.app.close();
  });

  test('validates robot room ids before sending a targeted cleaning command', async () => {
    const resident = setup('resident', ['home']);
    const invalid = await resident.app.inject({
      method: 'POST',
      url: '/v1/home/devices/living-vacuum/robot/clean',
      payload: { rooms: [99], repeat: 1, suction: 2, water: 2 },
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json()).toEqual({ error: 'robot_room_unknown' });

    const valid = await resident.app.inject({
      method: 'POST',
      url: '/v1/home/devices/living-vacuum/robot/clean',
      payload: { rooms: [2], repeat: 2, suction: 3, water: 1 },
    });
    expect(valid.statusCode).toBe(200);
    expect(resident.callService).toHaveBeenCalledWith(expect.objectContaining({
      domain: 'xiaomi_vacuum_local',
      service: 'clean_rooms',
      serviceData: { rooms: [2], repeat: 2, suction: 3, water: 1 },
    }));
    await resident.app.close();
  });

  test('keeps robot history and room cleaning out of guest accounts', async () => {
    const guest = setup('guest', ['home']);
    const response = await guest.app.inject({
      method: 'GET', url: '/v1/home/devices/living-vacuum/robot',
    });
    expect(response.statusCode).toBe(403);
    expect(guest.getHistory).not.toHaveBeenCalled();
    await guest.app.close();
  });

  test('limits the Stream Deck client to light inventory and explicit light actions', async () => {
    const streamDeck = setup('owner', ['home'], false, true, 'jarvis-streamdeck');

    const inventory = await streamDeck.app.inject({ method: 'GET', url: '/v1/home/lights' });
    expect(inventory.statusCode).toBe(200);
    expect(inventory.json()).toMatchObject({
      devices: [expect.objectContaining({ deviceId: 'living-light', domain: 'light' })],
    });

    const light = await streamDeck.app.inject({
      method: 'POST',
      url: '/v1/home/actions',
      payload: { deviceId: 'living-light', action: 'turn_off' },
    });
    expect(light.statusCode).toBe(200);
    expect(streamDeck.callService).toHaveBeenCalledWith(expect.objectContaining({
      domain: 'light',
      service: 'turn_off',
    }));

    const vacuum = await streamDeck.app.inject({
      method: 'POST',
      url: '/v1/home/actions',
      payload: { deviceId: 'living-vacuum', action: 'start' },
    });
    expect(vacuum.statusCode).toBe(403);
    expect(vacuum.json()).toEqual({ error: 'client_scope_forbidden' });
    expect(streamDeck.callService).not.toHaveBeenCalledWith(expect.objectContaining({
      domain: 'vacuum',
      service: 'start',
    }));
    await streamDeck.app.close();
  });

  test('keeps automation inventory out of guest accounts', async () => {
    const guest = setup('guest', ['home']);
    const response = await guest.app.inject({ method: 'GET', url: '/v1/home/automations' });
    expect(response.statusCode).toBe(403);
    expect(guest.getStates).not.toHaveBeenCalled();
    await guest.app.close();
  });

  test('lists Home Assistant automations for residents but keeps mutations owner-only', async () => {
    const resident = setup('resident', ['home']);
    resident.getStates.mockResolvedValueOnce([
      {
        entity_id: 'automation.soiree',
        state: 'on',
        attributes: { id: 'jarvis_schedule', friendly_name: 'Soirée' },
      },
    ]);
    const listed = await resident.app.inject({ method: 'GET', url: '/v1/home/automations' });
    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toMatchObject({
      canManage: false,
      items: [expect.objectContaining({ automationId: 'jarvis_schedule', enabled: true })],
    });
    const denied = await resident.app.inject({
      method: 'PATCH',
      url: '/v1/home/automations/jarvis_schedule/state',
      payload: { enabled: false },
    });
    expect(denied.statusCode).toBe(403);
    expect(resident.callService).not.toHaveBeenCalled();
    await resident.app.close();
  });

  test('lets an owner manage Home Assistant automation state without accepting entity ids', async () => {
    const owner = setup('owner', ['home', 'admin']);
    owner.getStates.mockResolvedValue([
      {
        entity_id: 'automation.soiree',
        state: 'on',
        attributes: { id: 'jarvis_schedule', friendly_name: 'Soirée' },
      },
    ]);
    const toggled = await owner.app.inject({
      method: 'PATCH',
      url: '/v1/home/automations/jarvis_schedule/state',
      payload: { enabled: false },
    });
    expect(toggled.statusCode).toBe(200);
    expect(owner.callService).toHaveBeenCalledWith({
      domain: 'automation',
      service: 'turn_off',
      target: { entity_id: 'automation.soiree' },
    });
    const injected = await owner.app.inject({
      method: 'PATCH',
      url: '/v1/home/automations/automation.soiree/state',
      payload: { enabled: false },
    });
    expect(injected.statusCode).toBe(400);
    await owner.app.close();
  });
  test('returns the versioned plan with reconciled Home Assistant state', async () => {
    const { app } = setup();
    const response = await app.inject({ method: 'GET', url: '/v1/home' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ homeId: 'home-test', rooms: [{ roomId: 'living' }] });
    expect(response.json().devices).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          deviceId: 'living-light',
          name: 'Lampe principale',
          state: 'on',
          available: true,
          capabilities: ['turn_on', 'turn_off', 'toggle', 'set_brightness'],
          riskLevel: 'low',
        }),
      ])
    );
    expect(response.json().devices).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ deviceId: 'living-vacuum' })])
    );
    expect(response.json().devices).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ deviceId: 'living-camera' })])
    );
    await app.close();
  });

  test('allows simple guest controls and denies broader domestic actions', async () => {
    const { app, callService, recordActorAudit } = setup();
    const light = await app.inject({
      method: 'POST',
      url: '/v1/home/actions',
      payload: { deviceId: 'living-light', action: 'toggle' },
    });
    expect(light.statusCode).toBe(200);
    expect(callService).toHaveBeenCalledWith(
      expect.objectContaining({
        domain: 'light',
        service: 'toggle',
        target: { entity_id: 'light.salon' },
      })
    );
    expect(light.json()).toEqual({ status: 'ok', deviceId: 'living-light' });
    expect(recordActorAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        actorKind: 'user',
        actorId: 'guest-id',
        action: 'home.action.toggle',
        targetId: 'living-light',
        outcome: 'success',
        metadata: { domain: 'light' },
      })
    );
    expect(JSON.stringify(recordActorAudit.mock.calls)).not.toContain('light.salon');
    const vacuum = await app.inject({
      method: 'POST',
      url: '/v1/home/actions',
      payload: { deviceId: 'living-vacuum', action: 'start' },
    });
    expect(vacuum.statusCode).toBe(403);
    expect(vacuum.json()).toEqual({ error: 'guest_action_forbidden' });
    expect(recordActorAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'home.action.start',
        targetId: 'living-vacuum',
        outcome: 'denied',
      })
    );
    await app.close();
  });

  test('denies and audits a valid command when the account lacks home access', async () => {
    const { app, callService, recordActorAudit } = setup('resident', []);
    const response = await app.inject({
      method: 'POST',
      url: '/v1/home/actions',
      payload: { deviceId: 'living-light', action: 'toggle' },
    });
    expect(response.statusCode).toBe(403);
    expect(callService).not.toHaveBeenCalled();
    expect(recordActorAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        actorKind: 'user',
        actorId: 'guest-id',
        action: 'home.action.toggle',
        targetId: 'living-light',
        outcome: 'denied',
        metadata: { errorCode: 'forbidden' },
      })
    );
    await app.close();
  });

  test('requires the camera permission for camera reads', async () => {
    const withoutCamera = setup('resident');
    const denied = await withoutCamera.app.inject({ method: 'GET', url: '/v1/home' });
    expect(denied.json().devices).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ deviceId: 'living-camera' })])
    );
    await withoutCamera.app.close();

    const withCamera = setup('resident', ['home', 'cameras']);
    const allowed = await withCamera.app.inject({ method: 'GET', url: '/v1/home' });
    expect(allowed.json().devices).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          deviceId: 'living-camera',
          capabilities: ['view'],
          riskLevel: 'high',
        }),
      ])
    );
    await withCamera.app.close();
  });

  test('never accepts a raw Home Assistant entity or an incomplete temperature command', async () => {
    const { app, callService } = setup();
    const rawEntity = await app.inject({
      method: 'POST',
      url: '/v1/home/actions',
      payload: { deviceId: 'light.salon', action: 'toggle' },
    });
    expect(rawEntity.statusCode).toBe(400);
    const missingTemperature = await app.inject({
      method: 'POST',
      url: '/v1/home/actions',
      payload: { deviceId: 'living-light', action: 'set_temperature' },
    });
    expect(missingTemperature.statusCode).toBe(400);
    expect(callService).toHaveBeenCalledTimes(0);
    await app.close();
  });

  test('maps rich light controls to deterministic Home Assistant service data', async () => {
    const { app, callService } = setup('resident', ['home']);
    const response = await app.inject({
      method: 'POST',
      url: '/v1/home/actions',
      payload: { deviceId: 'living-light', action: 'set_brightness', value: 35 },
    });
    expect(response.statusCode).toBe(200);
    expect(callService).toHaveBeenCalledWith({
      domain: 'light',
      service: 'turn_on',
      target: { entity_id: 'light.salon' },
      serviceData: { brightness_pct: 35 },
    });
    await app.close();
  });

  test('exposes rich TV state and maps allowlisted remote controls without accepting raw services', async () => {
    const { app, callService } = setup('resident', ['home']);
    const snapshot = await app.inject({ method: 'GET', url: '/v1/home' });
    expect(snapshot.json().devices).toEqual(expect.arrayContaining([
      expect.objectContaining({
        deviceId: 'living-tv',
        volumeLevel: 22,
        muted: false,
        source: 'Netflix',
        sourceList: ['Netflix', 'HDMI 1'],
        mediaTitle: 'Film',
      }),
    ]));

    const source = await app.inject({
      method: 'POST',
      url: '/v1/home/actions',
      payload: { deviceId: 'living-tv', action: 'select_source', option: 'HDMI 1' },
    });
    expect(source.statusCode).toBe(200);
    expect(callService).toHaveBeenLastCalledWith({
      domain: 'media_player',
      service: 'select_source',
      target: { entity_id: 'media_player.lg_tv' },
      serviceData: { source: 'HDMI 1' },
    });

    const remote = await app.inject({
      method: 'POST',
      url: '/v1/home/actions',
      payload: { deviceId: 'living-tv', action: 'remote_key', option: 'HOME' },
    });
    expect(remote.statusCode).toBe(200);
    expect(callService).toHaveBeenLastCalledWith({
      domain: 'webostv',
      service: 'button',
      target: { entity_id: 'media_player.lg_tv' },
      serviceData: { button: 'HOME' },
    });

    const channel = await app.inject({
      method: 'POST',
      url: '/v1/home/actions',
      payload: { deviceId: 'living-tv', action: 'play_channel', option: 'France 2' },
    });
    expect(channel.statusCode).toBe(200);
    expect(callService).toHaveBeenLastCalledWith({
      domain: 'media_player',
      service: 'play_media',
      target: { entity_id: 'media_player.lg_tv' },
      serviceData: { media_content_id: 'France 2', media_content_type: 'channel' },
    });

    const injected = await app.inject({
      method: 'POST',
      url: '/v1/home/actions',
      payload: { deviceId: 'living-tv', action: 'remote_key', option: 'SYSTEM/LAUNCHER/OPEN' },
    });
    expect(injected.statusCode).toBe(400);
    await app.close();
  });

  test('exposes robot telemetry and maps only validated robot controls', async () => {
    const { app, callService, getState } = setup('resident', ['home']);
    const snapshot = await app.inject({ method: 'GET', url: '/v1/home' });
    expect(snapshot.statusCode).toBe(200);
    expect(snapshot.json().devices).toEqual(expect.arrayContaining([
      expect.objectContaining({
        deviceId: 'living-vacuum',
        state: 'docked',
        batteryLevel: 42,
        chargingState: 'Charging',
        suctionMode: 'Strong',
        suctionModeOptions: ['Silent', 'Strong'],
        mopMode: 'Medium',
        mopModeOptions: ['Low', 'Medium', 'High'],
        cleaningTimeMinutes: 10,
        cleaningAreaM2: 5,
        totalCleaningCount: 91,
        mainBrushLifePercent: 79,
        filterLifePercent: 58,
        capabilities: ['start', 'stop', 'return_to_base', 'locate', 'set_suction_mode', 'set_mop_mode', 'empty_dust_bin', 'wash_mop', 'start_mop_drying', 'stop_mop_drying'],
      }),
    ]));

    const locate = await app.inject({
      method: 'POST',
      url: '/v1/home/actions',
      payload: { deviceId: 'living-vacuum', action: 'locate' },
    });
    expect(locate.statusCode).toBe(200);
    expect(callService).toHaveBeenLastCalledWith({
      domain: 'button',
      service: 'press',
      target: { entity_id: 'button.robot_locate' },
    });

    const empty = await app.inject({
      method: 'POST',
      url: '/v1/home/actions',
      payload: { deviceId: 'living-vacuum', action: 'empty_dust_bin' },
    });
    expect(empty.statusCode).toBe(200);
    expect(callService).toHaveBeenLastCalledWith({
      domain: 'button',
      service: 'press',
      target: { entity_id: 'button.robot_empty' },
    });

    const suction = await app.inject({
      method: 'POST',
      url: '/v1/home/actions',
      payload: { deviceId: 'living-vacuum', action: 'set_suction_mode', option: 'Silent' },
    });
    expect(suction.statusCode).toBe(200);
    expect(getState).toHaveBeenLastCalledWith('select.robot_suction');
    expect(callService).toHaveBeenLastCalledWith({
      domain: 'select',
      service: 'select_option',
      target: { entity_id: 'select.robot_suction' },
      serviceData: { option: 'Silent' },
    });

    const callsBeforeInvalidOption = callService.mock.calls.length;
    const invalid = await app.inject({
      method: 'POST',
      url: '/v1/home/actions',
      payload: { deviceId: 'living-vacuum', action: 'set_mop_mode', option: 'Turbo' },
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json()).toEqual({ error: 'home_action_option_invalid' });
    expect(callService).toHaveBeenCalledTimes(callsBeforeInvalidOption);
    await app.close();
  });

  test('exposes only real heating capabilities and validates modes and ranges server-side', async () => {
    const { app, callService } = setup('resident', ['home']);
    const snapshot = await app.inject({ method: 'GET', url: '/v1/home' });
    expect(snapshot.json().devices).toEqual(expect.arrayContaining([expect.objectContaining({
      deviceId: 'living-radiator', currentTemperature: 19.2, targetTemperature: 20,
      minTemperature: 7, maxTemperature: 28, hvacMode: 'heat', hvacModes: ['off', 'heat'],
      hvacAction: 'heating', presetMode: 'comfort', temperatureOffset: -0.4,
      windowOpen: false, childLock: true, activePowerWatts: 850,
      capabilities: ['turn_on', 'turn_off', 'set_temperature', 'set_hvac_mode', 'set_preset_mode', 'set_temperature_offset', 'set_child_lock'],
    })]));

    const validMode = await app.inject({ method: 'POST', url: '/v1/home/actions', payload: { deviceId: 'living-radiator', action: 'set_hvac_mode', option: 'heat' } });
    expect(validMode.statusCode).toBe(200);
    expect(callService).toHaveBeenLastCalledWith({ domain: 'climate', service: 'set_hvac_mode', target: { entity_id: 'climate.radiator' }, serviceData: { hvac_mode: 'heat' } });

    const invalidMode = await app.inject({ method: 'POST', url: '/v1/home/actions', payload: { deviceId: 'living-radiator', action: 'set_hvac_mode', option: 'boost' } });
    expect(invalidMode.statusCode).toBe(400);
    expect(invalidMode.json()).toEqual({ error: 'home_action_option_invalid' });

    const invalidTemperature = await app.inject({ method: 'POST', url: '/v1/home/actions', payload: { deviceId: 'living-radiator', action: 'set_temperature', value: 30 } });
    expect(invalidTemperature.statusCode).toBe(400);
    expect(invalidTemperature.json()).toEqual({ error: 'home_action_option_invalid' });

    const offset = await app.inject({ method: 'POST', url: '/v1/home/actions', payload: { deviceId: 'living-radiator', action: 'set_temperature_offset', value: 0.5 } });
    expect(offset.statusCode).toBe(200);
    expect(callService).toHaveBeenLastCalledWith({ domain: 'number', service: 'set_value', target: { entity_id: 'number.radiator_offset' }, serviceData: { value: 0.5 } });
    await app.close();
  });

  test('normalizes Tapo environment readings and Velis controls without raw entity access', async () => {
    const { app, callService } = setup('resident', ['home']);
    const snapshot = await app.inject({ method: 'GET', url: '/v1/home' });
    expect(snapshot.json().devices).toEqual(expect.arrayContaining([
      expect.objectContaining({ deviceId: 'living-sensor', currentTemperature: 21.4, humidityPercent: 54, batteryLevel: 87, capabilities: [] }),
      expect.objectContaining({
        deviceId: 'living-water-heater', currentTemperature: 49, targetTemperature: 55,
        operationMode: 'manual', operationModes: ['manual', 'program'], awayMode: false,
        ecoMode: true, boostMode: false, antiLegionella: true, heatingActive: true,
        activePowerWatts: 1500, energyKwh: 3.4, showersAvailable: 2, heatingTimeMinutes: 38,
      }),
    ]));

    const mode = await app.inject({ method: 'POST', url: '/v1/home/actions', payload: { deviceId: 'living-water-heater', action: 'set_operation_mode', option: 'program' } });
    expect(mode.statusCode).toBe(200);
    expect(callService).toHaveBeenLastCalledWith({ domain: 'water_heater', service: 'set_operation_mode', target: { entity_id: 'water_heater.velis' }, serviceData: { operation_mode: 'program' } });

    const invalidMode = await app.inject({ method: 'POST', url: '/v1/home/actions', payload: { deviceId: 'living-water-heater', action: 'set_operation_mode', option: 'admin' } });
    expect(invalidMode.statusCode).toBe(400);

    const boost = await app.inject({ method: 'POST', url: '/v1/home/actions', payload: { deviceId: 'living-water-heater', action: 'set_boost_mode', option: 'on' } });
    expect(boost.statusCode).toBe(200);
    expect(callService).toHaveBeenLastCalledWith({ domain: 'switch', service: 'turn_on', target: { entity_id: 'switch.velis_boost' } });

    const injected = await app.inject({ method: 'POST', url: '/v1/home/actions', payload: { deviceId: 'living-water-heater', action: 'set_boost_mode', option: 'toggle_everything' } });
    expect(injected.statusCode).toBe(400);
    await app.close();
  });

  test('keeps water-heater controls unavailable to guests', async () => {
    const { app, callService } = setup('guest', ['home']);
    const response = await app.inject({
      method: 'POST',
      url: '/v1/home/actions',
      payload: { deviceId: 'living-water-heater', action: 'set_boost_mode', option: 'on' },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ error: 'guest_action_forbidden' });
    expect(callService).not.toHaveBeenCalled();
    await app.close();
  });

  test('rejects an unavailable water-heater away mode even when a client crafts the action', async () => {
    const { app, callService, getState } = setup('resident', ['home']);
    getState.mockResolvedValueOnce({
      entity_id: 'water_heater.velis',
      state: 'on',
      attributes: { min_temp: 40, max_temp: 80, operation_list: ['manual', 'program'] },
    });
    const response = await app.inject({
      method: 'POST',
      url: '/v1/home/actions',
      payload: { deviceId: 'living-water-heater', action: 'set_away_mode', option: 'on' },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: 'home_action_unsupported' });
    expect(callService).not.toHaveBeenCalled();
    await app.close();
  });

  test('drops stale robot companions after remapping and preflights scene targets', async () => {
    const { app, callService } = setup('owner', ['home', 'admin'], true);
    const initial = await app.inject({ method: 'GET', url: '/v1/home' });
    const remapped = await app.inject({
      method: 'PUT',
      url: '/v1/home/devices/living-vacuum',
      payload: {
        expectedRevision: initial.json().revision,
        roomId: 'living',
        entityId: 'vacuum.replacement',
        name: 'Nouveau robot',
        presetId: 'vacuum',
        placement: { x: 2, y: 1.5, z: 0, rotationDeg: 0, scale: 1 },
      },
    });
    expect(remapped.statusCode).toBe(200);
    const snapshot = await app.inject({ method: 'GET', url: '/v1/home' });
    expect(snapshot.json().devices).toEqual(expect.arrayContaining([
      expect.objectContaining({
        deviceId: 'living-vacuum',
        capabilities: ['start', 'stop', 'return_to_base'],
      }),
    ]));

    const lightAction = await app.inject({
      method: 'POST',
      url: '/v1/home/quick-actions',
      payload: {
        expectedRevision: snapshot.json().revision,
        name: 'Allumer le salon',
        icon: 'light',
        deviceId: 'living-light',
        action: 'turn_on',
        voicePhrases: [],
      },
    });
    const locateAction = await app.inject({
      method: 'POST',
      url: '/v1/home/quick-actions',
      payload: {
        expectedRevision: lightAction.json().revision,
        name: 'Localiser le robot',
        icon: 'vacuum',
        deviceId: 'living-vacuum',
        action: 'locate',
        voicePhrases: [],
      },
    });
    const scene = await app.inject({
      method: 'POST',
      url: '/v1/home/scenes',
      payload: {
        expectedRevision: locateAction.json().revision,
        name: 'Scène invalide',
        icon: 'home',
        quickActionIds: [
          lightAction.json().quickAction.quickActionId,
          locateAction.json().quickAction.quickActionId,
        ],
        voicePhrases: [],
      },
    });
    expect(scene.statusCode).toBe(201);
    const run = await app.inject({
      method: 'POST',
      url: `/v1/home/scenes/${scene.json().scene.sceneId}/run`,
    });
    expect(run.statusCode).toBe(400);
    expect(run.json()).toMatchObject({ status: 'failed', errorCode: 'home_action_unsupported' });
    expect(callService).not.toHaveBeenCalled();
    await app.close();
  });

  test('returns the configured home with explicit offline states when control is unreachable', async () => {
    const { app, callService, getStates, recordActorAudit } = setup();
    getStates.mockRejectedValueOnce(new Error('offline'));
    const snapshot = await app.inject({ method: 'GET', url: '/v1/home' });
    expect(snapshot.statusCode).toBe(200);
    expect(snapshot.headers['cache-control']).toBe('no-store');
    expect(snapshot.json()).toMatchObject({
      controlStatus: 'offline',
      devices: expect.arrayContaining([
        expect.objectContaining({
          deviceId: 'living-light',
          state: 'unavailable',
          available: false,
        }),
      ]),
    });
    callService.mockRejectedValueOnce(new Error('offline'));
    const command = await app.inject({
      method: 'POST',
      url: '/v1/home/actions',
      payload: { deviceId: 'living-light', action: 'toggle' },
    });
    expect(command.statusCode).toBe(502);
    expect(command.json()).toEqual({ error: 'home_control_unavailable' });
    expect(recordActorAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'home.action.toggle',
        outcome: 'failed',
        metadata: { domain: 'light', errorCode: 'home_control_unavailable' },
      })
    );
    await app.close();
  });

  test('returns the plan when home control is not configured', async () => {
    const { app, recordActorAudit } = setup('owner', ['home', 'admin'], false, false);
    const snapshot = await app.inject({ method: 'GET', url: '/v1/home' });

    expect(snapshot.statusCode).toBe(200);
    expect(snapshot.json()).toMatchObject({
      homeId: 'home-test',
      controlStatus: 'not_configured',
      rooms: [{ roomId: 'living' }],
    });
    expect(snapshot.json().devices).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ deviceId: 'living-light', available: false }),
      ])
    );

    const command = await app.inject({
      method: 'POST',
      url: '/v1/home/actions',
      payload: { deviceId: 'living-light', action: 'toggle' },
    });
    expect(command.statusCode).toBe(503);
    expect(command.json()).toEqual({ error: 'home_control_unavailable' });
    expect(recordActorAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'home.action.toggle',
        outcome: 'failed',
        metadata: { domain: 'light', errorCode: 'home_control_unavailable' },
      })
    );
    await app.close();
  });

  test('lets an owner place an unmapped preset and rejects stale revisions', async () => {
    const { app, recordActorAudit } = setup('owner', ['home', 'admin'], true);
    const initial = await app.inject({ method: 'GET', url: '/v1/home' });
    expect(initial.json()).toMatchObject({ canEdit: true, revision: expect.any(String) });
    const revision = initial.json().revision as string;
    const created = await app.inject({
      method: 'PUT',
      url: '/v1/home/devices/living-draft-robot',
      payload: {
        expectedRevision: revision,
        roomId: 'living',
        name: 'Robot du salon',
        presetId: 'vacuum',
        placement: { x: 2, y: 1.5, z: 0, rotationDeg: 0, scale: 1 },
      },
    });
    expect(created.statusCode).toBe(200);
    expect(recordActorAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'home.device.upsert',
        targetId: 'living-draft-robot',
        outcome: 'success',
        metadata: { roomId: 'living', presetId: 'vacuum' },
      })
    );
    const snapshot = await app.inject({ method: 'GET', url: '/v1/home' });
    expect(snapshot.json().devices).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          deviceId: 'living-draft-robot',
          mapped: false,
          state: 'not_configured',
          presetId: 'vacuum',
        }),
      ])
    );
    const stale = await app.inject({
      method: 'PUT',
      url: '/v1/home/devices/another-light',
      payload: {
        expectedRevision: revision,
        roomId: 'living',
        name: 'Autre lumière',
        presetId: 'light',
        placement: { x: 1, y: 1, z: 0, rotationDeg: 0, scale: 1 },
      },
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toEqual({ error: 'home_config_conflict' });
    expect(recordActorAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'home.device.upsert',
        targetId: 'another-light',
        outcome: 'failed',
        metadata: { errorCode: 'home_config_conflict' },
      })
    );
    await app.close();
  });

  test('returns existing mappings only to an owner with home access', async () => {
    const owner = setup('owner', ['home', 'admin'], true);
    const configuration = await owner.app.inject({
      method: 'GET',
      url: '/v1/home/configuration',
    });
    expect(configuration.statusCode).toBe(200);
    expect(configuration.json().mappedEntities).toEqual(
      expect.arrayContaining([
        { deviceId: 'living-light', entityId: 'light.salon' },
        { deviceId: 'living-vacuum', entityId: 'vacuum.robot' },
      ])
    );
    await owner.app.close();

    const ownerWithoutHome = setup('owner', ['admin'], true);
    const denied = await ownerWithoutHome.app.inject({
      method: 'GET',
      url: '/v1/home/configuration',
    });
    expect(denied.statusCode).toBe(403);
    await ownerWithoutHome.app.close();
  });

  test('keeps home editing owner-only and validates placement server-side', async () => {
    const resident = setup('resident', ['home'], true);
    const denied = await resident.app.inject({ method: 'GET', url: '/v1/home/configuration' });
    expect(denied.statusCode).toBe(403);
    await resident.app.close();

    const owner = setup('owner', ['home', 'admin'], true);
    const snapshot = await owner.app.inject({ method: 'GET', url: '/v1/home' });
    const invalid = await owner.app.inject({
      method: 'PUT',
      url: '/v1/home/devices/outside-device',
      payload: {
        expectedRevision: snapshot.json().revision,
        roomId: 'living',
        name: 'Hors plan',
        presetId: 'light',
        placement: { x: 99, y: 99, z: 0, rotationDeg: 0, scale: 1 },
      },
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json()).toEqual({ error: 'home_device_invalid' });
    await owner.app.close();
  });

  test('creates, exposes, runs and deletes a quick action through the shared home command path', async () => {
    const { app, callService, recordActorAudit } = setup('owner', ['home', 'admin'], true);
    const initial = await app.inject({ method: 'GET', url: '/v1/home' });
    const created = await app.inject({
      method: 'POST',
      url: '/v1/home/quick-actions',
      payload: {
        expectedRevision: initial.json().revision,
        name: 'Lumière salon',
        icon: 'light',
        deviceId: 'living-light',
        action: 'toggle',
        voicePhrases: ['  Lumière Salon  '],
      },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().quickAction).toMatchObject({
      name: 'Lumière salon',
      voicePhrases: ['lumiere salon'],
    });
    const quickActionId = created.json().quickAction.quickActionId as string;
    const snapshot = await app.inject({ method: 'GET', url: '/v1/home' });
    expect(snapshot.json().quickActions).toEqual([
      expect.objectContaining({ quickActionId, deviceId: 'living-light', action: 'toggle' }),
    ]);

    const run = await app.inject({
      method: 'POST',
      url: `/v1/home/quick-actions/${quickActionId}/run`,
    });
    expect(run.statusCode).toBe(200);
    expect(callService).toHaveBeenCalledWith(
      expect.objectContaining({ domain: 'light', service: 'toggle' })
    );
    expect(recordActorAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        targetType: 'home.quick_action',
        targetId: quickActionId,
        outcome: 'success',
      })
    );

    const deleted = await app.inject({
      method: 'DELETE',
      url: `/v1/home/quick-actions/${quickActionId}`,
      payload: { expectedRevision: snapshot.json().revision },
    });
    expect(deleted.statusCode).toBe(204);
    const afterDelete = await app.inject({ method: 'GET', url: '/v1/home' });
    expect(afterDelete.json().quickActions).toEqual([]);
    await app.close();
  });

  test('keeps quick-action editing owner-only and rejects ambiguous voice phrases', async () => {
    const resident = setup('resident', ['home'], true);
    const residentSnapshot = await resident.app.inject({ method: 'GET', url: '/v1/home' });
    const denied = await resident.app.inject({
      method: 'POST',
      url: '/v1/home/quick-actions',
      payload: {
        expectedRevision: residentSnapshot.json().revision,
        name: 'Salon',
        icon: 'light',
        deviceId: 'living-light',
        action: 'toggle',
        voicePhrases: ['salon'],
      },
    });
    expect(denied.statusCode).toBe(403);
    await resident.app.close();

    const owner = setup('owner', ['home', 'admin'], true);
    const initial = await owner.app.inject({ method: 'GET', url: '/v1/home' });
    const incompatible = await owner.app.inject({
      method: 'POST',
      url: '/v1/home/quick-actions',
      payload: {
        expectedRevision: initial.json().revision,
        name: 'Robot invalide',
        icon: 'vacuum',
        deviceId: 'living-vacuum',
        action: 'toggle',
        voicePhrases: [],
      },
    });
    expect(incompatible.statusCode).toBe(400);
    expect(incompatible.json()).toEqual({ error: 'home_quick_action_invalid' });
    const first = await owner.app.inject({
      method: 'POST',
      url: '/v1/home/quick-actions',
      payload: {
        expectedRevision: initial.json().revision,
        name: 'Salon',
        icon: 'light',
        deviceId: 'living-light',
        action: 'toggle',
        voicePhrases: ['Éclaire le salon'],
      },
    });
    const conflict = await owner.app.inject({
      method: 'POST',
      url: '/v1/home/quick-actions',
      payload: {
        expectedRevision: first.json().revision,
        name: 'Salon bis',
        icon: 'light',
        deviceId: 'living-light',
        action: 'turn_on',
        voicePhrases: ['eclaire le salon'],
      },
    });
    expect(conflict.statusCode).toBe(400);
    expect(conflict.json()).toEqual({ error: 'home_voice_phrase_conflict' });
    await owner.app.close();
  });

  test('creates and runs a multi-device scene then schedules it in Home Assistant', async () => {
    const { app, callService, saveAutomationConfig, recordActorAudit } = setup('owner', ['home', 'admin'], true);
    const initial = await app.inject({ method: 'GET', url: '/v1/home' });
    const light = await app.inject({
      method: 'POST',
      url: '/v1/home/quick-actions',
      payload: {
        expectedRevision: initial.json().revision,
        name: 'Salon allumé',
        icon: 'light',
        deviceId: 'living-light',
        action: 'turn_on',
        voicePhrases: [],
      },
    });
    const vacuum = await app.inject({
      method: 'POST',
      url: '/v1/home/quick-actions',
      payload: {
        expectedRevision: light.json().revision,
        name: 'Robot salon',
        icon: 'vacuum',
        deviceId: 'living-vacuum',
        action: 'start',
        voicePhrases: [],
      },
    });
    const scene = await app.inject({
      method: 'POST',
      url: '/v1/home/scenes',
      payload: {
        expectedRevision: vacuum.json().revision,
        name: 'Départ',
        icon: 'home',
        quickActionIds: [
          light.json().quickAction.quickActionId,
          vacuum.json().quickAction.quickActionId,
        ],
        voicePhrases: ['mode départ'],
      },
    });
    expect(scene.statusCode).toBe(201);
    expect(scene.json().scene.steps).toHaveLength(2);
    const run = await app.inject({
      method: 'POST',
      url: `/v1/home/scenes/${scene.json().scene.sceneId}/run`,
    });
    expect(run.statusCode).toBe(200);
    expect(run.json()).toMatchObject({ status: 'success' });
    expect(callService).toHaveBeenCalledTimes(2);

    const automation = await app.inject({
      method: 'POST',
      url: '/v1/home/automations',
      payload: {
        name: 'Départ semaine',
        enabled: true,
        sceneId: scene.json().scene.sceneId,
        at: '08:30',
        weekdays: [1, 2, 3, 4, 5],
      },
    });
    expect(automation.statusCode).toBe(201);
    expect(saveAutomationConfig).toHaveBeenCalledWith(
      expect.stringMatching(/^jarvis_[a-f0-9]{32}$/u),
      expect.objectContaining({
        alias: 'Départ semaine',
        actions: expect.arrayContaining([
          expect.objectContaining({ action: 'light.turn_on' }),
          expect.objectContaining({ action: 'vacuum.start' }),
        ]),
      })
    );
    expect(recordActorAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'home.scene.create',
        targetType: 'home.scene',
        targetId: scene.json().scene.sceneId,
      })
    );
    expect(recordActorAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'home.automation.create',
        targetType: 'home.automation',
        targetId: automation.json().automationId,
      })
    );
    const snapshot = await app.inject({ method: 'GET', url: '/v1/home' });
    expect(snapshot.json()).toMatchObject({
      scenes: [expect.objectContaining({ name: 'Départ' })],
      routines: [],
    });
    const deleted = await app.inject({
      method: 'DELETE',
      url: `/v1/home/scenes/${scene.json().scene.sceneId}`,
      payload: { expectedRevision: snapshot.json().revision },
    });
    expect(deleted.statusCode).toBe(204);
    expect(recordActorAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'home.scene.delete',
        targetType: 'home.scene',
        targetId: scene.json().scene.sceneId,
      })
    );
    const afterDelete = await app.inject({ method: 'GET', url: '/v1/home' });
    expect(afterDelete.json().scenes).toEqual([]);
    expect(afterDelete.json().routines).toEqual([]);
    await app.close();
  });
});
