import { afterEach, describe, expect, jest, test } from '@jest/globals';

import type { Env } from '../src/env';
import { type NasStatus, NasStatusClient } from '../src/nas/NasStatusClient';

function env(overrides: Partial<Env> = {}): Env {
  return {
    NAS_STATUS_URL: 'https://nas.test/status',
    NAS_STATUS_TOKEN: 'secret',
    NAS_STATUS_TIMEOUT_MS: 1_000,
    NAS_STATUS_CACHE_TTL_MS: 100,
    NAS_STATUS_CACHE_STALE_MS: 1_000,
    ...overrides,
  } as unknown as Env;
}

function snapshot(overrides: Partial<NasStatus> = {}): NasStatus {
  return {
    hostname: 'nas-test',
    generatedAt: new Date(Date.now()).toISOString(),
    uptimeSeconds: 86_400,
    load: { one: 0.1, five: 0.2, fifteen: 0.3 },
    memory: { totalBytes: 16 * 1024 ** 3, availableBytes: 8 * 1024 ** 3, usedPercent: 50 },
    swap: { totalBytes: 2 * 1024 ** 3, freeBytes: 2 * 1024 ** 3, usedPercent: 0 },
    filesystems: [
      { mount: '/', totalBytes: 100 * 1024 ** 3, availableBytes: 40 * 1024 ** 3, usedPercent: 60 },
    ],
    temperatures: [{ label: 'CPU', celsius: 48 }],
    protocols: [{ name: 'plex', available: true, port: 32_400 }],
    ...overrides,
  };
}

function jsonResponse(value: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });
}

afterEach(() => {
  (global as { fetch?: unknown }).fetch = undefined;
  jest.restoreAllMocks();
});

describe('NasStatusClient validation', () => {
  test('accepts a valid snapshot and an empty filesystem collection', async () => {
    const clearTimeoutSpy = jest.spyOn(global, 'clearTimeout');
    (global as { fetch: typeof fetch }).fetch = jest.fn(async () =>
      jsonResponse(snapshot({ filesystems: [] }))
    ) as typeof fetch;
    const client = new NasStatusClient(env());

    await expect(client.getStatus()).resolves.toMatchObject({
      hostname: 'nas-test',
      filesystems: [],
      freshness: { state: 'fresh' },
    });
    expect(clearTimeoutSpy).toHaveBeenCalled();
  });

  test.each([
    ['negative uptime', { uptimeSeconds: -1 }],
    ['negative load', { load: { one: -1, five: 0, fifteen: 0 } }],
    ['percentage above 100', { memory: { totalBytes: 100, availableBytes: 10, usedPercent: 101 } }],
    [
      'available memory above total',
      { memory: { totalBytes: 100, availableBytes: 101, usedPercent: 0 } },
    ],
    ['free swap above total', { swap: { totalBytes: 100, freeBytes: 101, usedPercent: 0 } }],
    [
      'filesystem availability above total',
      { filesystems: [{ mount: '/', totalBytes: 100, availableBytes: 101, usedPercent: 0 }] },
    ],
    ['impossible temperature', { temperatures: [{ label: 'CPU', celsius: 500 }] }],
    ['invalid protocol port', { protocols: [{ name: 'plex', available: true, port: 70_000 }] }],
    ['invalid date', { generatedAt: 'not-a-date' }],
    ['impossible calendar date', { generatedAt: '2026-02-30T08:00:00Z' }],
    ['oversized hostname', { hostname: 'n'.repeat(256) }],
    [
      'oversized collection',
      {
        protocols: Array.from({ length: 257 }, (_, index) => ({
          name: `p${index}`,
          available: true,
        })),
      },
    ],
    ['non-finite load', { load: { one: Number.POSITIVE_INFINITY, five: 0, fifteen: 0 } }],
  ])('rejects a malformed snapshot: %s', async (_label, overrides) => {
    (global as { fetch: typeof fetch }).fetch = jest.fn(async () =>
      jsonResponse(snapshot(overrides as Partial<NasStatus>))
    ) as typeof fetch;

    await expect(new NasStatusClient(env()).getStatus()).rejects.toThrow(
      'nas_status_invalid_payload'
    );
  });

  test('rejects a memory percentage inconsistent with the byte counters', async () => {
    (global as { fetch: typeof fetch }).fetch = jest.fn(async () =>
      jsonResponse(
        snapshot({
          memory: { totalBytes: 100, availableBytes: 50, usedPercent: 12 },
        })
      )
    ) as typeof fetch;

    await expect(new NasStatusClient(env()).getStatus()).rejects.toThrow(
      'nas_status_invalid_payload'
    );
  });

  test('rejects invalid JSON and a logical error returned with HTTP 200', async () => {
    const fetchMock = jest
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('{broken', { status: 200 }))
      .mockResolvedValueOnce(jsonResponse({ status: 'error', reason: 'collector_failed' }));
    (global as { fetch: typeof fetch }).fetch = fetchMock;
    const client = new NasStatusClient(
      env({ NAS_STATUS_CACHE_TTL_MS: 0, NAS_STATUS_CACHE_STALE_MS: 0 })
    );

    await expect(client.getStatus()).rejects.toThrow('nas_status_invalid_json');
    await expect(client.getStatus()).rejects.toThrow('nas_status_invalid_payload');
  });

  test('rejects an oversized response before parsing it', async () => {
    (global as { fetch: typeof fetch }).fetch = jest.fn(
      async () => new Response('x'.repeat(1_048_577), { status: 200 })
    ) as typeof fetch;

    await expect(new NasStatusClient(env()).getStatus()).rejects.toThrow(
      'nas_status_response_too_large'
    );
  });

  test('marks an old collector measurement stale and rejects it past the stale window', async () => {
    const now = Date.parse('2026-10-15T08:00:00Z');
    jest.spyOn(Date, 'now').mockReturnValue(now);
    const fetchMock = jest
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse(snapshot({ generatedAt: new Date(now - 200).toISOString() }))
      )
      .mockResolvedValueOnce(
        jsonResponse(snapshot({ generatedAt: new Date(now - 5_001).toISOString() }))
      );
    (global as { fetch: typeof fetch }).fetch = fetchMock;

    await expect(new NasStatusClient(env()).getStatus()).resolves.toMatchObject({
      freshness: { state: 'stale' },
    });
    await expect(new NasStatusClient(env()).getStatus()).rejects.toThrow(
      'nas_status_snapshot_too_old'
    );
  });

  test('accepts a just-generated second-precision snapshot when caching is disabled', async () => {
    const now = Date.parse('2026-10-15T08:00:00.999Z');
    jest.spyOn(Date, 'now').mockReturnValue(now);
    (global as { fetch: typeof fetch }).fetch = jest.fn(async () =>
      jsonResponse(snapshot({ generatedAt: '2026-10-15T08:00:00Z' }))
    ) as typeof fetch;

    await expect(
      new NasStatusClient(
        env({ NAS_STATUS_CACHE_TTL_MS: 0, NAS_STATUS_CACHE_STALE_MS: 0 })
      ).getStatus()
    ).resolves.toMatchObject({ hostname: 'nas-test' });
  });
});

