import { z } from 'zod';

import type { Env } from '../env';

const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_COLLECTION_ITEMS = 256;
const PERCENT_TOLERANCE = 0.2;
const MAX_FUTURE_CLOCK_SKEW_MS = 5 * 60 * 1000;
const MIN_SOURCE_AGE_TOLERANCE_MS = 5 * 1000;

type NasStatusLogger = {
  warn(obj: Record<string, unknown>, msg: string): void;
};

const boundedLabel = (max: number) => z.string().trim().min(1).max(max);
const nonNegativeNumber = z.number().finite().nonnegative().max(Number.MAX_SAFE_INTEGER);
const percentage = z.number().finite().min(0).max(100);

function percentageMatches(total: number, available: number, usedPercent: number): boolean {
  if (available > total) return false;
  if (total === 0) return available === 0 && usedPercent === 0;
  const calculated = ((total - available) / total) * 100;
  return Math.abs(calculated - usedPercent) <= PERCENT_TOLERANCE;
}

function hasValidCalendarDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})T/u.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  );
}

const memorySchema = z
  .object({
    totalBytes: nonNegativeNumber.positive(),
    availableBytes: nonNegativeNumber,
    usedPercent: percentage,
  })
  .superRefine((value, context) => {
    if (!percentageMatches(value.totalBytes, value.availableBytes, value.usedPercent)) {
      context.addIssue({ code: 'custom', message: 'inconsistent_memory_measurement' });
    }
  });

const swapSchema = z
  .object({
    totalBytes: nonNegativeNumber,
    freeBytes: nonNegativeNumber,
    usedPercent: percentage,
  })
  .superRefine((value, context) => {
    if (!percentageMatches(value.totalBytes, value.freeBytes, value.usedPercent)) {
      context.addIssue({ code: 'custom', message: 'inconsistent_swap_measurement' });
    }
  });

const filesystemSchema = z
  .object({
    mount: boundedLabel(1024),
    totalBytes: nonNegativeNumber.positive(),
    availableBytes: nonNegativeNumber,
    usedPercent: percentage,
  })
  .superRefine((value, context) => {
    if (!percentageMatches(value.totalBytes, value.availableBytes, value.usedPercent)) {
      context.addIssue({ code: 'custom', message: 'inconsistent_filesystem_measurement' });
    }
  });

const nasStatusSchema = z.object({
  hostname: boundedLabel(255),
  generatedAt: z.string().datetime({ offset: true }).refine(hasValidCalendarDate),
  uptimeSeconds: nonNegativeNumber,
  load: z.object({
    one: nonNegativeNumber,
    five: nonNegativeNumber,
    fifteen: nonNegativeNumber,
  }),
  memory: memorySchema,
  swap: swapSchema,
  filesystems: z.array(filesystemSchema).max(MAX_COLLECTION_ITEMS),
  temperatures: z
    .array(
      z.object({
        label: boundedLabel(128),
        celsius: z.number().finite().min(-100).max(250),
      })
    )
    .max(MAX_COLLECTION_ITEMS),
  protocols: z
    .array(
      z.object({
        name: boundedLabel(128),
        available: z.boolean(),
        port: z.number().int().min(1).max(65_535).optional(),
      })
    )
    .max(MAX_COLLECTION_ITEMS),
});

type ValidatedNasStatus = z.infer<typeof nasStatusSchema>;

export type NasStatusFreshness = {
  state: 'fresh' | 'stale';
  fetchedAt: string;
};

export type NasStatus = ValidatedNasStatus & {
  /** Local cache metadata. The NAS collector cannot override this value. */
  freshness?: NasStatusFreshness;
};

export class NasStatusError extends Error {
  constructor(
    readonly code: string,
    readonly status?: number
  ) {
    super(code);
    this.name = 'NasStatusError';
  }
}

function safeErrorCode(error: unknown): string {
  return error instanceof NasStatusError ? error.code : 'nas_status_refresh_failed';
}

async function readBoundedBody(response: Response, signal: AbortSignal): Promise<string> {
  const advertisedLength = response.headers.get('content-length');
  if (advertisedLength) {
    const parsedLength = Number(advertisedLength);
    if (Number.isFinite(parsedLength) && parsedLength > MAX_RESPONSE_BYTES) {
      throw new NasStatusError('nas_status_response_too_large');
    }
  }

  if (!response.body) throw new NasStatusError('nas_status_invalid_json');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let totalBytes = 0;
  let body = '';

  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      totalBytes += chunk.value.byteLength;
      if (totalBytes > MAX_RESPONSE_BYTES) {
        void reader.cancel().catch(() => undefined);
        throw new NasStatusError('nas_status_response_too_large');
      }
      body += decoder.decode(chunk.value, { stream: true });
    }
    body += decoder.decode();
    return body;
  } catch (error) {
    if (error instanceof NasStatusError) throw error;
    if (signal.aborted) throw new NasStatusError('nas_status_timeout');
    throw new NasStatusError('nas_status_body_read_failed');
  } finally {
    reader.releaseLock();
  }
}

