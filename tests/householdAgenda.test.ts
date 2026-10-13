import { afterEach, describe, expect, it, jest } from '@jest/globals';

import type { DailyLifeRepository } from '../src/dailyLife/DailyLifeRepository';
import { HouseholdAgendaService } from '../src/dailyLife/HouseholdAgendaService';
import type { Env } from '../src/env';
import type { IntegrationService } from '../src/integrations/IntegrationService';

const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
  jest.restoreAllMocks();
});

describe('household agenda aggregation', () => {
  it('deduplicates shared events and applies the strictest privacy level', async () => {
    const dailyLife = {
      calendarMembers: () => ({
        householdId: 'home',
        members: [
          { userId: 'alex', displayName: 'Alex', connected: true, sharing: true, isCurrentUser: true },
          { userId: 'chloe', displayName: 'Chloé', connected: true, sharing: true, isCurrentUser: false },
        ],
      }),
    } as unknown as DailyLifeRepository;
    const integrations = {
      resolveSharedHouseholdRefreshTokens: () => [
        { userId: 'alex', displayName: 'Alex', refreshToken: 'refresh-alex' },
        { userId: 'chloe', displayName: 'Chloé', refreshToken: 'refresh-chloe' },
      ],
    } as unknown as IntegrationService;

    global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('oauth2.googleapis.com/token')) {
        const refreshToken = new URLSearchParams(String(init?.body)).get('refresh_token');
        return new Response(JSON.stringify({ access_token: `access-${refreshToken}`, expires_in: 3600 }), {
          status: 200, headers: { 'content-type': 'application/json' },
        });
      }
      if (url.includes('/users/me/calendarList')) {
        return new Response(JSON.stringify({ items: [{ id: 'primary', primary: true, accessRole: 'owner' }] }), {
          status: 200, headers: { 'content-type': 'application/json' },
        });
      }
      const token = new Headers(init?.headers).get('authorization');
      const privateCopy = token?.includes('refresh-chloe');
      return new Response(JSON.stringify({ items: [{
        id: privateCopy ? 'chloe-copy' : 'alex-copy',
        iCalUID: 'shared-meeting@example.test',
        summary: 'Dîner surprise',
        location: 'Restaurant secret',
        visibility: privateCopy ? 'private' : 'default',
        start: { dateTime: '2026-10-15T18:00:00.000Z' },
        end: { dateTime: '2026-10-15T20:00:00.000Z' },
      }] }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;

    const service = new HouseholdAgendaService(dailyLife, integrations, {
      GOOGLE_CLIENT_ID: 'client', GOOGLE_CLIENT_SECRET: 'secret',
    } as Env);
    const snapshot = await service.snapshot(
      'alex', '2026-10-13T00:00:00.000Z', '2026-10-20T00:00:00.000Z',
    );

    expect(snapshot.status).toBe('ok');
    expect(snapshot.events).toHaveLength(1);
    expect(snapshot.events[0]).toMatchObject({ title: 'Occupé', location: null });
    expect(snapshot.events[0]?.owners.map((owner) => owner.displayName)).toEqual(['Alex', 'Chloé']);
  });
});
