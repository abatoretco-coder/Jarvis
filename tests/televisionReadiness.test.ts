import { describe, expect, jest, test } from '@jest/globals';

import type { HomeAssistantClient } from '../src/haClient';
import { executeCatalogHomeAction } from '../src/home/HomeActionExecutor';
import type { HomeCatalog } from '../src/home/HomeCatalog';
import { ensureTelevisionReady } from '../src/home/TelevisionReadiness';

describe('television readiness', () => {
  test('wakes an off television and waits until Home Assistant reports it ready', async () => {
    const getState = jest
      .fn<HomeAssistantClient['getState']>()
      .mockResolvedValueOnce({ entity_id: 'media_player.lg_tv', state: 'off', attributes: {} })
      .mockResolvedValueOnce({ entity_id: 'media_player.lg_tv', state: 'off', attributes: {} })
      .mockResolvedValueOnce({ entity_id: 'media_player.lg_tv', state: 'on', attributes: {} });
    const callService = jest.fn<HomeAssistantClient['callService']>(async () => ({ status: 200, data: [] }));
    const wait = jest.fn(async (_milliseconds: number) => undefined);

    const result = await ensureTelevisionReady({
      ha: { getState, callService } as unknown as HomeAssistantClient,
      entityId: 'media_player.lg_tv',
      wakeOnLanMac: '60:95:F8:5B:E7:CA',
      wakeOnLanBroadcastAddress: '192.168.1.255',
      pollAttempts: 3,
      wait,
    });

    expect(result).toMatchObject({ ok: true, state: { state: 'on' } });
    expect(callService).toHaveBeenCalledWith({
      domain: 'wake_on_lan',
      service: 'send_magic_packet',
      serviceData: {
        mac: '60:95:F8:5B:E7:CA',
        broadcast_address: '192.168.1.255',
      },
    });
    expect(wait).toHaveBeenCalledTimes(2);
    expect(getState).toHaveBeenCalledTimes(3);
  });

  test('returns immediately when the television is already active', async () => {
    const getState = jest.fn(async () => ({
      entity_id: 'media_player.lg_tv',
      state: 'playing',
      attributes: {},
    }));
    const callService = jest.fn();
    const wait = jest.fn(async (_milliseconds: number) => undefined);

    const result = await ensureTelevisionReady({
      ha: { getState, callService } as unknown as HomeAssistantClient,
      entityId: 'media_player.lg_tv',
      wait,
    });

    expect(result).toMatchObject({ ok: true, state: { state: 'playing' } });
    expect(callService).not.toHaveBeenCalled();
    expect(wait).not.toHaveBeenCalled();
  });

  test('reports a timeout only after exhausting the readiness window', async () => {
    const getState = jest.fn(async () => ({
      entity_id: 'media_player.lg_tv',
      state: 'off',
      attributes: {},
    }));
    const callService = jest.fn<HomeAssistantClient['callService']>(async () => ({ status: 200, data: [] }));
    const wait = jest.fn(async (_milliseconds: number) => undefined);

    const result = await ensureTelevisionReady({
      ha: { getState, callService } as unknown as HomeAssistantClient,
      entityId: 'media_player.lg_tv',
      pollAttempts: 3,
      wait,
    });

    expect(result).toEqual({ ok: false, code: 'television_state_timeout' });
    expect(callService).toHaveBeenCalledWith({
      domain: 'media_player',
      service: 'turn_on',
      target: { entity_id: 'media_player.lg_tv' },
    });
    expect(wait).toHaveBeenCalledTimes(3);
    expect(getState).toHaveBeenCalledTimes(4);
  });

  test('makes a catalog TV turn-on action wait for the ready state before succeeding', async () => {
    const catalog = {
      getMapping: () => ({
        deviceId: 'living-room-tv',
        entityId: 'media_player.lg_tv',
        presetId: 'television',
        television: { wakeOnLanMac: '60:95:F8:5B:E7:CA' },
      }),
    } as unknown as HomeCatalog;
    const getState = jest
      .fn<HomeAssistantClient['getState']>()
      .mockResolvedValueOnce({ entity_id: 'media_player.lg_tv', state: 'off', attributes: {} })
      .mockResolvedValueOnce({ entity_id: 'media_player.lg_tv', state: 'on', attributes: {} });
    const callService = jest.fn<HomeAssistantClient['callService']>(async () => ({ status: 200, data: [] }));

    const result = await executeCatalogHomeAction({
      catalog,
      ha: { getState, callService } as unknown as HomeAssistantClient,
      command: { deviceId: 'living-room-tv', action: 'turn_on' },
      televisionPollAttempts: 2,
      wait: async () => undefined,
    });

    expect(result).toEqual({
      ok: true,
      domain: 'media_player',
      operationStatus: 'succeeded',
      observedState: 'on',
    });
    expect(getState).toHaveBeenCalledTimes(2);
    expect(callService).toHaveBeenCalledWith({
      domain: 'wake_on_lan',
      service: 'send_magic_packet',
      serviceData: { mac: '60:95:F8:5B:E7:CA' },
    });
  });
});