describe('NasStatusClient network failures', () => {
  test.each([401, 403, 429, 500, 503])(
    'surfaces HTTP %s with a stable error code',
    async (status) => {
      (global as { fetch: typeof fetch }).fetch = jest.fn(
        async () => new Response('provider details', { status })
      ) as typeof fetch;

      await expect(new NasStatusClient(env()).getStatus()).rejects.toThrow(
        `nas_status_http_${status}`
      );
    }
  );

  test('classifies connection, DNS and interrupted-body failures without retrying', async () => {
    const fetchMock = jest
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new TypeError('ECONNREFUSED nas.test'))
      .mockRejectedValueOnce(new TypeError('ENOTFOUND nas.test'))
      .mockResolvedValueOnce(
        new Response(
          new ReadableStream({
            pull(controller) {
              controller.error(new Error('socket closed'));
            },
          }),
          { status: 200 }
        )
      );
    (global as { fetch: typeof fetch }).fetch = fetchMock;
    const client = new NasStatusClient(env());

    await expect(client.getStatus()).rejects.toThrow('nas_status_network_error');
    await expect(client.getStatus()).rejects.toThrow('nas_status_network_error');
    await expect(client.getStatus()).rejects.toThrow('nas_status_body_read_failed');
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  test('aborts a request at the configured timeout', async () => {
    (global as { fetch: typeof fetch }).fetch = jest.fn(
      (_url: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            'abort',
            () => reject(new DOMException('aborted', 'AbortError')),
            { once: true }
          );
        })
    ) as typeof fetch;

    await expect(
      new NasStatusClient(env({ NAS_STATUS_TIMEOUT_MS: 5 })).getStatus()
    ).rejects.toThrow('nas_status_timeout');
  });
});

