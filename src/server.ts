import Fastify, { type FastifyInstance } from 'fastify';

import { AdminControlPlaneRepository } from './admin/AdminControlPlaneRepository';
import { stopGoogleCalendarTokenKeepalives } from './calendar/googleCalendarClient';
import { ProactiveContextCache } from './context/ProactiveContextCache';
import { createConversationDb } from './conversation/repositories/SqliteRepositories';
import { DailyLifeRepository } from './dailyLife/DailyLifeRepository';
import { HouseholdAgendaService } from './dailyLife/HouseholdAgendaService';
import type { Env } from './env';
import { HomeAssistantClient } from './haClient';
import { HealthDiagnostics } from './health/healthDiagnostics';
import type { HomeAdaptiveLightingService } from './home/HomeAdaptiveLightingService';
import type { HomeCatalog } from './home/HomeCatalog';
import { HomeRuntimeStateRepository } from './home/HomeRuntimeStateRepository';
import { HomeTelemetryCollector } from './home/HomeTelemetryCollector';
import { HomeTelemetryRepository } from './home/HomeTelemetryRepository';
import { MutationIdempotencyCoordinator } from './idempotency/MutationIdempotencyCoordinator';
import { SqliteMutationIdempotencyStore } from './idempotency/SqliteMutationIdempotencyStore';
import { IdentityRepository } from './identity/IdentityRepository';
import { IdentityService } from './identity/IdentityService';
import { OidcTokenVerifier } from './identity/OidcTokenVerifier';
import { IntegrationRepository } from './integrations/IntegrationRepository';
import { IntegrationService } from './integrations/IntegrationService';
import { stopMailTokenKeepalives } from './mail/mailAgent';
import { NasStatusClient } from './nas/NasStatusClient';
import { configureOpenAiResilience, shutdownOpenAiResilience } from './openai/resilience';
import { PcAgentCommandBroker } from './pc/PcAgentCommandBroker';
import { registerAdminRoutes } from './routes/admin';
import { registerApiKeyHook } from './routes/apiKeyHook';
import { registerCapabilitiesRoute } from './routes/capabilities';
import { registerContextCacheRoute } from './routes/contextCache';
import { registerCultureProfileRoutes } from './routes/cultureProfile';
import { registerDailyLifeRoutes } from './routes/dailyLife';
import { registerDashboardRoute } from './routes/dashboard';
import { registerGoogleCalendarRoute } from './routes/googleCalendar';
import { registerHaIndexRoute } from './routes/haIndex';
import { registerHealthRoute } from './routes/health';
import { registerHomeRoutes } from './routes/home';
import { registerHomeTelemetryRoutes } from './routes/homeTelemetry';
import { registerIdentityRoutes } from './routes/identity';
import { registerIngestRoute } from './routes/ingest';
import { registerIntegrationRoutes } from './routes/integrations';
import { registerLiveIngestValidationHook, registerLiveVoiceRoutes } from './routes/liveVoice';
import { registerMusicRoutes } from './routes/music';
import { registerMutationIdempotencyHooks } from './routes/mutationIdempotency';
import { registerNasStatusRoute } from './routes/nasStatus';
import { registerNewsSummaryRoute } from './routes/newsSummary';
import { registerPcAgentRoutes } from './routes/pcAgent';
import { registerPrincipalRateLimitHook, registerSecurityHooks } from './routes/securityHooks';
import { parseTrustedProxyCidrs } from './security/edgePolicy';
import { SpotifyClientResolver } from './spotify/SpotifyClientResolver';
import { SpotifyWebApiClient } from './spotifyWebApi';
import { stopTodoTokenKeepalives } from './todo/todoAgent';
import { createLiveVoiceRuntime, type LiveVoiceRuntime } from './voice/live/runtime';

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
  homeLightingService?: HomeAdaptiveLightingService;
  homeRuntimeState?: HomeRuntimeStateRepository;
  homeTelemetry?: HomeTelemetryRepository;
  pcAgentBroker?: PcAgentCommandBroker;
  identityRepository?: IdentityRepository;
  liveVoice?: LiveVoiceRuntime;
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
  const nasStatus = env.NAS_STATUS_ENABLED ? new NasStatusClient(env, app.log) : undefined;
  spotifyWebApi.startSituationPrefetch();

  const contextCache = new ProactiveContextCache({
    env,
    ha,
    spotifyWebApi,
    nasStatus,
    log: app.log,
  });
  contextCache.start();

  const deps: AppDeps = { env, ha, spotifyWebApi, nasStatus, contextCache, pcAgentBroker: new PcAgentCommandBroker() };
  const runtimeDb = createConversationDb(env.CONVERSATION_DB_PATH);
  const liveVoice = createLiveVoiceRuntime({ env, db: runtimeDb, log: app.log });
  deps.liveVoice = liveVoice;
  deps.homeRuntimeState = new HomeRuntimeStateRepository(runtimeDb);
  deps.homeTelemetry = new HomeTelemetryRepository(runtimeDb);
  const identityDb = env.OIDC_ENABLED ? runtimeDb : undefined;
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
  deps.identityRepository = identityService?.repository;
  const adminRepository = identityDb ? new AdminControlPlaneRepository(identityDb) : undefined;
  const dailyLifeRepository = identityDb ? new DailyLifeRepository(identityDb) : undefined;
  const processDailyLifeRecurrences = () => {
    if (!dailyLifeRepository) return;
    try {
      const activated = dailyLifeRepository.processDueRecurrences();
      if (activated > 0) app.log.info({ activated }, 'daily life recurrences activated');
    } catch (error) {
      app.log.warn(
        { errorCode: error instanceof Error ? error.message : 'daily_life_recurrence_failed' },
        'daily life recurrence processing failed'
      );
    }
  };
  const dailyLifeTimer = dailyLifeRepository
    ? setInterval(processDailyLifeRecurrences, 60_000)
    : undefined;
  dailyLifeTimer?.unref();
  processDailyLifeRecurrences();
  deps.adminAudit = adminRepository;
  const integrations = identityDb
    ? new IntegrationService(new IntegrationRepository(identityDb), env)
    : undefined;
  deps.integrations = integrations;
  deps.spotifyClients = new SpotifyClientResolver(env, spotifyWebApi, integrations, app.log);
  app.addHook('onClose', async () => {
    if (dailyLifeTimer) clearInterval(dailyLifeTimer);
    await contextCache.stop();
    spotifyWebApi.stopSituationPrefetch();
    await Promise.allSettled([
      stopGoogleCalendarTokenKeepalives(),
      stopMailTokenKeepalives(),
      stopTodoTokenKeepalives(),
    ]);
    shutdownOpenAiResilience();
  });

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
  registerLiveIngestValidationHook(app, liveVoice);
  registerMutationIdempotencyHooks(
    app,
    new MutationIdempotencyCoordinator({
      store: new SqliteMutationIdempotencyStore(runtimeDb),
    })
  );

  // Hooks must be registered before routes so every route receives the same
  // edge, authentication and rate-limit policy.
  const healthDiagnostics = new HealthDiagnostics(deps);
  registerHealthRoute(app, deps, {}, healthDiagnostics);
  registerHomeRoutes(app, deps);
  registerHomeTelemetryRoutes(app, deps);

  const homeTelemetryCollector =
    env.HOME_TELEMETRY_ENABLED && ha && deps.homeCatalog && deps.homeTelemetry
      ? new HomeTelemetryCollector(
          ha,
          deps.homeCatalog,
          deps.homeTelemetry,
          {
            homeId: env.ACTIVE_HOME_ID,
            intervalMs: env.HOME_TELEMETRY_SYNC_INTERVAL_MS,
            initialLookbackMs: env.HOME_TELEMETRY_INITIAL_LOOKBACK_HOURS * 3_600_000,
            maximumCatchupMs: env.HOME_TELEMETRY_MAX_CATCHUP_DAYS * 86_400_000,
            retentionMs: env.HOME_TELEMETRY_RETENTION_DAYS * 86_400_000,
          },
          app.log
        )
      : undefined;
  homeTelemetryCollector?.start();
  app.addHook('onClose', async () => {
    await homeTelemetryCollector?.stop();
    liveVoice.tts.stop();
    await liveVoice.sessions.stop();
    runtimeDb.close();
  });

  if (identityService && adminRepository) {
    registerIdentityRoutes(app, identityService, adminRepository);
    registerAdminRoutes(app, deps, adminRepository, healthDiagnostics);
    if (integrations) registerIntegrationRoutes(app, integrations);
    if (dailyLifeRepository) registerDailyLifeRoutes(
      app,
      dailyLifeRepository,
      integrations ? new HouseholdAgendaService(dailyLifeRepository, integrations, env) : undefined,
    );
  }

  registerCapabilitiesRoute(app, deps);
  registerLiveVoiceRoutes(app, liveVoice, runtimeDb);
  registerContextCacheRoute(app, deps);
  if (env.CULTURE_ENABLED) registerCultureProfileRoutes(app, deps);
  registerDashboardRoute(app, deps);
  registerGoogleCalendarRoute(app, deps);
  registerHaIndexRoute(app, deps);
  registerNewsSummaryRoute(app, deps);
  registerPcAgentRoutes(app, deps);
  registerMusicRoutes(app, deps);
  if (env.NAS_STATUS_ENABLED) registerNasStatusRoute(app, deps);
  registerIngestRoute(app, deps);

  liveVoice.sessions.start();
  if (env.OPENAI_LIVE_ENABLED && env.OPENAI_API_KEY && env.OIDC_ENABLED) {
    void liveVoice.sessions.recoverOrphans().catch((error: unknown) => {
      app.log.warn(
        { errorCode: error instanceof Error ? error.message : 'live_orphan_recovery_failed' },
        'live orphan recovery failed'
      );
    });
  }

  return app;
}
