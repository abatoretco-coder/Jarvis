import { verifyConversationDatabase } from '../conversation/conversationDbBackup';
import type { AppDeps } from '../server';

export const HEALTH_CONTRACT_VERSION = '1.0';

export type HealthStatus = 'healthy' | 'degraded' | 'unavailable' | 'not_configured';
export type DiagnosticFreshness = 'fresh' | 'stale' | 'unknown';
export type RecoveryAction = 'none' | 'retry' | 'configure' | 'reauthorize';

export type DependencyDiagnostic = {
  status: HealthStatus;
  required: boolean;
  configured: boolean;
  observedAt: string | null;
  cached: boolean;
  lastCheckedAt: string | null;
  lastSuccessAt: string | null;
  freshness: DiagnosticFreshness;
  recoveryAction: RecoveryAction;
  requiresUserIntervention: boolean;
  reason?:
    | 'availability_not_checked'
    | 'authorization_failed'
    | 'configuration_missing'
    | 'disabled'
    | 'integrity_check_failed'
    | 'stale_data'
    | 'unreachable';
  schemaVersion?: number;
};

export type HealthDiagnosticsSnapshot = {
  status: Exclude<HealthStatus, 'not_configured'>;
  liveness: { status: 'healthy' };
  readiness: { status: 'healthy' | 'unavailable' };
  dependencies: {
    conversationDatabase: DependencyDiagnostic;
    homeAssistant: DependencyDiagnostic;
    spotifyWebApi: DependencyDiagnostic;
    homeTelemetry: DependencyDiagnostic;
  };
};

type DatabaseProbe =
  | { status: 'healthy'; schemaVersion: number }
  | { status: 'unavailable'; reason: 'integrity_check_failed' };

type HomeAssistantProbe =
  | { status: 'healthy'; legacyStatus: 'ok' }
  | {
      status: 'unavailable';
      legacyStatus: 'unauthorized' | 'unreachable';
      reason: 'authorization_failed' | 'unreachable';
    };

type CachedProbe<T> = {
  value: T;
  observedAtMs: number;
  cached: boolean;
  lastSuccessAtMs?: number;
};

class TimedProbeCache<T> {
  private entry?: { value: T; observedAtMs: number };
  private refreshPromise?: Promise<{ value: T; observedAtMs: number }>;
  private lastSuccessAtMs?: number;

  constructor(
    private readonly loader: () => Promise<T>,
    private readonly ttlMs: number,
    private readonly now: () => number,
    private readonly shouldCache: (value: T) => boolean = () => true,
    private readonly isSuccessful: (value: T) => boolean = () => true
  ) {}

  async get(): Promise<CachedProbe<T>> {
    const nowMs = this.now();
    if (this.entry && nowMs - this.entry.observedAtMs <= this.ttlMs) {
      return { ...this.entry, cached: true, lastSuccessAtMs: this.lastSuccessAtMs };
    }

    const refreshed = await this.refresh();
    return { ...refreshed, cached: false, lastSuccessAtMs: this.lastSuccessAtMs };
  }

  private refresh(): Promise<{ value: T; observedAtMs: number }> {
    if (this.refreshPromise) return this.refreshPromise;

    this.refreshPromise = this.loader()
      .then((value) => {
        const result = { value, observedAtMs: this.now() };
        if (this.isSuccessful(value)) this.lastSuccessAtMs = result.observedAtMs;
        this.entry = this.shouldCache(value) ? result : undefined;
        return result;
      })
      .finally(() => {
        this.refreshPromise = undefined;
      });
    return this.refreshPromise;
  }
}

export type HealthDiagnosticsOptions = {
  now?: () => number;
  databaseCacheTtlMs?: number;
  homeAssistantCacheTtlMs?: number;
  homeAssistantTimeoutMs?: number;
  verifyDatabase?: typeof verifyConversationDatabase;
};

const DEFAULT_DATABASE_CACHE_TTL_MS = 5_000;
const DEFAULT_HOME_ASSISTANT_CACHE_TTL_MS = 15_000;
const DEFAULT_INTEGRATION_FRESHNESS_MS = 24 * 60 * 60 * 1_000;
const DEFAULT_HOME_ASSISTANT_TIMEOUT_MS = 750;

function isoTimestamp(timestampMs: number): string {
  return new Date(timestampMs).toISOString();
}

function timestamp(timestampMs: number | undefined): string | null {
  return timestampMs === undefined ? null : isoTimestamp(timestampMs);
}

