import Fastify from 'fastify';

import { type ServicePrincipal,setRequestPrincipal } from '../src/identity/requestIdentity';
import { PcAgentCommandBroker } from '../src/pc/PcAgentCommandBroker';
import { registerPcAgentRoutes } from '../src/routes/pcAgent';
import type { AppDeps } from '../src/server';

function buildApp(principal: ServicePrincipal) {
  const app = Fastify();
  const broker = new PcAgentCommandBroker();
  app.addHook('preHandler', async (request) => setRequestPrincipal(request, principal));
  registerPcAgentRoutes(app, { pcAgentBroker: broker } as AppDeps);
  return { app, broker };
}

describe('PC agent routes', () => {
  test('accepts status only from the dedicated PC agent identity', async () => {
    const { app } = buildApp({ kind: 'service', serviceId: 'pc-agent', permissions: ['music'] });
    const response = await app.inject({ method: 'POST', url: '/v1/pc-agent/poll', payload: { spotifyRunning: false } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ command: null });
    await app.close();
  });

  test('rejects another music-scoped service', async () => {
    const { app } = buildApp({ kind: 'service', serviceId: 'other-agent', permissions: ['music'] });
    const response = await app.inject({ method: 'POST', url: '/v1/pc-agent/poll', payload: { spotifyRunning: false } });
    expect(response.statusCode).toBe(403);
    await app.close();
  });
});

