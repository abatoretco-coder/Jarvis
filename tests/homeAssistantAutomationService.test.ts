import { describe, expect, jest, test } from '@jest/globals';

import { createConversationDb } from '../src/conversation/repositories/SqliteRepositories';
import type { HomeAssistantAutomationConfig, HomeAssistantClient } from '../src/haClient';
import {
  compileManagedAutomation,
  HomeAssistantAutomationService,
} from '../src/home/HomeAssistantAutomationService';
import type { HomeCatalog } from '../src/home/HomeCatalog';
import { HomeRuntimeStateRepository } from '../src/home/HomeRuntimeStateRepository';

const scene = {
  sceneId: 'scene-evening',
  name: 'Soirée',
  icon: 'home' as const,
  steps: [
    { deviceId: 'living-light', action: 'set_brightness' as const, value: 35 },
    { deviceId: 'living-media', action: 'set_volume' as const, value: 20 },
  ],
  voicePhrases: [],
  sortOrder: 0,
};

function catalog(): HomeCatalog {
  return {
    getScene: jest.fn((id: string) => (id === scene.sceneId ? scene : undefined)),
    getMapping: jest.fn((id: string) =>
      id === 'living-light'
        ? { deviceId: id, entityId: 'light.salon' }
        : id === 'living-media'
          ? { deviceId: id, entityId: 'media_player.salon' }
          : undefined
    ),
  } as unknown as HomeCatalog;
}

