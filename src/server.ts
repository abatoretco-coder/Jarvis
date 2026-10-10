import Fastify, { type FastifyInstance } from 'fastify';

import { AdminControlPlaneRepository } from './admin/AdminControlPlaneRepository';
import { ProactiveContextCache } from './context/ProactiveContextCache';
import { createConversationDb } from './conversation/repositories/SqliteRepositories';
import type { Env } from './env';
import { HomeAssistantClient } from './haClient';
import type { HomeCatalog } from './home/HomeCatalog';
import { IdentityRepository } from './identity/IdentityRepository';
import { IdentityService } from './identity/IdentityService';
import { OidcTokenVerifier } from './identity/OidcTokenVerifier';
import { IntegrationRepository } from './integrations/IntegrationRepository';
import { IntegrationService } from './integrations/IntegrationService';
import { NasStatusClient } from './nas/NasStatusClient';
import { configureOpenAiResilience, shutdownOpenAiResilience } from './openai/resilience';
import { PcAgentCommandBroker } from './pc/PcAgentCommandBroker';
import { registerAdminRoutes } from './routes/admin';
import { registerApiKeyHook } from './routes/apiKeyHook';
import { registerCapabilitiesRoute } from './routes/capabilities';
import { registerContextCacheRoute } from './routes/contextCache';
import { registerCultureProfileRoutes } from './routes/cultureProfile';
import { registerDashboardRoute } from './routes/dashboard';
import { registerGoogleCalendarRoute } from './routes/googleCalendar';
import { registerHaIndexRoute } from './routes/haIndex';
import { registerHealthRoute } from './routes/health';
import { registerHomeRoutes } from './routes/home';
import { registerIdentityRoutes } from './routes/identity';
import { registerIngestRoute } from './routes/ingest';
import { registerIntegrationRoutes } from './routes/integrations';
import { registerMusicRoutes } from './routes/music';
import { registerMutationIdempotencyHooks } from './routes/mutationIdempotency';
import { registerNasStatusRoute } from './routes/nasStatus';
import { registerNewsSummaryRoute } from './routes/newsSummary';
import { registerPcAgentRoutes } from './routes/pcAgent';
import { registerPrincipalRateLimitHook, registerSecurityHooks } from './routes/securityHooks';
import { parseTrustedProxyCidrs } from './security/edgePolicy';
import { SpotifyClientResolver } from './spotify/SpotifyClientResolver';
import { SpotifyWebApiClient } from './spotifyWebApi';

export type AppDeps = {
  env: Env;
  ha?: HomeAssistantClient;
  spotifyWebApi: SpotifyWebApiClient;
  spotifyClients?: SpotifyClientResolver;
  nasStatus?: NasStatusClient;
  contextCache?: ProactiveContextCache;
  integrations?: IntegrationService;
  adminAudit?: AdminControlPlaneRepository;
  homeCatalog?: HomeCatalog;
  pcAgentBroker?: PcAgentCommandBroker;
};

export function buildApp(env: Env): FastifyInstance {
  configureOpenAiResilience(env);
  const ha = env.HA_BASE_URL && env.HA_TOKEN ? new HomeAssistantClient(env) : undefined;
  const trustedProxies = parseTrustedProxyCidrs(env.TRUSTED_PROXY_CIDRS);

  const app = Fastify({
    trustProxy: trustedProxies.length ? trustedProxies : false,
    logger: {
      level: env.LOG_LEVEL,
      serializers: {
        req(request) {
          return {
            method: request.method,
            url: request.url?.split('?')[0],
            hostname: request.hostname,
            remoteAddress: request.ip,
          };
        },
      },
      redact: {
        paths: [
          'req.headers.authorization',
          'req.headers.cookie',
          'req.headers.x-api-key',
          'req.headers.x-jarvis-edge-secret',
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

  const contextCache = new ProactiveContextCache({
    env,
    ha,
    spotifyWebApi,
    nasStatus,
    log: app.log,
  });
  contextCache.start();
  app.addHook('onClose', async () => {
    contextCache.stop();
    shutdownOpenAiResilience();
  });

  const deps: AppDeps = { env, ha, spotifyWebApi, nasStatus, contextCache, pcAgentBroker: new PcAgentCommandBroker() };
  const identityDb = env.OIDC_ENABLED ? createConversationDb(env.CONVERSATION_DB_PATH) : undefined;
  const issuer = env.OIDC_ISSUER_URL?.replace(/\/$/u, '');
  const identityService =
    identityDb && issuer && env.OIDC_AUDIENCE
      ? new IdentityService(
          new IdentityRepository(identityDb),
          new OidcTokenVerifier({
            issuer,
            audience: env.OIDC_AUDIENCE,
            jwksUrl: env.OIDC_JWKS_URL ?? `${issuer}/protocol/openid-connect/certs`,
            algorithms: env.OIDC_ALLOWED_ALGORITHMS.split(',')
              .map((item) => item.trim())
              .filter(Boolean),
            clockToleranceSeconds: env.OIDC_CLOCK_TOLERANCE_SECONDS,
            maxTokenBytes: env.OIDC_MAX_TOKEN_BYTES,
          }),
          env.OIDC_BOOTSTRAP_OWNER_SUBJECT
        )
      : undefined;
  const adminRepository = identityDb ? new AdminControlPlaneRepository(identityDb) : undefined;
  deps.adminAudit = adminRepository;
  const integrations = identityDb
    ? new IntegrationService(new IntegrationRepository(identityDb), env)
    : undefined;
  deps.integrations = integrations;
  deps.spotifyClients = new SpotifyClientResolver(env, spotifyWebApi, integrations, app.log);
  if (identityDb) app.addHook('onClose', async () => identityDb.close());

  // Startup config summary (no secrets) to avoid “it’s configured but it doesn’t work”.
  const spotifyWebApiConfigured = spotifyWebApi.isConfigured();
  const spotifyWebApiAnyProvided = Boolean(
    env.SPOTIFY_WEBAPI_CLIENT_ID ||
    env.SPOTIFY_WEBAPI_CLIENT_SECRET ||
    env.SPOTIFY_WEBAPI_REFRESH_TOKEN
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
    app.log.info(
      'Spotify Web API is disabled and SPOTIFY_DEFAULT_PLAY_URI is not set; “mets la musique” may need an explicit Spotify URI/link'
    );
  }

  registerSecurityHooks(app, env);
  registerApiKeyHook(app, env, identityService, adminRepository);
  registerPrincipalRateLimitHook(app, env);
  registerMutationIdempotencyHooks(app);

  // Hooks must be registered before routes so every route receives the same
  // edge, authentication and rate-limit policy.
  registerHealthRoute(app, deps);
  registerHomeRoutes(app, deps);

  if (identityService && adminRepository) {
    registerIdentityRoutes(app, identityService, adminRepository);
    registerAdminRoutes(app, deps, adminRepository);
    if (integrations) registerIntegrationRoutes(app, integrations);
  }

  registerCapabilitiesRoute(app, deps);
  registerContextCacheRoute(app, deps);
  registerCultureProfileRoutes(app, deps);
  registerDashboardRoute(app, deps);
  registerGoogleCalendarRoute(app, deps);
  registerHaIndexRoute(app, deps);
  registerNewsSummaryRoute(app, deps);
  registerPcAgentRoutes(app, deps);
  registerMusicRoutes(app, deps);
  registerNasStatusRoute(app, deps);
  registerIngestRoute(app, deps);

  return app;
}
