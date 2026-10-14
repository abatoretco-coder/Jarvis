import Database from 'better-sqlite3';

import { createConversationDb } from '../src/conversation/repositories/SqliteRepositories';
import type { HomeAssistantClient } from '../src/haClient';
import { HomeCatalog } from '../src/home/HomeCatalog';
import { HomeTelemetryCollector } from '../src/home/HomeTelemetryCollector';
import { HomeTelemetryRepository } from '../src/home/HomeTelemetryRepository';

describe('durable home telemetry', () => {
  let db: Database.Database;
  let repository: HomeTelemetryRepository;

  beforeEach(() => {
    db = createConversationDb(':memory:');
    repository = new HomeTelemetryRepository(db);
  });

  afterEach(() => db.close());

  test('stores deduplicated, household-scoped state and numeric history', () => {
    const entity = {
      homeId: 'home-a',
      entityId: 'sensor.room_temperature',
      deviceId: 'room-sensor',
      roomId: 'room-a',
      domain: 'sensor',
      role: 'primary',
      unitOfMeasurement: '°C',
      deviceClass: 'temperature',
      stateClass: 'measurement',
    };
    const sample = {
      entity,
      observedAtMs: 1_000,
      state: '20.5',
      numericValue: 20.5,
      attributes: { unit_of_measurement: '°C' },
      source: 'home_assistant_history' as const,
      capturedAtMs: 2_000,
    };
    expect(repository.ingest([sample, sample])).toBe(1);
    expect(repository.listEntities('home-a')).toEqual([
      expect.objectContaining({ entityId: entity.entityId, roomId: 'room-a', deviceClass: 'temperature' }),
    ]);
    expect(repository.listEntities('home-b')).toEqual([]);
    expect(repository.history({ homeId: 'home-a', entityId: entity.entityId, fromMs: 0, toMs: 2_000, limit: 10 }))
      .toEqual([
        expect.objectContaining({ state: '20.5', numericValue: 20.5, attributes: { unit_of_measurement: '°C' } }),
      ]);
    repository.ingest([{ ...sample, observedAtMs: 1_500, entity: {
      ...entity,
      unitOfMeasurement: undefined,
      deviceClass: undefined,
      stateClass: undefined,
    } }]);
    expect(repository.listEntities('home-a')).toEqual([
      expect.objectContaining({
        entityId: entity.entityId,
        unitOfMeasurement: '°C',
        deviceClass: 'temperature',
        stateClass: 'measurement',
      }),
    ]);
  });

  test('discovers primary and companion entities from the canonical home catalog', () => {
    const catalog = new HomeCatalog('config/homes', 'home_fr_paris_10_fsm_236_lot_204');
    expect(catalog.getTelemetryEntities()).toEqual(expect.arrayContaining([
      expect.objectContaining({ entityId: 'light.plafonnier_chambre', role: 'primary' }),
      expect.objectContaining({
        entityId: 'sensor.temperature_chambre_de_reference',
        role: 'climate.temperatureEntityId',
      }),
      expect.objectContaining({
        entityId: 'switch.salle_deau_chauffe_eau_ariston_net_power',
        role: 'water_heater.powerSwitchEntityId',
      }),
      expect.objectContaining({
        entityId: 'binary_sensor.salle_deau_chauffe_eau_ariston_net_is_heating',
        role: 'water_heater.heatingEntityId',
      }),
      expect.objectContaining({
        entityId: 'sensor.thermometre_salon_humidity',
        role: 'environment.humidityEntityId',
      }),
      expect.objectContaining({
        entityId: 'sensor.temperature_exterieure_jarvis',
        role: 'external_temperature',
      }),
      expect.objectContaining({
        entityId: 'weather.forecast_maison',
        role: 'external_weather',
      }),
    ]));
  });

  test('persists useful scalar outdoor weather attributes without attribution metadata', async () => {
    const state = {
      entity_id: 'weather.forecast_maison',
      state: 'sunny',
      last_updated: '2026-10-14T16:02:00.000Z',
      attributes: {
        temperature: 18.8,
        humidity: 57,
        pressure: 1028.3,
        wind_speed: 5,
        cloud_coverage: 9.4,
        attribution: 'must not be stored',
        friendly_name: 'Forecast Maison',
      },
    };
    const collector = new HomeTelemetryCollector(
      {
        getStates: jest.fn(async () => [state]),
        getHistoryForEntities: jest.fn(async () => [[state]]),
      } as unknown as HomeAssistantClient,
      {
        getTelemetryEntities: () => [{
          entityId: state.entity_id,
          deviceId: 'outdoor-weather',
          role: 'external_weather',
        }],
      } as unknown as HomeCatalog,
      repository,
      {
        homeId: 'home-a',
        intervalMs: 300_000,
        initialLookbackMs: 86_400_000,
        maximumCatchupMs: 1_209_600_000,
        retentionMs: 63_072_000_000,
      }
    );

    await expect(collector.syncNow(Date.parse('2026-10-14T16:03:00.000Z'))).resolves.toBe(2);
    expect(repository.history({
      homeId: 'home-a',
      entityId: state.entity_id,
      fromMs: Date.parse('2026-10-14T16:00:00.000Z'),
      toMs: Date.parse('2026-10-14T16:04:00.000Z'),
      limit: 10,
    })).toEqual(expect.arrayContaining([
      expect.objectContaining({
        state: 'sunny',
        attributes: {
          temperature: 18.8,
          humidity: 57,
          pressure: 1028.3,
          wind_speed: 5,
          cloud_coverage: 9.4,
        },
      }),
    ]));
  });

  test('stores explicit periodic thermal samples, drops recurring HA boundary states and keeps data indefinitely', async () => {
    repository.ingest([{
      entity: {
        homeId: 'home-a',
        entityId: 'light.archived',
        domain: 'light',
        role: 'primary',
      },
      observedAtMs: 1,
      state: 'off',
      source: 'home_assistant_history',
      capturedAtMs: 1,
    }]);
    const currentState = {
      entity_id: 'sensor.room_temperature',
      state: '20.5',
      last_updated: '2026-10-14T08:00:00.000Z',
      attributes: {
        device_class: 'temperature',
        state_class: 'measurement',
        unit_of_measurement: '°C',
      },
    };
    const getHistoryForEntities = jest.fn(async (
      _entityIds: string[],
      start: Date
    ) => [[{ ...currentState, last_changed: start.toISOString(), last_updated: start.toISOString() }]]);
    const collector = new HomeTelemetryCollector(
      {
        getStates: jest.fn(async () => [currentState]),
        getHistoryForEntities,
      } as unknown as HomeAssistantClient,
      {
        getTelemetryEntities: () => [{
          entityId: currentState.entity_id,
          deviceId: 'room-sensor',
          roomId: 'room-a',
          role: 'primary',
        }],
      } as unknown as HomeCatalog,
      repository,
      {
        homeId: 'home-a',
        intervalMs: 300_000,
        initialLookbackMs: 3_600_000,
        maximumCatchupMs: 86_400_000,
        retentionMs: 0,
      }
    );
    const firstNow = Date.parse('2026-10-14T10:00:00.000Z');
    const secondNow = firstNow + 300_000;

    await expect(collector.syncNow(firstNow)).resolves.toBe(2);
    await expect(collector.syncNow(secondNow)).resolves.toBe(1);

    const temperatureHistory = repository.history({
      homeId: 'home-a',
      entityId: currentState.entity_id,
      fromMs: 0,
      toMs: secondNow,
      limit: 10,
    });
    expect(temperatureHistory).toHaveLength(3);
    expect(temperatureHistory.map((point) => point.observedAt)).toEqual([
      new Date(firstNow - 3_600_000).toISOString(),
      new Date(firstNow).toISOString(),
      new Date(secondNow).toISOString(),
    ]);
    expect(repository.history({
      homeId: 'home-a',
      entityId: 'light.archived',
      fromMs: 0,
      toMs: secondNow,
      limit: 10,
    })).toHaveLength(1);
  });

  test('backfills a newly mapped entity even when the household cursor is recent', async () => {
    repository.ingest([{
      entity: {
        homeId: 'home-a',
        entityId: 'light.known',
        domain: 'light',
        role: 'primary',
      },
      observedAtMs: 1_000,
      state: 'off',
      source: 'home_assistant_history',
      capturedAtMs: 1_000,
    }]);
    const now = Date.parse('2026-10-14T10:00:00.000Z');
    repository.markSyncSuccess('home-a', now - 300_000, now - 300_000);
    const getHistoryForEntities = jest.fn(async () => []);
    const collector = new HomeTelemetryCollector(
      {
        getStates: jest.fn(async () => []),
        getHistoryForEntities,
      } as unknown as HomeAssistantClient,
      {
        getTelemetryEntities: () => [
          { entityId: 'light.known', deviceId: 'known', role: 'primary' },
          { entityId: 'sensor.new_temperature', deviceId: 'new-sensor', role: 'primary' },
        ],
      } as unknown as HomeCatalog,
      repository,
      {
        homeId: 'home-a',
        intervalMs: 300_000,
        initialLookbackMs: 172_800_000,
        maximumCatchupMs: 1_209_600_000,
        retentionMs: 0,
      }
    );

    await collector.syncNow(now);

    expect(getHistoryForEntities).toHaveBeenCalledWith(
      ['light.known', 'sensor.new_temperature'],
      new Date(now - 172_800_000),
      new Date(now),
      true
    );
  });

  test('catches up a long outage in bounded chunks without skipping history', async () => {
    const now = Date.parse('2026-10-14T10:00:00.000Z');
    const oldCursor = now - 40 * 86_400_000;
    repository.ingest([{
      entity: {
        homeId: 'home-a',
        entityId: 'sensor.room_temperature',
        domain: 'sensor',
        role: 'primary',
        deviceClass: 'temperature',
      },
      observedAtMs: oldCursor,
      state: '18',
      numericValue: 18,
      source: 'home_assistant_history',
      capturedAtMs: oldCursor,
    }]);
    repository.markSyncSuccess('home-a', oldCursor, oldCursor);
    const getHistoryForEntities = jest.fn(async () => []);
    const collector = new HomeTelemetryCollector(
      {
        getStates: jest.fn(async () => []),
        getHistoryForEntities,
      } as unknown as HomeAssistantClient,
      {
        getTelemetryEntities: () => [{
          entityId: 'sensor.room_temperature',
          deviceId: 'room-sensor',
          role: 'primary',
        }],
      } as unknown as HomeCatalog,
      repository,
      {
        homeId: 'home-a',
        intervalMs: 300_000,
        initialLookbackMs: 14 * 86_400_000,
        maximumCatchupMs: 14 * 86_400_000,
        retentionMs: 0,
      }
    );

    await collector.syncNow(now);

    expect(getHistoryForEntities).toHaveBeenCalledWith(
      ['sensor.room_temperature'],
      new Date(oldCursor - 1_000),
      new Date(oldCursor + 14 * 86_400_000),
      true
    );
    expect(repository.getSyncState('home-a').historyCursorAtMs)
      .toBe(oldCursor + 14 * 86_400_000);
  });

  test('synchronizes HA history, keeps only approved attributes and advances the durable cursor', async () => {
    const getStates = jest.fn(async () => [{
      entity_id: 'light.room',
      state: 'off',
      last_updated: '2026-10-14T10:05:00.000Z',
      attributes: { brightness: 0, friendly_name: 'Private label', entity_picture: '/api/camera_proxy/private' },
    }]);
    const getHistoryForEntities = jest.fn(async () => [[{
      entity_id: 'light.room',
      state: 'on',
      last_updated: '2026-10-14T10:01:00.000Z',
      attributes: { brightness: 180, friendly_name: 'Private label', access_token: 'secret' },
    }]]);
    const catalog = {
      getTelemetryEntities: () => [{ entityId: 'light.room', deviceId: 'room-light', roomId: 'room-a', role: 'primary' }],
    } as unknown as HomeCatalog;
    const collector = new HomeTelemetryCollector(
      { getStates, getHistoryForEntities } as unknown as HomeAssistantClient,
      catalog,
      repository,
      {
        homeId: 'home-a',
        intervalMs: 300_000,
        initialLookbackMs: 86_400_000,
        maximumCatchupMs: 1_209_600_000,
        retentionMs: 63_072_000_000,
      }
    );
    const now = Date.parse('2026-10-14T10:06:00.000Z');
    await expect(collector.syncNow(now)).resolves.toBe(2);
    expect(getHistoryForEntities).toHaveBeenCalledWith(
      ['light.room'],
      expect.any(Date),
      new Date(now),
      true
    );
    expect(repository.history({ homeId: 'home-a', entityId: 'light.room', fromMs: 0, toMs: now, limit: 10 }))
      .toEqual([
        expect.objectContaining({ state: 'on', attributes: { brightness: 180 } }),
        expect.objectContaining({ state: 'off', attributes: { brightness: 0 } }),
      ]);
    expect(repository.getSyncState('home-a')).toMatchObject({ historyCursorAtMs: now });
  });

  test('keeps the prior cursor when Home Assistant synchronization fails', async () => {
    repository.markSyncSuccess('home-a', 5_000, 5_000);
    const collector = new HomeTelemetryCollector(
      {
        getStates: jest.fn(async () => { throw new Error('offline'); }),
        getHistoryForEntities: jest.fn(async () => []),
      } as unknown as HomeAssistantClient,
      {
        getTelemetryEntities: () => [{ entityId: 'light.room', deviceId: 'light', roomId: 'room-a', role: 'primary' }],
      } as unknown as HomeCatalog,
      repository,
      {
        homeId: 'home-a',
        intervalMs: 300_000,
        initialLookbackMs: 86_400_000,
        maximumCatchupMs: 1_209_600_000,
        retentionMs: 63_072_000_000,
      }
    );
    await expect(collector.syncNow(10_000)).resolves.toBe(0);
    expect(repository.getSyncState('home-a')).toMatchObject({
      historyCursorAtMs: 5_000,
      lastErrorCode: 'home_telemetry_sync_failed',
    });
  });
});
