import { afterEach, describe, expect, jest, test } from '@jest/globals';

import { AgoraClient } from '../src/culture/AgoraClient';

const client = () => new AgoraClient({ baseUrl: 'http://agora:8092', token: 'secret-token', timeoutMs: 20 });

afterEach(() => {
  jest.restoreAllMocks();
});

describe('AgoraClient', () => {
  test.each([
    [401, 'unauthorized'],
    [503, 'unavailable'],
    [400, 'http_error'],
    [429, 'http_error'],
  ] as const)('translates HTTP %s without exposing the response body', async (status, code) => {
    jest.spyOn(global, 'fetch').mockResolvedValue(new Response('provider secret details', { status }));
    await expect(client().discover({})).rejects.toMatchObject({ code, status });
  });

  test('rejects an invalid Agora payload', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue(new Response(JSON.stringify({ data: [{ unsafe: true }] }), { status: 200 }));
    await expect(client().discover({})).rejects.toMatchObject({ code: 'invalid_response' });
  });

  test('rejects malformed JSON and translates a network failure without leaking details', async () => {
    const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValueOnce(new Response('{', { status: 200 }));
    await expect(client().discover({})).rejects.toMatchObject({ code: 'invalid_response', status: 200 });
    fetchMock.mockRejectedValueOnce(new Error('private upstream details'));
    await expect(client().discover({})).rejects.toMatchObject({ code: 'unavailable', message: 'agora_unavailable' });
  });

  test('rejects unsafe item and venue ids before any request', async () => {
    const fetchMock = jest.spyOn(global, 'fetch');
    await expect(client().getItem('../private')).rejects.toMatchObject({ code: 'invalid_response' });
    await expect(client().getVenue('../private')).rejects.toMatchObject({ code: 'invalid_response' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('aborts a request after the configured timeout', async () => {
    jest.spyOn(global, 'fetch').mockImplementation((_url, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
    }));
    await expect(client().discover({})).rejects.toMatchObject({ code: 'timeout' });
  });

  test('sends the bearer token only as an authorization header', async () => {
    const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      data: [],
      meta: {
        generatedAt: '2026-08-27T09:00:00.000Z', stale: false, partial: false, nextCursor: null, providers: [],
      },
    }), { status: 200 }));
    await client().discover({ q: 'Dune' });
    const [calledUrl, init] = fetchMock.mock.calls[0] ?? [];
    expect(String(calledUrl)).not.toContain('secret-token');
    expect((init?.headers as Record<string, string>).authorization).toBe('Bearer secret-token');
    expect(new URL(String(calledUrl)).searchParams.get('q')).toBe('Dune');
  });
});
