import { describe, expect, jest, test } from '@jest/globals';

import type { HomeAssistantClient } from '../src/haClient';
import { executeCatalogHomeAction } from '../src/home/HomeActionExecutor';
import type { HomeCatalog } from '../src/home/HomeCatalog';

function catalog(entityId: string): HomeCatalog {
  return { getMapping: () => ({ deviceId: 'device-1', entityId }) } as unknown as HomeCatalog;
}

describe('home action state verification', () => {
  test('confirms a light only after Home Assistant exposes the requested state', async () => {
    const getState = jest
      .fn<HomeAssistantClient['getState']>()
      .mockResolvedValueOnce({ entity_id: 'light.salon', state: 'off', attributes: {} })
      .mockResolvedValueOnce({ entity_id: 'light.salon', state: 'on', attributes: {} });
    const callService = jest.fn<HomeAssistantClient['callService']>(async () => ({ status: 200, data: [] }));
    const wait = jest.fn(async () => undefined);

    const result = await executeCatalogHomeAction({
      catalog: catalog('light.salon'),
      ha: { getState, callService } as unknown as HomeAssistantClient,
      command: { deviceId: 'device-1', action: 'turn_on' },
      statePollAttempts: 2,
      wait,
    });

    expect(result).toEqual({
      ok: true,
      domain: 'light',
      operationStatus: 'succeeded',
      observedState: 'on',
    });
    expect(callService).toHaveBeenCalledTimes(1);
    expect(wait).toHaveBeenCalledTimes(1);
  });

  test('reports a timeout when a readable device never reaches the requested state', async () => {
    const getState = jest.fn<HomeAssistantClient['getState']>(async () => ({
      entity_id: 'vacuum.robot',
      state: 'docked',
      attributes: {},
    }));
    const callService = jest.fn<HomeAssistantClient['callService']>(async () => ({ status: 200, data: [] }));

    const result = await executeCatalogHomeAction({
      catalog: catalog('vacuum.robot'),
      ha: { getState, callService } as unknown as HomeAssistantClient,
      command: { deviceId: 'device-1', action: 'start' },
      statePollAttempts: 3,
      wait: async () => undefined,
    });

    expect(result).toEqual({
      ok: false,
      status: 503,
      code: 'home_device_state_timeout',
      domain: 'vacuum',
    });
    expect(getState).toHaveBeenCalledTimes(3);
  });

  test('keeps an accepted result when state observation itself is unavailable', async () => {
    const getState = jest.fn<HomeAssistantClient['getState']>(async () => {
      throw new Error('unreachable');
    });
    const callService = jest.fn<HomeAssistantClient['callService']>(async () => ({ status: 200, data: [] }));

    const result = await executeCatalogHomeAction({
      catalog: catalog('switch.heater'),
      ha: { getState, callService } as unknown as HomeAssistantClient,
      command: { deviceId: 'device-1', action: 'turn_off' },
      wait: async () => undefined,
    });

    expect(result).toEqual({ ok: true, domain: 'switch', operationStatus: 'accepted' });
  });
});
