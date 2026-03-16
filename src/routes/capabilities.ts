import type { FastifyInstance } from 'fastify';

import { getVm400Capabilities } from '../capabilities';
import type { AppDeps } from '../server';

export function registerCapabilitiesRoute(app: FastifyInstance, deps: AppDeps): void {
  app.get('/v1/capabilities', async () => {
    const caps = getVm400Capabilities({
      haConfigured: Boolean(deps.ha),
      spotifyWebApiConfigured: deps.spotifyWebApi.isConfigured(),
      influxEnabled: deps.influx.isEnabled(),
      requireApiKey: deps.env.REQUIRE_API_KEY,
    });

    return {
      status: 'ok',
      timestamp: new Date().toISOString(),
      ...caps,
    };
  });
}

