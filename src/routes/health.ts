import type { FastifyInstance } from 'fastify';

import type { AppDeps } from '../server';

export function registerHealthRoute(app: FastifyInstance, deps?: AppDeps): void {
  app.get('/health', async () => {
    const timestamp = new Date().toISOString();
    
    // Basic health
    const basic = { status: 'ok', timestamp };
    
    // If no deps, return basic health only
    if (!deps) return basic;

    // Detailed health check
    const spotifyWebApiConfigured = deps.spotifyWebApi.isConfigured();
    
    const dependencies: Record<string, unknown> = {
      planner: {
        status: 'ok',
        mode: 'semantic_router',
      },
      homeassistant: deps.ha
        ? { status: 'configured' }
        : { status: 'not_configured' },
      spotifyWebApi: spotifyWebApiConfigured
        ? { status: 'configured', hasToken: true }
        : { status: 'not_configured' },
    };

    return {
      status: 'ok',
      timestamp,
      dependencies,
    };
  });
}
