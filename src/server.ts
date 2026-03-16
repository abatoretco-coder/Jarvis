import Fastify, { type FastifyInstance } from 'fastify';

import type { Env } from './env';
import { FlowAuditStore } from './flowAuditStore';
import { HomeAssistantClient } from './haClient';
import { InfluxWriter } from './influx';
import { registerApiKeyHook } from './routes/apiKeyHook';
import { registerCapabilitiesRoute } from './routes/capabilities';
import { registerFlowAuditRoute } from './routes/flowAudit';
import { registerHaIndexRoute } from './routes/haIndex';
import { registerHealthRoute } from './routes/health';
import { registerIngestRoute } from './routes/ingest';
import { SpotifyWebApiClient } from './spotifyWebApi';

export type AppDeps = {
  env: Env;
  ha?: HomeAssistantClient;
  influx: InfluxWriter;
  spotifyWebApi: SpotifyWebApiClient;
  flowAudit: FlowAuditStore;
};

export function buildApp(env: Env): FastifyInstance {
  const ha = env.HA_BASE_URL && env.HA_TOKEN ? new HomeAssistantClient(env) : undefined;
  const influx = new InfluxWriter(env);
  const spotifyWebApi = new SpotifyWebApiClient(env);
  spotifyWebApi.startSituationPrefetch();
  const flowAudit = new FlowAuditStore(env.FLOW_AUDIT_STORE_PATH, env.FLOW_AUDIT_ENABLED);

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

  const deps: AppDeps = { env, ha, influx, spotifyWebApi, flowAudit };

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
  registerApiKeyHook(app, env);

  registerCapabilitiesRoute(app, deps);
  registerFlowAuditRoute(app, deps);
  registerHaIndexRoute(app, deps);

  registerIngestRoute(app, deps);

  return app;
}