describe('NasStatusClient cache', () => {
  test('shares one retrieval between simultaneous callers', async () => {
    let resolveFetch!: (response: Response) => void;
    const fetchMock = jest.fn<typeof fetch>(
      () =>
        new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        })
    );
    (global as { fetch: typeof fetch }).fetch = fetchMock;
    const client = new NasStatusClient(env());

    const first = client.getStatus();
    const second = client.getStatus();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    resolveFetch(jsonResponse(snapshot()));

    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test('returns a fresh cache without a network request', async () => {
    let now = 1_000;
    jest.spyOn(Date, 'now').mockImplementation(() => now);
    const fetchMock = jest.fn<typeof fetch>(async () => jsonResponse(snapshot()));
    (global as { fetch: typeof fetch }).fetch = fetchMock;
    const client = new NasStatusClient(env());

    await expect(client.getStatus()).resolves.toMatchObject({ freshness: { state: 'fresh' } });
    now += 50;
    await expect(client.getStatus()).resolves.toMatchObject({ freshness: { state: 'fresh' } });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test('marks a stale cache and contains a failed background refresh', async () => {
    let now = 1_000;
    jest.spyOn(Date, 'now').mockImplementation(() => now);
    const fetchMock = jest
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(snapshot()))
      .mockRejectedValueOnce(new Error('token=must-not-leak'));
    (global as { fetch: typeof fetch }).fetch = fetchMock;
    const warn = jest.fn();
    const client = new NasStatusClient(env(), { warn });

    await client.getStatus();
    now += 200;
    await expect(client.getStatus()).resolves.toMatchObject({ freshness: { state: 'stale' } });
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(warn).toHaveBeenCalledWith(
      { errorCode: 'nas_status_network_error' },
      'NAS status background refresh failed'
    );
  });

  test('coalesces simultaneous stale refreshes and logs one failure', async () => {
    let now = 1_000;
    jest.spyOn(Date, 'now').mockImplementation(() => now);
    const fetchMock = jest
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(snapshot()))
      .mockRejectedValueOnce(new Error('offline'));
    (global as { fetch: typeof fetch }).fetch = fetchMock;
    const warn = jest.fn();
    const client = new NasStatusClient(env(), { warn });

    await client.getStatus();
    now += 200;
    await Promise.all([client.getStatus(), client.getStatus(), client.getStatus()]);
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  test('does not replace a valid cache with an invalid refresh', async () => {
    let now = 1_000;
    jest.spyOn(Date, 'now').mockImplementation(() => now);
    const fetchMock = jest
      .fn<typeof fetch>()
      .mockImplementationOnce(async () => jsonResponse(snapshot({ hostname: 'valid-cache' })))
      .mockResolvedValueOnce(jsonResponse({ status: 'error' }))
      .mockImplementationOnce(async () => jsonResponse(snapshot({ hostname: 'recovered' })));
    (global as { fetch: typeof fetch }).fetch = fetchMock;
    const client = new NasStatusClient(env(), { warn: jest.fn() });

    await client.getStatus();
    now += 200;
    await expect(client.getStatus()).resolves.toMatchObject({
      hostname: 'valid-cache',
      freshness: { state: 'stale' },
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    now += 1_000;
    await expect(client.getStatus()).resolves.toMatchObject({
      hostname: 'recovered',
      freshness: { state: 'fresh' },
    });
  });

  test('does not return an over-stale snapshot during a prolonged outage', async () => {
    let now = 1_000;
    jest.spyOn(Date, 'now').mockImplementation(() => now);
    const fetchMock = jest
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(snapshot()))
      .mockRejectedValueOnce(new Error('offline'));
    (global as { fetch: typeof fetch }).fetch = fetchMock;
    const client = new NasStatusClient(env());

    await client.getStatus();
    now += 1_001;
    await expect(client.getStatus()).rejects.toThrow('nas_status_network_error');
  });

  test('recovers normally after an unavailable collector', async () => {
    const fetchMock = jest
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new Error('offline'))
      .mockImplementationOnce(async () => jsonResponse(snapshot({ hostname: 'recovered' })));
    (global as { fetch: typeof fetch }).fetch = fetchMock;
    const client = new NasStatusClient(env());

    await expect(client.getStatus()).rejects.toThrow('nas_status_network_error');
    await expect(client.getStatus()).resolves.toMatchObject({
      hostname: 'recovered',
      freshness: { state: 'fresh' },
    });
  });

  test('keeps TTL semantics safe when stale duration is shorter than TTL', async () => {
    let now = 1_000;
    jest.spyOn(Date, 'now').mockImplementation(() => now);
    const fetchMock = jest
      .fn<typeof fetch>()
      .mockImplementationOnce(async () => jsonResponse(snapshot({ hostname: 'first' })))
      .mockImplementationOnce(async () => jsonResponse(snapshot({ hostname: 'second' })));
    (global as { fetch: typeof fetch }).fetch = fetchMock;
    const client = new NasStatusClient(
      env({ NAS_STATUS_CACHE_TTL_MS: 100, NAS_STATUS_CACHE_STALE_MS: 50 })
    );

    await client.getStatus();
    now += 75;
    await expect(client.getStatus()).resolves.toMatchObject({
      hostname: 'first',
      freshness: { state: 'fresh' },
    });
    now += 26;
    await expect(client.getStatus()).resolves.toMatchObject({
      hostname: 'second',
      freshness: { state: 'fresh' },
    });
  });
});
