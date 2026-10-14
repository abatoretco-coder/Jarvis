import { describe, expect, jest, test } from '@jest/globals';

import {
  type HomeAssistantClient,
  HomeAssistantRequestError,
} from '../src/haClient';
import {
  aggregateSceneOutcome,
  executeCatalogHomeAction,
  executeCatalogHomeScene,
} from '../src/home/HomeActionExecutor';
import type { HomeCatalog } from '../src/home/HomeCatalog';

function catalog(entityId: string): HomeCatalog {
  return { getMapping: () => ({ deviceId: 'device-1', entityId }) } as unknown as HomeCatalog;
}

describe('home action state verification', () => {
  test('rejects malformed commands before calling Home Assistant on every entry path', async () => {
    const callService = jest.fn<HomeAssistantClient['callService']>(async () => ({ status: 200, data: [] }));

    const result = await executeCatalogHomeAction({
      catalog: catalog('media_player.tv'),
      ha: { callService } as unknown as HomeAssistantClient,
      command: { deviceId: 'device-1', action: 'set_volume' },
    });

    expect(result).toEqual({
      ok: false,
      status: 400,
      code: 'home_action_option_invalid',
      domain: 'media_player',
    });
    expect(callService).not.toHaveBeenCalled();
  });

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
    // One read enforces the live-state policy, then three reads verify the outcome.
    expect(getState).toHaveBeenCalledTimes(4);
  });

  test('confirms light brightness from the observed attribute instead of the HTTP acknowledgement', async () => {
    const getState = jest.fn<HomeAssistantClient['getState']>()
      .mockResolvedValueOnce({ entity_id: 'light.salon', state: 'on', attributes: { supported_color_modes: ['brightness'], brightness: 50 } })
      .mockResolvedValueOnce({ entity_id: 'light.salon', state: 'on', attributes: { supported_color_modes: ['brightness'], brightness: 128 } });
    const callService = jest.fn<HomeAssistantClient['callService']>(async () => ({ status: 200, data: [] }));

    await expect(executeCatalogHomeAction({
      catalog: catalog('light.salon'),
      ha: { getState, callService } as unknown as HomeAssistantClient,
      command: { deviceId: 'device-1', action: 'set_brightness', value: 50 },
      statePollAttempts: 1,
    })).resolves.toMatchObject({ operationStatus: 'succeeded', observedState: 'on' });
    expect(callService).toHaveBeenCalledTimes(1);
  });

  test('confirms climate targets and reports unavailable equipment as uncertain', async () => {
    const callService = jest.fn<HomeAssistantClient['callService']>(async () => ({ status: 200, data: [] }));
    const confirmed = executeCatalogHomeAction({
      catalog: catalog('climate.office'),
      ha: {
        callService,
        getState: jest.fn<HomeAssistantClient['getState']>()
          .mockResolvedValueOnce({ entity_id: 'climate.office', state: 'heat', attributes: { min_temp: 5, max_temp: 30, temperature: 19 } })
          .mockResolvedValueOnce({ entity_id: 'climate.office', state: 'heat', attributes: { temperature: 21 } }),
      } as unknown as HomeAssistantClient,
      command: { deviceId: 'device-1', action: 'set_temperature', value: 21 },
      statePollAttempts: 1,
    });
    await expect(confirmed).resolves.toMatchObject({ operationStatus: 'succeeded' });

    await expect(executeCatalogHomeAction({
      catalog: catalog('switch.water_heater'),
      ha: {
        callService,
        getState: jest.fn(async () => ({ entity_id: 'switch.water_heater', state: 'unavailable', attributes: {} })),
      } as unknown as HomeAssistantClient,
      command: { deviceId: 'device-1', action: 'turn_on' },
      statePollAttempts: 1,
    })).resolves.toEqual({ ok: true, domain: 'switch', operationStatus: 'uncertain' });
  });

  test('rejects robot commands that contradict the live state before mutation', async () => {
    const getState = jest.fn<HomeAssistantClient['getState']>(async () => ({
      entity_id: 'vacuum.robot', state: 'cleaning', attributes: {},
    }));
    const callService = jest.fn<HomeAssistantClient['callService']>();

    const result = await executeCatalogHomeAction({
      catalog: catalog('vacuum.robot'),
      ha: { getState, callService } as unknown as HomeAssistantClient,
      command: { deviceId: 'device-1', action: 'start' },
    });

    expect(result).toEqual({ ok: false, status: 409, code: 'home_action_state_conflict', domain: 'vacuum' });
    expect(callService).not.toHaveBeenCalled();
  });

  test('rejects television controls while power state is transitioning', async () => {
    const getState = jest.fn<HomeAssistantClient['getState']>(async () => ({
      entity_id: 'media_player.tv', state: 'turning_on', attributes: {},
    }));
    const callService = jest.fn<HomeAssistantClient['callService']>();
    const tvCatalog = {
      getMapping: () => ({ deviceId: 'device-1', entityId: 'media_player.tv', presetId: 'television' }),
    } as unknown as HomeCatalog;

    const result = await executeCatalogHomeAction({
      catalog: tvCatalog,
      ha: { getState, callService } as unknown as HomeAssistantClient,
      command: { deviceId: 'device-1', action: 'remote_key', option: 'HOME' },
    });

    expect(result).toEqual({ ok: false, status: 409, code: 'home_action_state_conflict', domain: 'media_player' });
    expect(callService).not.toHaveBeenCalled();
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

  test('rejects a second command for the same device while the first one is still in flight', async () => {
    let releaseFirstCommand!: () => void;
    const firstCommandPending = new Promise<void>((resolve) => {
      releaseFirstCommand = resolve;
    });
    const sharedCatalog = catalog('light.salon');
    const callService = jest.fn<HomeAssistantClient['callService']>(async () => {
      await firstCommandPending;
      return { status: 200, data: [] };
    });
    const getState = jest.fn<HomeAssistantClient['getState']>(async () => ({
      entity_id: 'light.salon', state: 'off', attributes: {},
    }));
    const ha = { getState, callService } as unknown as HomeAssistantClient;

    const first = executeCatalogHomeAction({
      catalog: sharedCatalog,
      ha,
      command: { deviceId: 'device-1', action: 'turn_on' },
      statePollAttempts: 1,
    });
    await Promise.resolve();

    await expect(executeCatalogHomeAction({
      catalog: sharedCatalog,
      ha,
      command: { deviceId: 'device-1', action: 'turn_off' },
    })).resolves.toEqual({ ok: false, status: 409, code: 'home_action_in_progress' });

    releaseFirstCommand();
    await first;
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

  test('prevalidates every Stream Deck scene step before sending any command', async () => {
    const callService = jest.fn<HomeAssistantClient['callService']>(async () => ({ status: 200, data: [] }));
    const mappings = {
      light: { deviceId: 'light', entityId: 'light.salon' },
      vacuum: { deviceId: 'vacuum', entityId: 'vacuum.nono' },
    };
    const result = await executeCatalogHomeScene({
      catalog: {
        getMapping: (deviceId: keyof typeof mappings) => mappings[deviceId],
      } as unknown as HomeCatalog,
      ha: { callService } as unknown as HomeAssistantClient,
      principal: {
        kind: 'user',
        userId: 'owner-id',
        email: 'owner@example.test',
        displayName: 'Owner',
        status: 'active',
        roles: ['owner'],
        permissions: ['home'],
        sessionId: 'session',
        clientId: 'jarvis-streamdeck',
      },
      scene: {
        sceneId: 'scene-test',
        name: 'Test',
        icon: 'home',
        steps: [
          { deviceId: 'light', action: 'turn_on' },
          { deviceId: 'vacuum', action: 'start' },
        ],
        voicePhrases: [],
        sortOrder: 0,
      },
    });

    expect(result).toMatchObject({
      status: 'failed',
      outcome: 'failed',
      errorCode: 'client_scope_forbidden',
    });
    expect(callService).not.toHaveBeenCalled();
  });

  test('allows the Film scene to control only its light-switch steps for Stream Deck', async () => {
    const callService = jest.fn<HomeAssistantClient['callService']>(async () => ({ status: 200, data: [] }));
    let stateReads = 0;
    const getState = jest.fn<HomeAssistantClient['getState']>(async (entityId) => ({
      entity_id: entityId,
      state: stateReads++ === 0 ? 'off' : 'on',
      attributes: {},
    }));
    const result = await executeCatalogHomeScene({
      catalog: {
        getMapping: () => ({ deviceId: 'lava-lamp', entityId: 'switch.lava_lamp' }),
      } as unknown as HomeCatalog,
      ha: { callService, getState } as unknown as HomeAssistantClient,
      principal: {
        kind: 'user',
        userId: 'owner-id',
        email: 'owner@example.test',
        displayName: 'Owner',
        status: 'active',
        roles: ['owner'],
        permissions: ['home'],
        sessionId: 'session',
        clientId: 'jarvis-streamdeck',
      },
      scene: {
        sceneId: 'film',
        name: 'Film',
        icon: 'media',
        steps: [{ deviceId: 'lava-lamp', action: 'turn_on' }],
        voicePhrases: [],
        sortOrder: 0,
      },
    });

    expect(result).toMatchObject({ status: 'success', outcome: 'confirmed' });
    expect(callService).toHaveBeenCalledWith(expect.objectContaining({ domain: 'switch', service: 'turn_on' }));
  });

  test('keeps an all-off scene successful when the television is already off', async () => {
    const callService = jest.fn<HomeAssistantClient['callService']>(async () => ({ status: 200, data: [] }));
    const getState = jest.fn<HomeAssistantClient['getState']>(async (entityId) => ({
      entity_id: entityId,
      state: 'off',
      attributes: {},
    }));
    const mappings = {
      light: { deviceId: 'light', entityId: 'light.salon' },
      tv: { deviceId: 'tv', entityId: 'media_player.tv', presetId: 'television' },
    };

    const result = await executeCatalogHomeScene({
      catalog: {
        getMapping: (deviceId: keyof typeof mappings) => mappings[deviceId],
      } as unknown as HomeCatalog,
      ha: { callService, getState } as unknown as HomeAssistantClient,
      scene: {
        sceneId: 'leave-home',
        name: 'Tout couper',
        icon: 'home',
        steps: [
          { deviceId: 'light', action: 'turn_off' },
          { deviceId: 'tv', action: 'turn_off' },
        ],
        voicePhrases: ['je suis parti'],
        sortOrder: 0,
      },
    });

    expect(result).toMatchObject({ status: 'success', outcome: 'confirmed' });
    expect(callService).toHaveBeenCalledTimes(1);
    expect(callService).toHaveBeenCalledWith(expect.objectContaining({
      domain: 'light',
      service: 'turn_off',
    }));
  });
});
