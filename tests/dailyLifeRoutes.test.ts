import { describe, expect, jest, test } from '@jest/globals';
import Fastify from 'fastify';

import { createConversationDb } from '../src/conversation/repositories/SqliteRepositories';
import { DailyLifeRepository } from '../src/dailyLife/DailyLifeRepository';
import type { HouseholdAgendaService } from '../src/dailyLife/HouseholdAgendaService';
import { setRequestPrincipal } from '../src/identity/requestIdentity';
import { registerDailyLifeRoutes } from '../src/routes/dailyLife';

describe('daily life routes', () => {
  test('exposes one shared contract to owner and resident', async () => {
    const db = createConversationDb(':memory:');
    db.prepare(`INSERT INTO users(user_id,email_normalized,display_name,status,created_at_ms,updated_at_ms)
      VALUES ('owner','owner@example.test','Owner','active',1,1),('chloe','chloe@example.test','Chloé','active',1,1)`).run();
    db.prepare(`INSERT INTO households(household_id,name,created_by_user_id,created_at_ms,updated_at_ms)
      VALUES ('home','Maison','owner',1,1)`).run();
    db.prepare(`INSERT INTO household_memberships(household_id,user_id,role_key,status,created_at_ms,updated_at_ms)
      VALUES ('home','owner','owner','active',1,1),('home','chloe','resident','active',1,1)`).run();
    const app = Fastify();
    let userId = 'owner';
    app.addHook('preHandler', async (request) => setRequestPrincipal(request, {
      kind: 'user', userId, email: `${userId}@example.test`, displayName: userId,
      status: 'active', roles: userId === 'owner' ? ['owner'] : ['resident'],
      permissions: ['todo'], sessionId: `session:${userId}`,
    }));
    const agenda = { snapshot: jest.fn(async (_userId: string, timeMin: string, timeMax: string) => ({
      householdId: 'home', timeMin, timeMax, status: 'ok', members: [], events: [],
    })) } as unknown as HouseholdAgendaService;
    registerDailyLifeRoutes(app, new DailyLifeRepository(db), agenda);

    const initial = await app.inject({ method: 'GET', url: '/v1/daily-life' });
    expect(initial.statusCode).toBe(200);
    const shopping = initial.json().lists.find((list: { kind: string }) => list.kind === 'shopping');
    const created = await app.inject({
      method: 'POST', url: `/v1/daily-life/lists/${shopping.listId}/items`,
      payload: { title: 'Lait', quantity: '2' },
    });
    expect(created.statusCode).toBe(201);

    userId = 'chloe';
    const shared = await app.inject({ method: 'GET', url: '/v1/daily-life' });
    expect(shared.json().lists.flatMap((list: { items: unknown[] }) => list.items))
      .toEqual(expect.arrayContaining([expect.objectContaining({ title: 'Lait', quantity: '2' })]));
    const agendaResponse = await app.inject({ method: 'GET',
      url: '/v1/daily-life/agenda?timeMin=2026-10-13T00%3A00%3A00.000Z&timeMax=2026-10-20T00%3A00%3A00.000Z' });
    expect(agendaResponse.statusCode).toBe(200);
    expect(agenda.snapshot).toHaveBeenCalledWith('chloe', '2026-10-13T00:00:00.000Z', '2026-10-20T00:00:00.000Z');
    await app.close();
    db.close();
  });

  test('rejects malformed mutations without writing data', async () => {
    const db = createConversationDb(':memory:');
    const app = Fastify();
    app.addHook('preHandler', async (request) => setRequestPrincipal(request, {
      kind: 'user', userId: 'missing', email: 'missing@example.test', displayName: 'Missing',
      status: 'active', roles: ['resident'], permissions: ['todo'], sessionId: 'session',
    }));
    registerDailyLifeRoutes(app, new DailyLifeRepository(db));
    const response = await app.inject({ method: 'POST', url: '/v1/daily-life/lists', payload: { kind: 'shopping', name: '' } });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: 'daily_life_request_invalid' });
    await app.close();
    db.close();
  });
});
