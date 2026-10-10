import type { HomeAssistantClient } from '../src/haClient';
import type { HomeCatalog } from '../src/home/HomeCatalog';
import { SalonMusicOrchestrator } from '../src/music/SalonMusicOrchestrator';
import type { SpotifyWebApiClient } from '../src/spotifyWebApi';

function catalog() {
  return {
    getMapping: () => ({
      entityId: 'media_player.lg_tv',
      television: {
        wakeOnLanMac: '60:95:F8:5B:E7:CA',
        wakeOnLanBroadcastAddress: '192.168.1.255',
        spotifySource: 'Spotify - Musique et podcasts',
      },
    }),
  } as unknown as HomeCatalog;
}

describe('SalonMusicOrchestrator', () => {
  test('reports an off TV even when it is absent from Spotify Connect', async () => {
    const ha = { getState: async () => ({ entity_id: 'media_player.lg_tv', state: 'off' }) } as unknown as HomeAssistantClient;
    const spotify = {} as SpotifyWebApiClient;
    const status = await new SalonMusicOrchestrator({ ha, catalog: catalog(), spotify }).status([]);
    expect(status).toEqual({ availability: 'off', isActive: false, spotifyDevice: undefined });
  });

  test('turns on the TV, opens its Spotify source and waits for the Connect target', async () => {
    const getState = jest
      .fn()
      .mockResolvedValueOnce({ entity_id: 'media_player.lg_tv', state: 'off', attributes: {} })
      .mockResolvedValue({
        entity_id: 'media_player.lg_tv',
        state: 'on',
        attributes: { source_list: ['YouTube', 'Spotify - Musique et podcasts'] },
      });
    const callService = jest.fn(async () => ({ status: 200, data: [] }));
    const listDevicesPublic = jest
      .fn()
      .mockResolvedValueOnce({ ok: true, devices: [] })
      .mockResolvedValue({ ok: true, devices: [{ id: 'lg-connect', name: '[LG] webOS TV', type: 'TV', isActive: false }] });
    const spotify = {
      invalidateSituationCache: jest.fn(),
      listDevicesPublic,
    } as unknown as SpotifyWebApiClient;
    const result = await new SalonMusicOrchestrator({
      ha: { getState, callService } as unknown as HomeAssistantClient,
      catalog: catalog(),
      spotify,
      wait: async () => undefined,
    }).prepare();

    expect(result).toEqual({ ok: true, deviceId: 'lg-connect' });
    expect(callService).toHaveBeenNthCalledWith(1, {
      domain: 'wake_on_lan',
      service: 'send_magic_packet',
      serviceData: { mac: '60:95:F8:5B:E7:CA', broadcast_address: '192.168.1.255' },
    });
    expect(callService).toHaveBeenNthCalledWith(2, {
      domain: 'media_player',
      service: 'select_source',
      target: { entity_id: 'media_player.lg_tv' },
      serviceData: { source: 'Spotify - Musique et podcasts' },
    });
    expect(listDevicesPublic).toHaveBeenCalledTimes(2);
  });

  test('fails explicitly instead of falling back when the TV never appears in Spotify Connect', async () => {
    const ha = {
      getState: async () => ({
        entity_id: 'media_player.lg_tv',
        state: 'on',
        attributes: { source: 'Spotify - Musique et podcasts' },
      }),
      callService: jest.fn(),
    } as unknown as HomeAssistantClient;
    const spotify = {
      invalidateSituationCache: jest.fn(),
      listDevicesPublic: async () => ({ ok: true as const, devices: [] }),
    } as unknown as SpotifyWebApiClient;
    const result = await new SalonMusicOrchestrator({
      ha,
      catalog: catalog(),
      spotify,
      wait: async () => undefined,
      spotifyPollAttempts: 2,
    }).prepare();
    expect(result).toMatchObject({ ok: false, code: 'salon_spotify_device_timeout' });
  });
});
