import Fastify from 'fastify';

import { createConversationDb } from '../src/conversation/repositories/SqliteRepositories';
import type { Env } from '../src/env';
import { HomeTelemetryRepository } from '../src/home/HomeTelemetryRepository';
import { setRequestPrincipal } from '../src/identity/requestIdentity';
import { registerHomeTelemetryRoutes } from '../src/routes/homeTelemetry';
import type { AppDeps } from '../src/server';

describe('home telemetry routes', () => {
  test('enforces home permission and never accepts a client-selected household', async () => {
    const db = createConversationDb(':memory:');
    const repository = new HomeTelemetryRepository(db);
    repository.ingest([{
      entity: {
        homeId: 'home-a',
        entityId: 'light.room',
        deviceId: 'light-a',
        roomId: 'room-a',
        domain: 'light',
        role: 'primary',
      },
      observedAtMs: 1_000,
      state: 'on',
      source: 'home_assistant_history',
      capturedAtMs: 2_000,
    }, {
      entity: {
        homeId: 'home-b',
        entityId: 'light.room',
        deviceId: 'light-b',
        roomId: 'room-b',
        domain: 'light',
        role: 'primary',
      },
      observedAtMs: 1_000,
      state: 'off',
      source: 'home_assistant_history',
      capturedAtMs: 2_000,
    }]);
    const app = Fastify();
    app.addHook('onRequest', async (request) => {
      const allowed = request.headers['x-test-home'] === '1';
      setRequestPrincipal(request, {
        kind: 'service',
        serviceId: allowed ? 'allowed' : 'denied',
        permissions: allowed ? ['home'] : ['chat'],
      });
    });
    registerHomeTelemetryRoutes(app, {
      env: { ACTIVE_HOME_ID: 'home-a' } as Env,
      homeTelemetry: repository,
    } as AppDeps);

    const denied = await app.inject({ method: 'GET', url: '/v1/home/telemetry/entities' });
    expect(denied.statusCode).toBe(403);

    const entities = await app.inject({
      method: 'GET',
      url: '/v1/home/telemetry/entities',
      headers: { 'x-test-home': '1' },
    });
    expect(entities.statusCode).toBe(200);
    expect(entities.json().entities).toEqual([
      expect.objectContaining({ homeId: 'home-a', deviceId: 'light-a' }),
    ]);

    const history = await app.inject({
      method: 'GET',
      url: '/v1/home/telemetry/history?entityId=light.room&from=1970-01-01T00:00:00.000Z&to=1970-01-01T00:00:02.000Z',
      headers: { 'x-test-home': '1' },
    });
    expect(history.statusCode).toBe(200);
    expect(history.json().points).toEqual([expect.objectContaining({ state: 'on' })]);
    await app.close();
    db.close();
  });
});
