import Fastify from 'fastify';

import type { Env } from '../src/env';
import { setRequestPrincipal } from '../src/identity/requestIdentity';
import { registerMusicRoutes } from '../src/routes/music';
import type { AppDeps } from '../src/server';
import type { SpotifyWebApiClient } from '../src/spotifyWebApi';

function buildMusicApp(overrides: Partial<SpotifyWebApiClient> = {}, clientId?: string) {
  const spotify = {
    isConfigured: () => true,
    getNowPlaying: async () => ({
      ok: true as const,
      data: {
        is_playing: true,
        progress_ms: 42_000,
        device: { id: 'tv-1', name: '[LG] webOS TV', type: 'TV', volume_percent: 18 },
        item: {
          id: 'track-1',
          name: 'Around the World',
          duration_ms: 429_000,
          artists: [{ name: 'Daft Punk' }],
          album: { name: 'Homework', images: [{ url: 'https://image.test/cover.jpg' }] },
          external_urls: { spotify: 'https://open.spotify.com/track/track-1' },
        },
      },
    }),
    listDevicesPublic: async () => ({
      ok: true as const,
      devices: [{ id: 'tv-1', name: '[LG] webOS TV', type: 'TV', isActive: true }],
    }),
    listUserPlaylistsPublic: async () => ({
      ok: true as const,
      playlists: [{ id: 'playlist-1', name: 'Salon', uri: 'spotify:playlist:abc123', trackCount: 24 }],
    }),
    scheduleSituationRefresh: () => undefined,
    ...overrides,
  } as unknown as SpotifyWebApiClient;
  const app = Fastify();
  if (clientId) {
    app.addHook('preHandler', (request, _reply, done) => {
      setRequestPrincipal(request, {
        kind: 'user', userId: 'owner-id', email: 'owner@example.test', displayName: 'Owner',
        status: 'active', roles: ['owner'], permissions: ['music'], sessionId: 'session', clientId,
      });
      done();
    });
  }
  registerMusicRoutes(app, {
    env: { SPOTIFY_WEBAPI_DEVICE_ALIAS_SALON_NAME: 'LG TV' } as Env,
    spotifyWebApi: spotify,
  } as AppDeps);
  return app;
}

