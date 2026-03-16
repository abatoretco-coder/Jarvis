import { afterEach, describe, expect, test } from '@jest/globals';

import type { Env } from '../src/env';
import { SpotifyWebApiClient } from '../src/spotifyWebApi';

function makeEnv(overrides?: Partial<Env>): Env {
  return {
    SPOTIFY_WEBAPI_CLIENT_ID: 'cid',
    SPOTIFY_WEBAPI_CLIENT_SECRET: 'csecret',
    SPOTIFY_WEBAPI_REFRESH_TOKEN: 'refresh-token',
    SPOTIFY_WEBAPI_DEVICE_ID: undefined,
    SPOTIFY_WEBAPI_DEVICE_NAME: 'jarvis vm400',
    SPOTIFY_WEBAPI_DEVICE_ALIAS_PHONE_NAME: 'Galaxy S22',
    SPOTIFY_WEBAPI_DEVICE_ALIAS_COMPUTER_NAME: 'Jarvis Desktop',
    SPOTIFY_WEBAPI_DEVICE_ALIAS_SALON_NAME: 'Living Room Speaker',
    SPOTIFY_WEBAPI_DEVICE_DISCOVERY_RETRIES: 0,
    SPOTIFY_WEBAPI_DEVICE_DISCOVERY_DELAY_MS: 10,
    SPOTIFY_WEBAPI_SHUFFLE_PLAYLISTS: true,
    SPOTIFY_WEBAPI_BASE_URL: 'https://api.spotify.local',
    SPOTIFY_WEBAPI_ACCOUNTS_URL: 'https://accounts.spotify.local',
    SPOTIFY_WEBAPI_TIMEOUT_MS: 2000,
    SPOTIFY_WEBAPI_REQUEST_RETRIES: 0,
    SPOTIFY_WEBAPI_REQUEST_RETRY_DELAY_MS: 50,
    SPOTIFY_WEBAPI_REQUEST_RETRY_MAX_DELAY_MS: 100,
    SPOTIFY_WEBAPI_ACTION_RETRIES: 0,
    SPOTIFY_WEBAPI_ACTION_RETRY_DELAY_MS: 50,
    SPOTIFY_WEBAPI_REFRESH_BLACKOUT_START: '00:00',
    SPOTIFY_WEBAPI_REFRESH_BLACKOUT_END: '00:20',
    SPOTIFY_WEBAPI_PRE_REFRESH_WINDOW_MS: 1800000,
    ...(overrides ?? {}),
  } as unknown as Env;
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function noContent(status = 204): Response {
  return new Response('', { status });
}

function parseMockUrl(input: string | URL | Request): URL {
  if (typeof input === 'string') return new URL(input);
  if (input instanceof URL) return input;
  return new URL(input.url);
}

afterEach(() => {
  (global as { fetch?: unknown }).fetch = undefined;
});

describe('spotify web api client integration mocks', () => {
  test('searchTopTrackUri falls back from strict query to relaxed query and returns best uri', async () => {
    const env = makeEnv();
    const capturedQueries: string[] = [];

    (global as { fetch: typeof fetch }).fetch = (async (input: string | URL, init?: RequestInit) => {
      const url = parseMockUrl(input as string | URL | Request);

      if (url.hostname === 'accounts.spotify.local' && url.pathname === '/api/token') {
        return jsonResponse({ access_token: 'access-1', token_type: 'Bearer', expires_in: 3600 });
      }

      if (url.hostname === 'api.spotify.local' && url.pathname === '/v1/search') {
        const q = url.searchParams.get('q') ?? '';
        capturedQueries.push(q);

        if (q.includes('track:n95 artist:kendrick lamar')) {
          return jsonResponse({ tracks: { items: [] } });
        }

        return jsonResponse({
          tracks: {
            items: [
              {
                uri: 'spotify:track:found-relaxed',
                name: 'N95',
                popularity: 85,
                artists: [{ name: 'Kendrick Lamar' }],
              },
            ],
          },
        });
      }

      return jsonResponse({ error: 'unexpected_call', url: url.toString(), method: init?.method ?? 'GET' }, 500);
    }) as unknown as typeof fetch;

    const client = new SpotifyWebApiClient(env);
    const result = await client.searchTopTrackUri('n95', 'kendrick lamar');

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.uri).toBe('spotify:track:found-relaxed');
    }

    expect(capturedQueries.length).toBeGreaterThanOrEqual(2);
    expect(capturedQueries[0]).toContain('track:n95 artist:kendrick lamar');
  });

  test('searchUserPlaylistContextUri falls back to catalog search when user playlists do not match', async () => {
    const env = makeEnv();

    (global as { fetch: typeof fetch }).fetch = (async (input: string | URL) => {
      const url = parseMockUrl(input as string | URL | Request);

      if (url.hostname === 'accounts.spotify.local' && url.pathname === '/api/token') {
        return jsonResponse({ access_token: 'access-2', token_type: 'Bearer', expires_in: 3600 });
      }

      if (url.hostname === 'api.spotify.local' && url.pathname === '/v1/me/playlists') {
        return jsonResponse({
          items: [
            { id: 'pl-1', name: 'Road Trip', uri: 'spotify:playlist:roadtrip' },
            { id: 'pl-2', name: 'Workout 2024', uri: 'spotify:playlist:workout' },
          ],
          next: null,
        });
      }

      if (url.hostname === 'api.spotify.local' && url.pathname === '/v1/search' && url.searchParams.get('type') === 'playlist') {
        return jsonResponse({
          playlists: {
            items: [
              { name: 'Focus Flow', uri: 'spotify:playlist:focus-flow' },
            ],
          },
        });
      }

      return jsonResponse({ error: 'unexpected_call', url: url.toString() }, 500);
    }) as unknown as typeof fetch;

    const client = new SpotifyWebApiClient(env);
    const result = await client.searchUserPlaylistContextUri('focus flow');

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.uri).toBe('spotify:playlist:focus-flow');
      expect(result.name).toBe('Focus Flow');
    }
  });

  test('transferPlayback resolves alias phone using fuzzy device name matching', async () => {
    const env = makeEnv({ SPOTIFY_WEBAPI_DEVICE_ALIAS_PHONE_NAME: 'Galaxy S22' });
    const client = new SpotifyWebApiClient(env);
    const transferBodies: Array<{ device_ids?: string[]; play?: boolean }> = [];
    const requestCalls: string[] = [];
    let isDeviceActive = false;

    (client as unknown as { request: (method: string, path: string, opts?: { query?: Record<string, string | undefined>; json?: unknown }) => Promise<unknown> }).request = async (method, path, opts) => {
      requestCalls.push(`${method.toUpperCase()} ${path}`);

      if (path === '/v1/me/player/devices') {
        return {
          ok: true,
          status: 200,
          data: {
            devices: [
              { id: 'dev-phone', name: 'Samsung Galaxy S22 Ultra', type: 'Smartphone', is_active: isDeviceActive },
            ],
          },
        };
      }

      if (path === '/v1/me/player' && method.toUpperCase() === 'PUT') {
        transferBodies.push((opts?.json ?? {}) as { device_ids?: string[]; play?: boolean });
        isDeviceActive = true;
        return { ok: true, status: 204 };
      }

      return { ok: false, error: 'unexpected_call', details: { method, path } };
    };

    const result = await client.transferPlayback('alias:phone', false);

    if (!result.ok) {
      throw new Error(`transferPlayback failed: ${JSON.stringify(result)} | calls=${JSON.stringify(requestCalls)}`);
    }
    expect(transferBodies).toHaveLength(1);
    expect(transferBodies[0].device_ids?.[0]).toBe('dev-phone');
    expect(transferBodies[0].play).toBe(false);
  });

  test('play resolves preferred device name fuzzily and targets discovered device id', async () => {
    const env = makeEnv({ SPOTIFY_WEBAPI_DEVICE_NAME: 'jarvis vm400' });
    const playCalls: string[] = [];

    const client = new SpotifyWebApiClient(env);
    const requestCalls: string[] = [];
    let isDeviceActive = false;

    (client as unknown as { request: (method: string, path: string, opts?: { query?: Record<string, string | undefined>; json?: unknown }) => Promise<unknown> }).request = async (method, path, opts) => {
      requestCalls.push(`${method.toUpperCase()} ${path}`);

      if (path === '/v1/me/player/devices') {
        return {
          ok: true,
          status: 200,
          data: {
            devices: [
              { id: 'dev-computer', name: 'Jarvis-VM400', type: 'Computer', is_active: isDeviceActive },
            ],
          },
        };
      }

      if (path === '/v1/me/player' && method.toUpperCase() === 'PUT') {
        isDeviceActive = true;
        return { ok: true, status: 204 };
      }

      if (path === '/v1/me/player/play' && method.toUpperCase() === 'PUT') {
        playCalls.push(opts?.query?.device_id ?? '');
        return { ok: true, status: 204 };
      }

      return { ok: false, error: 'unexpected_call', details: { method, path } };
    };

    const result = await client.play();

    if (!result.ok) {
      throw new Error(`play failed: ${JSON.stringify(result)} | calls=${JSON.stringify(requestCalls)}`);
    }
    expect(playCalls).toContain('dev-computer');
  });
});
