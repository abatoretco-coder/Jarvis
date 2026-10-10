import { verifyConversationDatabase } from '../conversation/conversationDbBackup';
import type { AppDeps } from '../server';

export const HEALTH_CONTRACT_VERSION = '1.0';

export type HealthStatus = 'healthy' | 'degraded' | 'unavailable' | 'not_configured';

export type DependencyDiagnostic = {
  status: HealthStatus;
  required: boolean;
  configured: boolean;
  observedAt: string | null;
  cached: boolean;
  reason?:
    | 'availability_not_checked'
    | 'authorization_failed'
    | 'configuration_missing'
    | 'integrity_check_failed'
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
};

class TimedProbeCache<T> {
  private entry?: { value: T; observedAtMs: number };
  private refreshPromise?: Promise<{ value: T; observedAtMs: number }>;

  constructor(
    private readonly loader: () => Promise<T>,
    private readonly ttlMs: number,
    private readonly now: () => number,
    private readonly shouldCache: (value: T) => boolean = () => true
  ) {}

  async get(): Promise<CachedProbe<T>> {
    const nowMs = this.now();
    if (this.entry && nowMs - this.entry.observedAtMs <= this.ttlMs) {
      return { ...this.entry, cached: true };
    }

    const refreshed = await this.refresh();
    return { ...refreshed, cached: false };
  }

  private refresh(): Promise<{ value: T; observedAtMs: number }> {
    if (this.refreshPromise) return this.refreshPromise;

    this.refreshPromise = this.loader()
      .then((value) => {
        const result = { value, observedAtMs: this.now() };
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
const DEFAULT_HOME_ASSISTANT_TIMEOUT_MS = 750;

function isoTimestamp(timestampMs: number): string {
  return new Date(timestampMs).toISOString();
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
    this.homeAssistantTimeoutMs = options.homeAssistantTimeoutMs ?? DEFAULT_HOME_ASSISTANT_TIMEOUT_MS;
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
        this.now
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
          schemaVersion: probe.value.schemaVersion,
        }
      : {
          status: 'unavailable',
          required: true,
          configured: true,
          observedAt: isoTimestamp(probe.observedAtMs),
          cached: probe.cached,
          reason: probe.value.reason,
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
        },
        legacyStatus: 'not_configured',
      };
    }

    const probe = await this.homeAssistantProbe.get();
    return {
      diagnostic: {
        status: probe.value.status,
        required: false,
        configured: true,
        observedAt: isoTimestamp(probe.observedAtMs),
        cached: probe.cached,
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
      };
    }
    return {
      status: 'degraded',
      required: false,
      configured: true,
      observedAt: null,
      cached: false,
      reason: 'availability_not_checked',
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
        },
      },
      legacyHomeAssistantStatus: homeAssistant.legacyStatus,
    };
  }
}