describe('music routes', () => {
  test('returns normalized playback, playlists and living-room devices', async () => {
    const app = buildMusicApp();
    const response = await app.inject({ method: 'GET', url: '/v1/music' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      connected: true,
      playback: {
        isPlaying: true,
        track: { title: 'Around the World', artists: ['Daft Punk'] },
        device: { id: 'tv-1', volumePercent: 18 },
      },
      devices: [
        { id: 'zone:salon', name: 'TV · Salon', zone: 'salon', availability: 'ready', isActive: true },
        { id: 'zone:pc', name: 'PC', zone: 'pc' },
        { id: 'zone:phone', name: 'Téléphone', zone: 'phone' },
      ],
      playlists: [{ id: 'playlist-1', trackCount: 24 }],
      multiZone: { supported: false },
    });
    await app.close();
  });

  test('keeps the living-room TV target visible when Spotify Connect cannot see the TV', async () => {
    const app = buildMusicApp({
      listDevicesPublic: async () => ({ ok: true as const, devices: [] }),
    } as Partial<SpotifyWebApiClient>);
    const response = await app.inject({ method: 'GET', url: '/v1/music' });
    expect(response.statusCode).toBe(200);
    expect(response.json().devices).toContainEqual(expect.objectContaining({
      id: 'zone:salon',
      name: 'TV · Salon',
      zone: 'salon',
      isActive: false,
    }));
    expect(response.json().devices).toContainEqual(expect.objectContaining({
      id: 'zone:pc',
      name: 'PC',
      zone: 'pc',
      isActive: false,
    }));
    expect(response.json().devices).toContainEqual(expect.objectContaining({
      id: 'zone:phone',
      name: 'Téléphone',
      zone: 'phone',
      isActive: false,
    }));
    await app.close();
  });

  test('does not pretend to wake an absent phone from Desktop or Web', async () => {
    const app = buildMusicApp({
      listDevicesPublic: async () => ({ ok: true as const, devices: [] }),
    } as Partial<SpotifyWebApiClient>);
    const response = await app.inject({
      method: 'POST',
      url: '/v1/music/actions',
      payload: { action: 'transfer', deviceId: 'zone:phone' },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: 'phone_local_activation_required' });
    await app.close();
  });

  test('uses the active Connect device when the currently-playing payload omits it', async () => {
    const app = buildMusicApp({
      getNowPlaying: async () => ({
        ok: true as const,
        data: {
          is_playing: false,
          progress_ms: 7_000,
          item: {
            id: 'track-2',
            name: 'Odysseus',
            duration_ms: 180_000,
            artists: [{ name: 'Artist' }],
            album: { name: 'Album', images: [] },
          },
        },
      }),
    } as Partial<SpotifyWebApiClient>);
    const response = await app.inject({ method: 'GET', url: '/v1/music' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      playback: { device: { id: 'tv-1', name: '[LG] webOS TV', type: 'TV' } },
    });
    await app.close();
  });

  test('plays a selected playlist on the selected target', async () => {
    const playContextUri = jest.fn(async () => ({ ok: true as const, status: 204 }));
    const app = buildMusicApp({ playContextUri } as Partial<SpotifyWebApiClient>);
    const response = await app.inject({
      method: 'POST',
      url: '/v1/music/actions',
      payload: { action: 'play_playlist', playlistUri: 'spotify:playlist:abc123', deviceId: 'spotify-device-id-123' },
    });
    expect(response.statusCode).toBe(200);
    expect(playContextUri).toHaveBeenCalledWith('spotify:playlist:abc123', 'spotify-device-id-123');
    await app.close();
  });

  test('opens playlist items with artwork and artist context', async () => {
    const app = buildMusicApp({
      getPlaylistItemsPublic: async () => ({
        ok: true as const,
        total: 1,
        items: [{
          id: 'track-2', uri: 'spotify:track:track2', type: 'track', name: 'Digital Love', duration_ms: 299_000,
          artists: [{ name: 'Daft Punk', uri: 'spotify:artist:artist1' }],
          album: { name: 'Discovery', images: [{ url: 'https://image.test/discovery.jpg' }] },
          external_urls: { spotify: 'https://open.spotify.com/track/track2' },
        }],
      }),
    } as Partial<SpotifyWebApiClient>);
    const response = await app.inject({ method: 'GET', url: '/v1/music/playlists/abc123' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      total: 1,
      items: [expect.objectContaining({
        title: 'Digital Love', imageUrl: 'https://image.test/discovery.jpg',
        artistUri: 'spotify:artist:artist1', spotifyUrl: 'https://open.spotify.com/track/track2',
      })],
    });
    await app.close();
  });

  test('plays a single item, an artist mix and a shuffled playlist deterministically', async () => {
    const playUris = jest.fn(async () => ({ ok: true as const, status: 204 }));
    const playContextUri = jest.fn(async () => ({ ok: true as const, status: 204 }));
    const setShuffle = jest.fn(async () => ({ ok: true as const, status: 204 }));
    const app = buildMusicApp({ playUris, playContextUri, setShuffle } as Partial<SpotifyWebApiClient>);
    expect((await app.inject({ method: 'POST', url: '/v1/music/actions', payload: { action: 'play_item', uri: 'spotify:track:track2' } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: '/v1/music/actions', payload: { action: 'play_artist_mix', uri: 'spotify:artist:artist1' } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: '/v1/music/actions', payload: { action: 'play_playlist', playlistUri: 'spotify:playlist:abc123', state: true } })).statusCode).toBe(200);
    expect(playUris).toHaveBeenCalledWith(['spotify:track:track2'], undefined);
    expect(playContextUri).toHaveBeenCalledWith('spotify:artist:artist1', undefined);
    expect(playContextUri).toHaveBeenCalledWith('spotify:playlist:abc123', undefined);
    expect(setShuffle).toHaveBeenCalledWith(true, undefined);
    await app.close();
  });

  test('rejects an incomplete transfer without calling Spotify', async () => {
    const transferPlayback = jest.fn();
    const app = buildMusicApp({ transferPlayback } as Partial<SpotifyWebApiClient>);
    const response = await app.inject({ method: 'POST', url: '/v1/music/actions', payload: { action: 'transfer' } });
    expect(response.statusCode).toBe(400);
    expect(transferPlayback).not.toHaveBeenCalled();
    await app.close();
  });

  test('executes advanced player controls deterministically', async () => {
    const setVolume = jest.fn(async () => ({ ok: true as const, status: 204 }));
    const setShuffle = jest.fn(async () => ({ ok: true as const, status: 204 }));
    const app = buildMusicApp({ setVolume, setShuffle } as Partial<SpotifyWebApiClient>);
    expect((await app.inject({ method: 'POST', url: '/v1/music/actions', payload: { action: 'volume', volumePercent: 42 } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: '/v1/music/actions', payload: { action: 'shuffle', state: true } })).statusCode).toBe(200);
    expect(setVolume).toHaveBeenCalledWith(42, undefined);
    expect(setShuffle).toHaveBeenCalledWith(true, undefined);
    await app.close();
  });

  test('limits Stream Deck tokens to physical music controls', async () => {
    const playContextUri = jest.fn(async () => ({ ok: true as const, status: 204 }));
    const setVolume = jest.fn(async () => ({ ok: true as const, status: 204 }));
    const app = buildMusicApp({ playContextUri, setVolume } as Partial<SpotifyWebApiClient>, 'jarvis-streamdeck');
    const denied = await app.inject({
      method: 'POST', url: '/v1/music/actions',
      payload: { action: 'play_context', uri: 'spotify:album:abc123' },
    });
    const allowed = await app.inject({
      method: 'POST', url: '/v1/music/actions', payload: { action: 'volume', volumePercent: 30 },
    });
    expect(denied.statusCode).toBe(403);
    expect(denied.json()).toEqual({ error: 'client_scope_forbidden' });
    expect(playContextUri).not.toHaveBeenCalled();
    expect(allowed.statusCode).toBe(200);
    expect(setVolume).toHaveBeenCalledWith(30, undefined);
    await app.close();
  });

  test('resolves the logical phone target before an advanced player command', async () => {
    const setVolume = jest.fn(async () => ({ ok: true as const, status: 204 }));
    const app = buildMusicApp({
      listDevicesPublic: async () => ({
        ok: true as const,
        devices: [{ id: 'phone-connect-id', name: 'Galaxy S22+', type: 'Smartphone', isActive: true }],
      }),
      setVolume,
    } as Partial<SpotifyWebApiClient>);
    const response = await app.inject({
      method: 'POST',
      url: '/v1/music/actions',
      payload: { action: 'volume', volumePercent: 37, deviceId: 'zone:phone' },
    });
    expect(response.statusCode).toBe(200);
    expect(setVolume).toHaveBeenCalledWith(37, 'phone-connect-id');
    await app.close();
  });

  test('plays an album or artist search result as a Spotify context', async () => {
    const playContextUri = jest.fn(async () => ({ ok: true as const, status: 204 }));
    const app = buildMusicApp({ playContextUri } as Partial<SpotifyWebApiClient>);
    const response = await app.inject({
      method: 'POST',
      url: '/v1/music/actions',
      payload: { action: 'play_context', uri: 'spotify:album:abc123', deviceId: 'spotify-device-id-123' },
    });
    expect(response.statusCode).toBe(200);
    expect(playContextUri).toHaveBeenCalledWith('spotify:album:abc123', 'spotify-device-id-123');
    await app.close();
  });

  test('returns queue, history, search and generic library state', async () => {
    const track = { id: 'track-1', uri: 'spotify:track:track1', type: 'track', name: 'Voyage', artists: [{ name: 'Artiste' }], duration_ms: 180_000 };
    const app = buildMusicApp({
      getQueuePublic: async () => ({ ok: true as const, data: { currently_playing: track, queue: [track] } }),
      getRecentlyPlayedPublic: async () => ({ ok: true as const, items: [{ played_at: '2026-10-09T20:00:00Z', track }] }),
      searchCatalog: async () => ({ ok: true as const, items: [{ id: 'track-1', uri: 'spotify:track:track1', name: 'Voyage', type: 'track' }] }),
      libraryContainsUri: async () => ({ ok: true as const, saved: true }),
    } as Partial<SpotifyWebApiClient>);
    expect((await app.inject({ method: 'GET', url: '/v1/music/queue' })).json()).toMatchObject({ queue: [{ title: 'Voyage' }] });
    expect((await app.inject({ method: 'GET', url: '/v1/music/history' })).json()).toMatchObject({ items: [{ track: { title: 'Voyage' } }] });
    expect((await app.inject({ method: 'GET', url: '/v1/music/search?q=Voyage&type=track' })).json()).toMatchObject({ items: [{ name: 'Voyage' }] });
    expect((await app.inject({ method: 'GET', url: '/v1/music/library/contains?uri=spotify%3Atrack%3Atrack1' })).json()).toEqual({ saved: true });
    await app.close();
  });
});
