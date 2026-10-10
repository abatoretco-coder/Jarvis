import { describe, expect, jest, test } from '@jest/globals';

import type { Env } from '../src/env';
import { executeSpotifyCapability } from '../src/spotify/spotifyExecutor';
import type { SpotifyWebApiClient } from '../src/spotifyWebApi';

describe('spotify executor strict fallbacks', () => {
  test('does not search the public catalogue when personal playlists are required', async () => {
    const searchCatalog = jest.fn(async () => ({ ok: true, items: [] }));
    const client = {
      isConfigured: () => true,
      searchUserPlaylistContextUri: async () => ({ ok: false, error: 'spotify_user_playlist_not_found' }),
      searchCatalog,
      scheduleSituationRefresh: jest.fn(),
    } as unknown as SpotifyWebApiClient;

    const result = await executeSpotifyCapability({
      request: {
        threadId: 'thread-strict-playlist',
        domain: 'spotify',
        action: 'search_and_play',
        slots: { type: 'playlist', query: 'Focus Flow' },
        context: {},
        text: 'Lance ma playlist Focus Flow',
      },
      spotifyWebApi: client,
      env: { SPOTIFY_WEBAPI_USER_PLAYLISTS_ONLY: true } as Env,
    });

    expect(result).toMatchObject({
      status: 'error',
      error_code: 'spotify_user_playlist_not_found',
    });
    expect(searchCatalog).not.toHaveBeenCalled();
  });
});
