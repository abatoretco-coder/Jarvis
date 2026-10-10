import { describe, expect, jest, test } from '@jest/globals';

import type { HomeAssistantClient } from '../src/haClient';
import {
  compileManagedAutomation,
  HomeAssistantAutomationService,
} from '../src/home/HomeAssistantAutomationService';
import type { HomeCatalog } from '../src/home/HomeCatalog';

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
      description: 'jarvis-managed:v1:scene=scene-evening',
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

  test('waits for a saved automation to reload and applies the requested state', async () => {
    let savedId = '';
    const callService = jest.fn(async (_input: unknown) => ({ status: 200, data: [] }));
    const ha = {
      saveAutomationConfig: jest.fn(async (id: string) => {
        savedId = id;
      }),
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
});