function diagnosticMetadata(input: {
  checkedAtMs?: number;
  successAtMs?: number;
  freshness: DiagnosticFreshness;
  recoveryAction: RecoveryAction;
  requiresUserIntervention?: boolean;
}): Pick<
  DependencyDiagnostic,
  'lastCheckedAt' | 'lastSuccessAt' | 'freshness' | 'recoveryAction' | 'requiresUserIntervention'
> {
  return {
    lastCheckedAt: timestamp(input.checkedAtMs),
    lastSuccessAt: timestamp(input.successAtMs),
    freshness: input.freshness,
    recoveryAction: input.recoveryAction,
    requiresUserIntervention: input.requiresUserIntervention ?? false,
  };
}

export function integrationConnectionDiagnostic(input: {
  status: unknown;
  lastSyncAtMs: unknown;
  lastErrorCode: unknown;
  updatedAtMs: unknown;
  nowMs?: number;
}): DependencyDiagnostic {
  const status = typeof input.status === 'string' ? input.status : 'error';
  const lastSyncAtMs = typeof input.lastSyncAtMs === 'number' ? input.lastSyncAtMs : undefined;
  const updatedAtMs = typeof input.updatedAtMs === 'number' ? input.updatedAtMs : undefined;
  const errorCode = typeof input.lastErrorCode === 'string' ? input.lastErrorCode : undefined;
  const stale =
    lastSyncAtMs !== undefined &&
    (input.nowMs ?? Date.now()) - lastSyncAtMs > DEFAULT_INTEGRATION_FRESHNESS_MS;
  if (status === 'revoked') {
    return {
      status: 'not_configured',
      required: false,
      configured: false,
      observedAt: timestamp(updatedAtMs),
      cached: true,
      reason: 'configuration_missing',
      ...diagnosticMetadata({
        checkedAtMs: updatedAtMs,
        successAtMs: lastSyncAtMs,
        freshness: 'unknown',
        recoveryAction: 'configure',
        requiresUserIntervention: true,
      }),
    };
  }
  if (status === 'pending') {
    return {
      status: 'degraded',
      required: false,
      configured: false,
      observedAt: timestamp(updatedAtMs),
      cached: true,
      reason: 'availability_not_checked',
      ...diagnosticMetadata({
        checkedAtMs: updatedAtMs,
        successAtMs: lastSyncAtMs,
        freshness: 'unknown',
        recoveryAction: 'reauthorize',
        requiresUserIntervention: true,
      }),
    };
  }
  if (status === 'error') {
    return {
      status: 'unavailable',
      required: false,
      configured: true,
      observedAt: timestamp(updatedAtMs),
      cached: true,
      reason:
        errorCode === 'integration_authorization_invalidated'
          ? 'authorization_failed'
          : 'unreachable',
      ...diagnosticMetadata({
        checkedAtMs: updatedAtMs,
        successAtMs: lastSyncAtMs,
        freshness: lastSyncAtMs ? 'stale' : 'unknown',
        recoveryAction: 'reauthorize',
        requiresUserIntervention: true,
      }),
    };
  }
  if (errorCode) {
    return {
      status: 'degraded',
      required: false,
      configured: true,
      observedAt: timestamp(updatedAtMs),
      cached: true,
      reason: 'unreachable',
      ...diagnosticMetadata({
        checkedAtMs: updatedAtMs,
        successAtMs: lastSyncAtMs,
        freshness: lastSyncAtMs ? 'stale' : 'unknown',
        recoveryAction: 'retry',
      }),
    };
  }
  return {
    status: lastSyncAtMs && !stale ? 'healthy' : 'degraded',
    required: false,
    configured: true,
    observedAt: timestamp(updatedAtMs),
    cached: true,
    ...(stale
      ? { reason: 'stale_data' as const }
      : lastSyncAtMs
        ? {}
        : { reason: 'availability_not_checked' as const }),
    ...diagnosticMetadata({
      checkedAtMs: updatedAtMs,
      successAtMs: lastSyncAtMs,
      freshness: lastSyncAtMs === undefined ? 'unknown' : stale ? 'stale' : 'fresh',
      recoveryAction: lastSyncAtMs && !stale ? 'none' : 'retry',
    }),
  };
}

