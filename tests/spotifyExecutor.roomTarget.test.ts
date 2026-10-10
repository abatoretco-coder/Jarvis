import { describe, expect, jest, test } from '@jest/globals';

import type { Env } from '../src/env';
import { executeSpotifyCapability } from '../src/spotify/spotifyExecutor';
import type { SpotifyWebApiClient } from '../src/spotifyWebApi';

describe('Spotify room targeting', () => {
  test('preserves an exact Spotify Connect device id supplied by a deterministic UI', async () => {
    const play = jest.fn<(deviceId?: string) => Promise<{ ok: true; status: number }>>(async () => ({ ok: true as const, status: 204 }));
    const spotifyWebApi = {
      isConfigured: () => true,
      play,
      scheduleSituationRefresh: jest.fn(),
    } as unknown as SpotifyWebApiClient;

    const result = await executeSpotifyCapability({
      request: {
        threadId: 'room-target-exact-device',
        domain: 'spotify',
        action: 'play',
        slots: { device_id: '702d00b0a6b26f0dc855213cdaf6dee7bc4a4ae1' },
        context: {},
      },
      spotifyWebApi,
      env: {} as Env,
    });

    expect(result.status).toBe('success');
    expect(play).toHaveBeenCalledWith('702d00b0a6b26f0dc855213cdaf6dee7bc4a4ae1');
  });

  test.each([
    'mets de la musique dans le salon',
    'lance la musique au séjour',
  ])('routes "%s" to the living-room alias', async (text) => {
    const play = jest.fn<(deviceId?: string) => Promise<{ ok: true; status: number }>>(async () => ({ ok: true as const, status: 204 }));
    const getNowPlaying = jest.fn(async () => ({ ok: false as const, error: 'not_called' }));
    const spotifyWebApi = {
      isConfigured: () => true,
      play,
      getNowPlaying,
      scheduleSituationRefresh: jest.fn(),
    } as unknown as SpotifyWebApiClient;

    const result = await executeSpotifyCapability({
      request: {
        threadId: 'room-target-natural-language',
        domain: 'spotify',
        action: 'play',
        slots: {},
        context: {},
        text,
      },
      spotifyWebApi,
      env: {} as Env,
    });

    expect(result.status).toBe('success');
    expect(play).toHaveBeenCalledWith('alias:salon');
    expect(getNowPlaying).not.toHaveBeenCalled();
  });
});