describe('HomeAssistantAutomationService', () => {
  test('compiles a Jarvis scene into a native Home Assistant schedule', () => {
    expect(
      compileManagedAutomation(catalog(), {
        name: 'Soirée semaine',
        sceneId: 'scene-evening',
        at: '19:30',
        weekdays: [1, 3, 5],
        enabled: true,
      })
    ).toEqual({
      alias: 'Soirée semaine',
      description: expect.stringMatching(/^jarvis-managed:v2:scene=scene-evening;fingerprint=[a-f0-9]{64}$/u),
      triggers: [{ trigger: 'time', at: '19:30:00' }],
      conditions: [{ condition: 'time', weekday: ['mon', 'wed', 'fri'] }],
      actions: [
        {
          action: 'light.turn_on',
          target: { entity_id: 'light.salon' },
          data: { brightness_pct: 35 },
        },
        {
          action: 'media_player.volume_set',
          target: { entity_id: 'media_player.salon' },
          data: { volume_level: 0.2 },
        },
      ],
      mode: 'single',
      initial_state: true,
    });
  });

  test('lists native and Jarvis-managed automations from Home Assistant', async () => {
    const ha = {
      getStates: jest.fn(async () => [
        {
          entity_id: 'automation.soiree',
          state: 'on',
          attributes: {
            id: 'jarvis_schedule',
            friendly_name: 'Soirée',
            last_triggered: '2026-10-07T18:30:00+00:00',
            mode: 'single',
          },
        },
        {
          entity_id: 'automation.constructeur',
          state: 'off',
          attributes: { id: 'vendor_schedule', friendly_name: 'Constructeur' },
        },
      ]),
      getAutomationConfig: jest.fn(async (id: string) =>
        id === 'jarvis_schedule'
          ? {
              description: 'jarvis-managed:v1:scene=scene-evening',
              triggers: [{ trigger: 'time', at: '19:30:00' }],
              conditions: [{ condition: 'time', weekday: ['mon', 'fri'] }],
            }
          : { description: 'Automation externe' }
      ),
    } as unknown as HomeAssistantClient;
    const service = new HomeAssistantAutomationService(ha, catalog());

    await expect(service.list()).resolves.toEqual([
      expect.objectContaining({
        automationId: 'jarvis_schedule',
        managedByJarvis: true,
        sceneId: 'scene-evening',
        schedule: { at: '19:30', weekdays: [1, 5] },
        enabled: true,
      }),
      expect.objectContaining({
        automationId: 'vendor_schedule',
        managedByJarvis: false,
        description: 'Automation externe',
        enabled: false,
      }),
    ]);
  });

  test('does not delete an automation that Jarvis does not own', async () => {
    const deleteAutomationConfig = jest.fn();
    const ha = {
      getAutomationConfig: jest.fn(async () => ({ description: 'Automation externe' })),
      deleteAutomationConfig,
    } as unknown as HomeAssistantClient;
    const service = new HomeAssistantAutomationService(ha, catalog());

    await expect(service.delete('vendor_schedule')).rejects.toThrow(
      'home_automation_not_managed'
    );
    expect(deleteAutomationConfig).not.toHaveBeenCalled();
  });

  test('resolves the entity server-side before changing its state', async () => {
    const callService = jest.fn(async (_input: unknown) => ({ status: 200, data: [] }));
    const ha = {
      getStates: jest.fn(async () => [
        {
          entity_id: 'automation.soiree',
          state: 'on',
          attributes: { id: 'jarvis_schedule', friendly_name: 'Soirée' },
        },
      ]),
      getAutomationConfig: jest.fn(async () => ({
        description: 'jarvis-managed:v1:scene=scene-evening',
      })),
      callService,
    } as unknown as HomeAssistantClient;
    const service = new HomeAssistantAutomationService(ha, catalog());

    await service.setEnabled('jarvis_schedule', false);
    expect(callService).toHaveBeenCalledWith({
      domain: 'automation',
      service: 'turn_off',
      target: { entity_id: 'automation.soiree' },
    });
  });

  test('never enables or runs an automation not owned by Jarvis', async () => {
    const callService = jest.fn();
    const ha = {
      getAutomationConfig: jest.fn(async () => ({ description: 'Automation externe' })),
      callService,
    } as unknown as HomeAssistantClient;
    const service = new HomeAssistantAutomationService(ha, catalog());

    await expect(service.setEnabled('vendor_schedule', true)).rejects.toThrow('home_automation_not_managed');
    await expect(service.run('vendor_schedule')).rejects.toThrow('home_automation_not_managed');
    expect(callService).not.toHaveBeenCalled();
  });

  test('reconciles a stale managed automation with the current scene mapping', async () => {
    let state = 'on';
    let currentConfig: HomeAssistantAutomationConfig = {
      alias: 'Soirée',
      description: 'jarvis-managed:v1:scene=scene-evening',
      triggers: [{ trigger: 'time', at: '19:30:00' }],
      conditions: [{ condition: 'time', weekday: ['mon'] }],
      actions: [{ action: 'light.turn_on', target: { entity_id: 'light.old' } }],
    };
    const saveAutomationConfig = jest.fn(async (_id: string, config: HomeAssistantAutomationConfig) => {
      currentConfig = config;
    });
    const callService = jest.fn(async (input: {
      domain: string;
      service: string;
      target: { entity_id: string };
    }) => {
      state = input.service === 'turn_on' ? 'on' : 'off';
      return { status: 200, data: [] };
    });
    const ha = {
      getStates: jest.fn(async () => [{
        entity_id: 'automation.soiree',
        state,
        attributes: { id: 'jarvis_schedule', friendly_name: 'Soirée' },
      }]),
      getAutomationConfig: jest.fn(async () => currentConfig),
      saveAutomationConfig,
      callService,
    } as unknown as HomeAssistantClient;

    await expect(new HomeAssistantAutomationService(ha, catalog()).reconcile()).resolves.toMatchObject({
      operationStatus: 'succeeded',
      updated: ['jarvis_schedule'],
      failed: [],
    });
    expect(saveAutomationConfig).toHaveBeenCalledWith(
      'jarvis_schedule',
      expect.objectContaining({
        description: expect.stringMatching(/^jarvis-managed:v2:/u),
        actions: expect.arrayContaining([
          expect.objectContaining({ target: { entity_id: 'light.salon' } }),
        ]),
      })
    );
    expect(callService.mock.invocationCallOrder[0]).toBeLessThan(saveAutomationConfig.mock.invocationCallOrder[0]!);
    expect(callService).toHaveBeenNthCalledWith(1, {
      domain: 'automation',
      service: 'turn_off',
      target: { entity_id: 'automation.soiree' },
    });
    expect(callService).toHaveBeenLastCalledWith({
      domain: 'automation',
      service: 'turn_on',
      target: { entity_id: 'automation.soiree' },
    });
  });

  test('does not mutate the catalog while an active managed automation cannot be confirmed off', async () => {
    const mutation = jest.fn(() => 'changed');
    const ha = {
      getStates: jest.fn(async () => [{
        entity_id: 'automation.soiree',
        state: 'on',
        attributes: { id: 'jarvis_schedule', friendly_name: 'Soirée' },
      }]),
      getAutomationConfig: jest.fn(async () => ({
        description: 'jarvis-managed:v1:scene=scene-evening',
      })),
      callService: jest.fn(async () => ({ status: 200, data: [] })),
    } as unknown as HomeAssistantClient;

    await expect(
      new HomeAssistantAutomationService(ha, catalog(), async () => undefined)
        .reconcileCatalogMutation(mutation)
    ).rejects.toThrow('home_automation_pause_unconfirmed');
    expect(mutation).not.toHaveBeenCalled();
  });

  test('fails closed when an active automation cannot be classified before a catalog mutation', async () => {
    const mutation = jest.fn(() => 'changed');
    const ha = {
      getStates: jest.fn(async () => [{
        entity_id: 'automation.unreadable',
        state: 'on',
        attributes: { id: 'unreadable_schedule' },
      }]),
      getAutomationConfig: jest.fn(async () => { throw new Error('ha_unavailable'); }),
      callService: jest.fn(),
    } as unknown as HomeAssistantClient;

    await expect(
      new HomeAssistantAutomationService(ha, catalog()).reconcileCatalogMutation(mutation)
    ).rejects.toThrow('home_automation_pause_unconfirmed');
    expect(mutation).not.toHaveBeenCalled();
    expect(ha.callService).not.toHaveBeenCalled();
  });

  test('reactivates a managed automation after catalog reconciliation', async () => {
    let state = 'on';
    const config = compileManagedAutomation(catalog(), {
      name: 'Soirée',
      sceneId: 'scene-evening',
      at: '19:30',
      weekdays: [1],
      enabled: true,
    });
    const callService = jest.fn(async (input: { service: string }) => {
      state = input.service === 'turn_on' ? 'on' : 'off';
      return { status: 200, data: [] };
    });
    const ha = {
      getStates: jest.fn(async () => [{
        entity_id: 'automation.soiree',
        state,
        attributes: { id: 'jarvis_schedule', friendly_name: 'Soirée' },
      }]),
      getAutomationConfig: jest.fn(async () => config),
      callService,
    } as unknown as HomeAssistantClient;
    const mutation = jest.fn(() => 'changed');

    const result = await new HomeAssistantAutomationService(ha, catalog(), async () => undefined)
      .reconcileCatalogMutation(mutation);

    expect(result).toMatchObject({ value: 'changed', reconciliation: { operationStatus: 'succeeded' } });
    expect(mutation).toHaveBeenCalledTimes(1);
    expect(state).toBe('on');
    expect(callService).toHaveBeenNthCalledWith(1, expect.objectContaining({ service: 'turn_off' }));
    expect(callService).toHaveBeenNthCalledWith(2, expect.objectContaining({ service: 'turn_on' }));
  });

  test('reports an uncertain reconciliation when a suspended automation cannot be confirmed active', async () => {
    let state = 'on';
    const config = compileManagedAutomation(catalog(), {
      name: 'Soirée',
      sceneId: 'scene-evening',
      at: '19:30',
      weekdays: [1],
      enabled: true,
    });
    const callService = jest.fn(async (input: { service: string }) => {
      if (input.service === 'turn_off') state = 'off';
      return { status: 200, data: [] };
    });
    const ha = {
      getStates: jest.fn(async () => [{
        entity_id: 'automation.soiree',
        state,
        attributes: { id: 'jarvis_schedule', friendly_name: 'Soirée' },
      }]),
      getAutomationConfig: jest.fn(async () => config),
      callService,
    } as unknown as HomeAssistantClient;

    const result = await new HomeAssistantAutomationService(ha, catalog(), async () => undefined)
      .reconcileCatalogMutation(() => 'changed');

    expect(result.reconciliation.operationStatus).toBe('uncertain');
    expect(callService).toHaveBeenCalledWith(expect.objectContaining({ service: 'turn_on' }));
  });

  test('reports skipped managed automations as a partial reconciliation', async () => {
    const config = compileManagedAutomation(catalog(), {
      name: 'Soirée', sceneId: 'scene-evening', at: '19:30', weekdays: [1], enabled: true,
    });
    config.description = 'jarvis-managed:v1:scene=missing-scene';
    const ha = {
      getStates: jest.fn(async () => [{
        entity_id: 'automation.soiree', state: 'on',
        attributes: { id: 'jarvis_schedule', friendly_name: 'Soirée' },
      }]),
      getAutomationConfig: jest.fn(async () => config),
    } as unknown as HomeAssistantClient;

    await expect(new HomeAssistantAutomationService(ha, catalog()).reconcile()).resolves.toMatchObject({
      operationStatus: 'partial',
      skipped: [{ automationId: 'jarvis_schedule', reason: 'missing_scene' }],
    });
  });

  test('attempts restoration when reconciliation throws after suspension', async () => {
    const db = createConversationDb(':memory:');
    const stateRepository = new HomeRuntimeStateRepository(db);
    let state = 'on';
    let failNextStateRead = false;
    const config = compileManagedAutomation(catalog(), {
      name: 'Soirée', sceneId: 'scene-evening', at: '19:30', weekdays: [1], enabled: true,
    });
    const ha = {
      getStates: jest.fn(async () => {
        if (failNextStateRead) {
          failNextStateRead = false;
          throw new Error('ha_unavailable');
        }
        return [{
          entity_id: 'automation.soiree', state,
          attributes: { id: 'jarvis_schedule', friendly_name: 'Soirée' },
        }];
      }),
      getAutomationConfig: jest.fn(async () => config),
      callService: jest.fn(async (input: { service: string }) => {
        state = input.service === 'turn_on' ? 'on' : 'off';
        return { status: 200, data: [] };
      }),
    } as unknown as HomeAssistantClient;
    const service = new HomeAssistantAutomationService(
      ha, catalog(), async () => undefined, stateRepository
    );

    await expect(service.reconcileCatalogMutation(() => {
      failNextStateRead = true;
      return 'changed';
    })).rejects.toThrow('ha_unavailable');

    expect(state).toBe('on');
    expect(stateRepository.listRecoverableAutomationSuspensions()).toEqual([]);
    expect(stateRepository.listAutomationSuspensions()).toEqual([
      expect.objectContaining({ state: 'restored', automationId: 'jarvis_schedule' }),
    ]);
    db.close();
  });

  test('recovers a safely suspended managed automation after restart', async () => {
    const db = createConversationDb(':memory:');
    const stateRepository = new HomeRuntimeStateRepository(db);
    stateRepository.recordAutomationSuspension({
      operationId: 'catalog-change-1',
      automationId: 'jarvis_schedule',
      entityId: 'automation.soiree',
      sceneId: 'scene-evening',
    }, 100);
    stateRepository.updateAutomationSuspension('catalog-change-1', 'jarvis_schedule', 'suspended', null, 110);
    let state = 'off';
    const config = compileManagedAutomation(catalog(), {
      name: 'Soirée', sceneId: 'scene-evening', at: '19:30', weekdays: [1], enabled: true,
    });
    const callService = jest.fn(async (input: { service: string }) => {
      state = input.service === 'turn_on' ? 'on' : 'off';
      return { status: 200, data: [] };
    });
    const ha = {
      getStates: jest.fn(async () => [{
        entity_id: 'automation.soiree', state,
        attributes: { id: 'jarvis_schedule', friendly_name: 'Soirée' },
      }]),
      getAutomationConfig: jest.fn(async () => config),
      callService,
    } as unknown as HomeAssistantClient;

    const recovery = await new HomeAssistantAutomationService(
      ha, catalog(), async () => undefined, stateRepository
    ).recoverSuspendedAutomations();

    expect(recovery).toMatchObject({ operationStatus: 'succeeded', restored: ['jarvis_schedule'] });
    expect(state).toBe('on');
    expect(callService).toHaveBeenCalledTimes(1);
    db.close();
  });

  test('does not race an active reconciliation or restore a changed automation', async () => {
    const db = createConversationDb(':memory:');
    const stateRepository = new HomeRuntimeStateRepository(db);
    stateRepository.recordAutomationSuspension({
      operationId: 'active-change',
      automationId: 'jarvis_schedule',
      entityId: 'automation.soiree',
      sceneId: 'scene-evening',
    });
    stateRepository.updateAutomationSuspension('active-change', 'jarvis_schedule', 'suspended');
    const changedConfig = compileManagedAutomation(catalog(), {
      name: 'Soirée modifiée', sceneId: 'scene-evening', at: '20:30', weekdays: [1], enabled: true,
    });
    changedConfig.description = JSON.stringify({ managedBy: 'someone-else', sceneId: 'scene-evening' });
    const callService = jest.fn(async () => ({ status: 200, data: [] }));
    const ha = {
      getAutomationConfig: jest.fn(async () => changedConfig),
      getStates: jest.fn(async () => []),
      callService,
    } as unknown as HomeAssistantClient;
    const service = new HomeAssistantAutomationService(
      ha, catalog(), async () => undefined, stateRepository
    );

    expect(await service.recoverSuspendedAutomations()).toMatchObject({
      operationStatus: 'succeeded', restored: [], skipped: [], failed: [],
    });
    expect(callService).not.toHaveBeenCalled();

    expect(await service.recoverSuspendedAutomations({ includeRecent: true })).toMatchObject({
      operationStatus: 'partial', restored: [], skipped: ['jarvis_schedule'], failed: [],
    });
    expect(callService).not.toHaveBeenCalled();

    expect(stateRepository.listAutomationSuspensions()).toEqual([
      expect.objectContaining({ state: 'skipped', errorCode: 'automation_no_longer_safe' }),
    ]);
    db.close();
  });

  test('serializes concurrent catalog reconciliations', async () => {
    const events: string[] = [];
    let state = 'on';
    let releaseFirstMutation!: () => void;
    const firstMutationBlocked = new Promise<void>((resolve) => {
      releaseFirstMutation = resolve;
    });
    const config = compileManagedAutomation(catalog(), {
      name: 'Soirée', sceneId: 'scene-evening', at: '19:30', weekdays: [1], enabled: true,
    });
    const ha = {
      getStates: jest.fn(async () => [{
        entity_id: 'automation.soiree', state,
        attributes: { id: 'jarvis_schedule', friendly_name: 'Soirée' },
      }]),
      getAutomationConfig: jest.fn(async () => config),
      callService: jest.fn(async (input: { service: string }) => {
        state = input.service === 'turn_on' ? 'on' : 'off';
        events.push(input.service);
        return { status: 200, data: [] };
      }),
    } as unknown as HomeAssistantClient;
    const service = new HomeAssistantAutomationService(ha, catalog(), async () => undefined);

    const first = service.reconcileCatalogMutation(async () => {
      events.push('first:start');
      await firstMutationBlocked;
      events.push('first:end');
      return 'first';
    });
    await Promise.resolve();
    await Promise.resolve();
    const second = service.reconcileCatalogMutation(() => {
      events.push('second');
      return 'second';
    });
    await Promise.resolve();
    expect(events).not.toContain('second');
    releaseFirstMutation();
    await expect(first).resolves.toMatchObject({ value: 'first' });
    await expect(second).resolves.toMatchObject({ value: 'second' });
    expect(events.indexOf('second')).toBeGreaterThan(events.indexOf('first:end'));
  });

  test('serializes an automation update behind catalog reconciliation', async () => {
    const events: string[] = [];
    let releaseMutation!: () => void;
    const mutationBlocked = new Promise<void>((resolve) => {
      releaseMutation = resolve;
    });
    let currentConfig = compileManagedAutomation(catalog(), {
      name: 'Soirée', sceneId: 'scene-evening', at: '19:30', weekdays: [1], enabled: false,
    });
    const saveAutomationConfig = jest.fn(async (_id: string, config: HomeAssistantAutomationConfig) => {
      events.push('save');
      currentConfig = config;
    });
    const ha = {
      getStates: jest.fn(async () => [{
        entity_id: 'automation.soiree', state: 'off',
        attributes: { id: 'jarvis_schedule', friendly_name: 'Soirée' },
      }]),
      getAutomationConfig: jest.fn(async () => currentConfig),
      saveAutomationConfig,
      callService: jest.fn(async () => ({ status: 200, data: [] })),
    } as unknown as HomeAssistantClient;
    const service = new HomeAssistantAutomationService(ha, catalog(), async () => undefined);

    const reconciliation = service.reconcileCatalogMutation(async () => {
      events.push('mutation:start');
      await mutationBlocked;
      events.push('mutation:end');
    });
    await Promise.resolve();
    await Promise.resolve();
    const update = service.update('jarvis_schedule', {
      name: 'Soirée tardive', sceneId: 'scene-evening', at: '20:30', weekdays: [1], enabled: false,
    });
    await Promise.resolve();
    expect(saveAutomationConfig).not.toHaveBeenCalled();

    releaseMutation();
    await reconciliation;
    await expect(update).resolves.toBe('succeeded');
    expect(events.indexOf('save')).toBeGreaterThan(events.indexOf('mutation:end'));
  });

  test('does not report success or toggle state until the saved config is observable', async () => {
    const staleConfig = compileManagedAutomation(catalog(), {
      name: 'Ancienne soirée', sceneId: 'scene-evening', at: '19:30', weekdays: [1], enabled: true,
    });
    const callService = jest.fn();
    const ha = {
      getAutomationConfig: jest.fn(async () => staleConfig),
      saveAutomationConfig: jest.fn(async () => undefined),
      getStates: jest.fn(async () => [{
        entity_id: 'automation.soiree', state: 'on',
        attributes: { id: 'jarvis_schedule', friendly_name: 'Soirée' },
      }]),
      callService,
    } as unknown as HomeAssistantClient;
    const wait = jest.fn(async () => undefined);
    const service = new HomeAssistantAutomationService(ha, catalog(), wait);

    await expect(service.update('jarvis_schedule', {
      name: 'Nouvelle soirée', sceneId: 'scene-evening', at: '20:30', weekdays: [2], enabled: false,
    })).resolves.toBe('accepted');
    expect(wait).toHaveBeenCalledTimes(19);
    expect(callService).not.toHaveBeenCalled();
  });

  test('waits for a saved automation to reload and applies the requested state', async () => {
    let savedId = '';
    let savedConfig: unknown;
    const callService = jest.fn(async (_input: unknown) => ({ status: 200, data: [] }));
    const ha = {
      saveAutomationConfig: jest.fn(async (id: string, config: unknown) => {
        savedId = id;
        savedConfig = config;
      }),
      getAutomationConfig: jest.fn(async () => savedConfig),
      getStates: jest.fn(async () => [
        {
          entity_id: 'automation.jarvis_schedule',
          state: 'on',
          attributes: { id: savedId, friendly_name: 'Soirée' },
        },
      ]),
      callService,
    } as unknown as HomeAssistantClient;
    const service = new HomeAssistantAutomationService(ha, catalog());

    const created = await service.create({
      name: 'Soirée',
      sceneId: 'scene-evening',
      at: '19:30',
      weekdays: [1],
      enabled: false,
    });

    expect(created.automationId).toBe(savedId);
    expect(callService).toHaveBeenCalledWith({
      domain: 'automation',
      service: 'turn_off',
      target: { entity_id: 'automation.jarvis_schedule' },
    });
  });

  test('reports an accepted creation when Home Assistant saved the config but has not loaded its entity yet', async () => {
    const wait = jest.fn(async () => undefined);
    const ha = {
      saveAutomationConfig: jest.fn(async () => undefined),
      getStates: jest.fn(async () => []),
      callService: jest.fn(),
    } as unknown as HomeAssistantClient;

    const result = await new HomeAssistantAutomationService(ha, catalog(), wait).create({
      name: 'Soirée',
      sceneId: 'scene-evening',
      at: '19:30',
      weekdays: [1],
      enabled: true,
    });

    expect(result.operationStatus).toBe('accepted');
    expect(wait).toHaveBeenCalledTimes(19);
    expect(ha.callService).not.toHaveBeenCalled();
  });
});