async function withDeadline<T>(promise: Promise<T>, timeoutMs: number, fallback: T): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((resolve) => {
        timeout = setTimeout(() => resolve(fallback), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export class HealthDiagnostics {
  private readonly now: () => number;
  private readonly homeAssistantTimeoutMs: number;
  private readonly databaseProbe: TimedProbeCache<DatabaseProbe>;
  private readonly homeAssistantProbe?: TimedProbeCache<HomeAssistantProbe>;

  constructor(
    private readonly deps: AppDeps,
    options: HealthDiagnosticsOptions = {}
  ) {
    this.now = options.now ?? Date.now;
    this.homeAssistantTimeoutMs =
      options.homeAssistantTimeoutMs ?? DEFAULT_HOME_ASSISTANT_TIMEOUT_MS;
    const verifyDatabase = options.verifyDatabase ?? verifyConversationDatabase;

    this.databaseProbe = new TimedProbeCache<DatabaseProbe>(
      async () => {
        try {
          const verification = verifyDatabase(this.deps.env.CONVERSATION_DB_PATH);
          return { status: 'healthy', schemaVersion: verification.schemaVersion };
        } catch {
          return { status: 'unavailable', reason: 'integrity_check_failed' };
        }
      },
      options.databaseCacheTtlMs ?? DEFAULT_DATABASE_CACHE_TTL_MS,
      this.now,
      (value) => value.status === 'healthy',
      (value) => value.status === 'healthy'
    );

    if (deps.ha) {
      this.homeAssistantProbe = new TimedProbeCache<HomeAssistantProbe>(
        async () => {
          const result = await withDeadline(
            deps.ha!.probeHealth(this.homeAssistantTimeoutMs),
            this.homeAssistantTimeoutMs,
            'unreachable' as const
          ).catch(() => 'unreachable' as const);
          if (result === 'ok') return { status: 'healthy', legacyStatus: 'ok' };
          if (result === 'unauthorized') {
            return {
              status: 'unavailable',
              legacyStatus: 'unauthorized',
              reason: 'authorization_failed',
            };
          }
          return { status: 'unavailable', legacyStatus: 'unreachable', reason: 'unreachable' };
        },
        options.homeAssistantCacheTtlMs ?? DEFAULT_HOME_ASSISTANT_CACHE_TTL_MS,
        this.now,
        () => true,
        (value) => value.status === 'healthy'
      );
    }
  }

  async getReadiness(): Promise<DependencyDiagnostic> {
    const probe = await this.databaseProbe.get();
    return probe.value.status === 'healthy'
      ? {
          status: 'healthy',
          required: true,
          configured: true,
          observedAt: isoTimestamp(probe.observedAtMs),
          cached: probe.cached,
          ...diagnosticMetadata({
            checkedAtMs: probe.observedAtMs,
            successAtMs: probe.lastSuccessAtMs,
            freshness: 'fresh',
            recoveryAction: 'none',
          }),
          schemaVersion: probe.value.schemaVersion,
        }
      : {
          status: 'unavailable',
          required: true,
          configured: true,
          observedAt: isoTimestamp(probe.observedAtMs),
          cached: probe.cached,
          reason: probe.value.reason,
          ...diagnosticMetadata({
            checkedAtMs: probe.observedAtMs,
            successAtMs: probe.lastSuccessAtMs,
            freshness: 'unknown',
            recoveryAction: 'retry',
          }),
        };
  }

  async getHomeAssistant(): Promise<{
    diagnostic: DependencyDiagnostic;
    legacyStatus: 'ok' | 'unauthorized' | 'unreachable' | 'not_configured';
  }> {
    if (!this.homeAssistantProbe) {
      return {
        diagnostic: {
          status: 'not_configured',
          required: false,
          configured: false,
          observedAt: null,
          cached: false,
          reason: 'configuration_missing',
          ...diagnosticMetadata({
            freshness: 'unknown',
            recoveryAction: 'configure',
            requiresUserIntervention: true,
          }),
        },
        legacyStatus: 'not_configured',
      };
    }

    const probe = await this.homeAssistantProbe.get();
    const authorizationFailed =
      probe.value.status === 'unavailable' && probe.value.reason === 'authorization_failed';
    return {
      diagnostic: {
        status: probe.value.status,
        required: false,
        configured: true,
        observedAt: isoTimestamp(probe.observedAtMs),
        cached: probe.cached,
        ...diagnosticMetadata({
          checkedAtMs: probe.observedAtMs,
          successAtMs: probe.lastSuccessAtMs,
          freshness:
            probe.value.status === 'healthy'
              ? 'fresh'
              : probe.lastSuccessAtMs
                ? 'stale'
                : 'unknown',
          recoveryAction: authorizationFailed
            ? 'reauthorize'
            : probe.value.status === 'healthy'
              ? 'none'
              : 'retry',
          requiresUserIntervention: authorizationFailed,
        }),
        ...(probe.value.status === 'unavailable' ? { reason: probe.value.reason } : {}),
      },
      legacyStatus: probe.value.legacyStatus,
    };
  }

  getSpotify(): DependencyDiagnostic {
    if (!this.deps.spotifyWebApi.isConfigured()) {
      return {
        status: 'not_configured',
        required: false,
        configured: false,
        observedAt: null,
        cached: false,
        reason: 'configuration_missing',
        ...diagnosticMetadata({
          freshness: 'unknown',
          recoveryAction: 'configure',
          requiresUserIntervention: true,
        }),
      };
    }
    return {
      status: 'degraded',
      required: false,
      configured: true,
      observedAt: null,
      cached: false,
      reason: 'availability_not_checked',
      ...diagnosticMetadata({ freshness: 'unknown', recoveryAction: 'retry' }),
    };
  }

  getHomeTelemetry(): DependencyDiagnostic {
    if (!this.deps.env.HOME_TELEMETRY_ENABLED || !this.deps.homeTelemetry) {
      const disabled = !this.deps.env.HOME_TELEMETRY_ENABLED;
      return {
        status: 'not_configured',
        required: false,
        configured: false,
        observedAt: null,
        cached: true,
        reason: disabled ? 'disabled' : 'configuration_missing',
        ...diagnosticMetadata({
          freshness: 'unknown',
          recoveryAction: disabled ? 'none' : 'configure',
        }),
      };
    }
    let sync: ReturnType<NonNullable<AppDeps['homeTelemetry']>['getSyncState']>;
    try {
      sync = this.deps.homeTelemetry.getSyncState(this.deps.env.ACTIVE_HOME_ID);
    } catch {
      const checkedAtMs = this.now();
      return {
        status: 'unavailable',
        required: false,
        configured: true,
        observedAt: timestamp(checkedAtMs),
        cached: false,
        reason: 'unreachable',
        ...diagnosticMetadata({
          checkedAtMs,
          freshness: 'unknown',
          recoveryAction: 'retry',
        }),
      };
    }
    const staleAfterMs = Math.max(this.deps.env.HOME_TELEMETRY_SYNC_INTERVAL_MS * 2, 60_000);
    const stale =
      sync.lastSuccessAtMs !== undefined && this.now() - sync.lastSuccessAtMs > staleAfterMs;
    const status: HealthStatus = sync.lastErrorCode
      ? sync.lastSuccessAtMs
        ? 'degraded'
        : 'unavailable'
      : sync.lastSuccessAtMs === undefined || stale
        ? 'degraded'
        : 'healthy';
    return {
      status,
      required: false,
      configured: true,
      observedAt: timestamp(sync.lastAttemptAtMs),
      cached: true,
      ...(sync.lastErrorCode
        ? { reason: 'unreachable' as const }
        : stale
          ? { reason: 'stale_data' as const }
          : sync.lastSuccessAtMs === undefined
            ? { reason: 'availability_not_checked' as const }
            : {}),
      ...diagnosticMetadata({
        checkedAtMs: sync.lastAttemptAtMs,
        successAtMs: sync.lastSuccessAtMs,
        freshness: sync.lastSuccessAtMs === undefined ? 'unknown' : stale ? 'stale' : 'fresh',
        recoveryAction: status === 'healthy' ? 'none' : 'retry',
      }),
    };
  }

  async getSnapshot(): Promise<{
    diagnostics: HealthDiagnosticsSnapshot;
    legacyHomeAssistantStatus: 'ok' | 'unauthorized' | 'unreachable' | 'not_configured';
  }> {
    const [conversationDatabase, homeAssistant] = await Promise.all([
      this.getReadiness(),
      this.getHomeAssistant(),
    ]);
    const spotifyWebApi = this.getSpotify();
    const homeTelemetry = this.getHomeTelemetry();
    const status =
      conversationDatabase.status === 'unavailable'
        ? 'unavailable'
        : homeAssistant.diagnostic.status === 'unavailable'
          ? 'degraded'
          : 'healthy';

    return {
      diagnostics: {
        status,
        liveness: { status: 'healthy' },
        readiness: {
          status: conversationDatabase.status === 'healthy' ? 'healthy' : 'unavailable',
        },
        dependencies: {
          conversationDatabase,
          homeAssistant: homeAssistant.diagnostic,
          spotifyWebApi,
          homeTelemetry,
        },
      },
      legacyHomeAssistantStatus: homeAssistant.legacyStatus,
    };
  }
}
