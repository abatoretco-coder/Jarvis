import { afterEach, describe, expect, jest, test } from '@jest/globals';

jest.mock('../src/google/googleCredentialService', () => ({
  resolveGoogleCredentials: jest.fn(async (env: { GOOGLE_REFRESH_TOKEN?: string }) => ({
    clientId: 'client-id',
    clientSecret: 'client-secret',
    refreshToken: env.GOOGLE_REFRESH_TOKEN ?? 'refresh-token',
  })),
}));

import { refreshCalendarToken } from '../src/calendar/googleCalendarClient';

const envFor = (refreshToken: string) => ({
  GOOGLE_CLIENT_ID: 'client-id',
  GOOGLE_CLIENT_SECRET: 'client-secret',
  GOOGLE_REFRESH_TOKEN: refreshToken,
});

describe('Google Calendar token refresh', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('retries one transient OAuth failure', async () => {
    const fetchMock = jest.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('{"error":"internal_failure"}', { status: 503 }))
      .mockResolvedValueOnce(new Response('{"access_token":"access-token","expires_in":3600}', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }));

    await expect(refreshCalendarToken(envFor('transient-refresh-token'))).resolves.toBe('access-token');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test('does not retry a permanent OAuth failure', async () => {
    const fetchMock = jest.spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('{"error":"invalid_grant"}', { status: 400 }));

    await expect(refreshCalendarToken(envFor('invalid-refresh-token')))
      .rejects.toThrow('calendar_token_refresh_failed:400');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
