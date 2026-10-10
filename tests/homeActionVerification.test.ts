import { describe, expect, jest, test } from '@jest/globals';

import {
  type HomeAssistantClient,
  HomeAssistantRequestError,
} from '../src/haClient';
import {
  aggregateSceneOutcome,
  executeCatalogHomeAction,
} from '../src/home/HomeActionExecutor';
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

  test('reports an uncertain result when an accepted command never reaches the requested state', async () => {
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

    expect(result).toEqual({ ok: true, domain: 'vacuum', operationStatus: 'uncertain' });
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

  test('does not retry or report failure when transport breaks after a mutation may have been sent', async () => {
    const callService = jest.fn<HomeAssistantClient['callService']>(async () => {
      throw new HomeAssistantRequestError('timeout after send', 'transport', true);
    });

    const result = await executeCatalogHomeAction({
      catalog: catalog('light.salon'),
      ha: { callService } as unknown as HomeAssistantClient,
      command: { deviceId: 'device-1', action: 'turn_on' },
    });

    expect(result).toEqual({ ok: true, domain: 'light', operationStatus: 'uncertain' });
    expect(callService).toHaveBeenCalledTimes(1);
  });

  test('aggregates confirmed, accepted, partial, failed and uncertain scene outcomes', () => {
    const step = (outcome: 'confirmed' | 'accepted' | 'failed' | 'uncertain') => ({
      deviceId: outcome,
      action: 'turn_on' as const,
      status: outcome === 'failed' ? 'failed' as const : 'success' as const,
      outcome,
    });

    expect(aggregateSceneOutcome([step('confirmed'), step('confirmed')])).toBe('confirmed');
    expect(aggregateSceneOutcome([step('accepted'), step('accepted')])).toBe('accepted');
    expect(aggregateSceneOutcome([step('confirmed'), step('failed')])).toBe('partial');
    expect(aggregateSceneOutcome([step('failed'), step('failed')])).toBe('failed');
    expect(aggregateSceneOutcome([step('confirmed'), step('accepted')])).toBe('uncertain');
    expect(aggregateSceneOutcome([step('accepted'), step('failed')])).toBe('uncertain');
  });
});