function parseSnapshot(body: string): ValidatedNasStatus {
  let json: unknown;
  try {
    json = JSON.parse(body) as unknown;
  } catch {
    throw new NasStatusError('nas_status_invalid_json');
  }
  const result = nasStatusSchema.safeParse(json);
  if (!result.success) throw new NasStatusError('nas_status_invalid_payload');
  return result.data;
}

function withFreshness(
  value: ValidatedNasStatus,
  fetchedAt: number,
  state: 'fresh' | 'stale'
): NasStatus {
  return {
    ...value,
    freshness: {
      state,
      fetchedAt: new Date(fetchedAt).toISOString(),
    },
  };
}

function snapshotAge(value: ValidatedNasStatus, fetchedAt: number, now: number): number {
  const cacheAge = Math.max(0, now - fetchedAt);
  const measurementAge = Math.max(0, now - Date.parse(value.generatedAt));
  return Math.max(cacheAge, measurementAge);
}

export class NasStatusClient {
  private readonly url?: string;
  private readonly token?: string;
  private readonly timeoutMs: number;
  private readonly cacheTtlMs: number;
  private readonly cacheStaleMs: number;
  private cached?: { value: ValidatedNasStatus; fetchedAt: number };
  private inFlight?: Promise<NasStatus>;
  private backgroundRefresh?: Promise<void>;

  constructor(
    env: Env,
    private readonly log?: NasStatusLogger
  ) {
    this.url = env.NAS_STATUS_URL;
    this.token = env.NAS_STATUS_TOKEN;
    this.timeoutMs = env.NAS_STATUS_TIMEOUT_MS;
    this.cacheTtlMs = env.NAS_STATUS_CACHE_TTL_MS;
    this.cacheStaleMs = env.NAS_STATUS_CACHE_STALE_MS;
  }

  isConfigured(): boolean {
    return Boolean(this.url && this.token);
  }

  async getStatus(): Promise<NasStatus> {
    if (!this.url || !this.token) throw new NasStatusError('nas_status_not_configured');
    const now = Date.now();
    if (
      this.cached &&
      snapshotAge(this.cached.value, this.cached.fetchedAt, now) <= this.cacheTtlMs
    ) {
      return withFreshness(this.cached.value, this.cached.fetchedAt, 'fresh');
    }
    if (
      this.cached &&
      snapshotAge(this.cached.value, this.cached.fetchedAt, now) <= this.cacheStaleMs
    ) {
      this.refreshInBackground();
      return withFreshness(this.cached.value, this.cached.fetchedAt, 'stale');
    }
    return this.refreshStatus();
  }

  private refreshInBackground(): void {
    if (this.backgroundRefresh) return;
    this.backgroundRefresh = this.refreshStatus()
      .then(() => undefined)
      .catch((error) => {
        this.log?.warn({ errorCode: safeErrorCode(error) }, 'NAS status background refresh failed');
      })
      .finally(() => {
        this.backgroundRefresh = undefined;
      });
  }

  private async refreshStatus(): Promise<NasStatus> {
    if (this.inFlight) return this.inFlight;
    const url = this.url;
    const token = this.token;
    if (!url || !token) throw new NasStatusError('nas_status_not_configured');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    this.inFlight = (async () => {
      let response: Response;
      try {
        response = await fetch(url, {
          headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
          redirect: 'error',
          signal: controller.signal,
        });
      } catch {
        if (controller.signal.aborted) throw new NasStatusError('nas_status_timeout');
        throw new NasStatusError('nas_status_network_error');
      }
      if (!response.ok) {
        throw new NasStatusError(`nas_status_http_${response.status}`, response.status);
      }
      const body = await readBoundedBody(response, controller.signal);
      const value = parseSnapshot(body);
      const fetchedAt = Date.now();
      const generatedAt = Date.parse(value.generatedAt);
      if (generatedAt > fetchedAt + MAX_FUTURE_CLOCK_SKEW_MS) {
        throw new NasStatusError('nas_status_invalid_payload');
      }
      const maximumAge = Math.max(this.cacheTtlMs, this.cacheStaleMs, MIN_SOURCE_AGE_TOLERANCE_MS);
      if (fetchedAt - generatedAt > maximumAge) {
        throw new NasStatusError('nas_status_snapshot_too_old');
      }
      this.cached = { value, fetchedAt };
      const state = snapshotAge(value, fetchedAt, fetchedAt) <= this.cacheTtlMs ? 'fresh' : 'stale';
      return withFreshness(value, fetchedAt, state);
    })().finally(() => {
      clearTimeout(timeout);
      this.inFlight = undefined;
    });
    return this.inFlight;
  }
}
