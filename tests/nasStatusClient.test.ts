import { afterEach, describe, expect, jest, test } from '@jest/globals';

import type { Env } from '../src/env';
import { NasStatusClient } from '../src/nas/NasStatusClient';

function env(): Env {
  return {
    NAS_STATUS_URL: 'https://nas.test/status',
    NAS_STATUS_TOKEN: 'secret',
    NAS_STATUS_TIMEOUT_MS: 1_000,
    NAS_STATUS_CACHE_TTL_MS: 100,
    NAS_STATUS_CACHE_STALE_MS: 1_000,
  } as unknown as Env;
}

afterEach(() => {
  (global as { fetch?: unknown }).fetch = undefined;
  jest.restoreAllMocks();
});

describe('NasStatusClient background refresh', () => {
  test('logs a stale-cache refresh failure while still returning the cached status', async () => {
    let now = 1_000;
    jest.spyOn(Date, 'now').mockImplementation(() => now);
    const fetchMock = jest
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: 'ok' }), { status: 200 }))
      .mockRejectedValueOnce(new Error('nas_offline'));
    (global as { fetch: typeof fetch }).fetch = fetchMock;
    const warn = jest.fn();
    const client = new NasStatusClient(env(), { warn });

    await expect(client.getStatus()).resolves.toEqual({ status: 'ok' });
    now += 200;
    await expect(client.getStatus()).resolves.toEqual({ status: 'ok' });
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(warn).toHaveBeenCalledWith(
      { errorCode: 'nas_offline' },
      'NAS status background refresh failed'
    );
  });

  test('keeps foreground refresh failures observable to direct callers', async () => {
    (global as { fetch: typeof fetch }).fetch = jest.fn(async () => {
      throw new Error('nas_offline');
    }) as unknown as typeof fetch;
    const client = new NasStatusClient(env(), { warn: jest.fn() });

    await expect(client.getStatus()).rejects.toThrow('nas_offline');
  });
});
