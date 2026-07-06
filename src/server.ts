import Fastify, { type FastifyInstance } from 'fastify';

import { ProactiveContextCache } from './context/ProactiveContextCache';
import type { Env } from './env';
import { HomeAssistantClient } from './haClient';
import { NasStatusClient } from './nas/NasStatusClient';
import { registerApiKeyHook } from './routes/apiKeyHook';
import { registerCapabilitiesRoute } from './routes/capabilities';
import { registerContextCacheRoute } from './routes/contextCache';
import { registerDashboardRoute } from './routes/dashboard';
import { registerGoogleCalendarRoute } from './routes/googleCalendar';
import { registerHaIndexRoute } from './routes/haIndex';
import { registerHealthRoute } from './routes/health';
import { registerIngestRoute } from './routes/ingest';
import { registerNasStatusRoute } from './routes/nasStatus';
import { registerNewsSummaryRoute } from './routes/newsSummary';
import { registerOAuthRoutes } from './routes/oauth';
import { registerSecurityHooks } from './routes/securityHooks';
import { SpotifyWebApiClient } from './spotifyWebApi';

export type AppDeps = {
  env: Env;
  ha?: HomeAssistantClient;
  spotifyWebApi: SpotifyWebApiClient;
  nasStatus?: NasStatusClient;
  contextCache?: ProactiveContextCache;
};

export function buildApp(env: Env): FastifyInstance {
  const ha = env.HA_BASE_URL && env.HA_TOKEN ? new HomeAssistantClient(env) : undefined;

  const app = Fastify({
    logger: {
      level: env.LOG_LEVEL,
      redact: {
        paths: [
          'req.headers.authorization',
          'req.headers.cookie',
          'req.headers.x-api-key',
          'req.body.apiKey',
          'req.body.token',
          'req.body.access_token',
          'req.body.refresh_token',
          'req.body.ha_token',
          'req.body.spotify_webapi_client_secret',
          'req.body.spotify_webapi_refresh_token',
          'req.body.password',
        ],
        remove: true,
      },
    },
    bodyLimit: env.BODY_LIMIT_BYTES,
  });

  const spotifyWebApi = new SpotifyWebApiClient(env, app.log);
  const nasStatus = new NasStatusClient(env);
  spotifyWebApi.startSituationPrefetch();

  const contextCache = new ProactiveContextCache({ env, ha, spotifyWebApi, nasStatus, log: app.log });
  contextCache.start();
  app.addHook('onClose', async () => {
    contextCache.stop();
  });

  const deps: AppDeps = { env, ha, spotifyWebApi, nasStatus, contextCache };

  // Startup config summary (no secrets) to avoid “it’s configured but it doesn’t work”.
  const spotifyWebApiConfigured = spotifyWebApi.isConfigured();
  const spotifyWebApiAnyProvided = Boolean(
    env.SPOTIFY_WEBAPI_CLIENT_ID
    || env.SPOTIFY_WEBAPI_CLIENT_SECRET
    || env.SPOTIFY_WEBAPI_REFRESH_TOKEN
  );
  if (spotifyWebApiAnyProvided && !spotifyWebApiConfigured) {
    app.log.warn(
      {
        spotifyWebApiConfigured,
        hasClientId: Boolean(env.SPOTIFY_WEBAPI_CLIENT_ID),
        hasClientSecret: Boolean(env.SPOTIFY_WEBAPI_CLIENT_SECRET),
        hasRefreshToken: Boolean(env.SPOTIFY_WEBAPI_REFRESH_TOKEN),
      },
      'spotify web api partially configured; it will be treated as disabled (needs client id + secret + refresh token)'
    );
  }

  if (!spotifyWebApiConfigured && !env.SPOTIFY_DEFAULT_PLAY_URI) {
    app.log.info('Spotify Web API is disabled and SPOTIFY_DEFAULT_PLAY_URI is not set; “mets la musique” may need an explicit Spotify URI/link');
  }

  registerHealthRoute(app, deps);
  registerSecurityHooks(app, env);
  registerApiKeyHook(app, env);

  registerCapabilitiesRoute(app, deps);
  registerContextCacheRoute(app, deps);
  registerDashboardRoute(app, deps);
  registerGoogleCalendarRoute(app, deps);
  registerHaIndexRoute(app, deps);
  registerNewsSummaryRoute(app, deps);
  registerNasStatusRoute(app, deps);
  registerOAuthRoutes(app, deps);

  registerIngestRoute(app, deps);

  return app;
}
