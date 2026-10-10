import { createHash } from 'node:crypto';

export type CachedMutationResponse = {
  statusCode: number;
  contentType?: string;
  payload: string | Buffer;
};

type Entry = {
  fingerprint: string;
  createdAt: number;
  expiresAt: number;
  promise: Promise<CachedMutationResponse>;
  resolve: (response: CachedMutationResponse) => void;
  settled: boolean;
  pendingTimer: NodeJS.Timeout;
};

export type MutationReservation =
  | { kind: 'owner'; cacheKey: string }
  | { kind: 'replay'; response: Promise<CachedMutationResponse> }
  | { kind: 'conflict' }
  | { kind: 'capacity' };

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
    .join(',')}}`;
}

export function mutationFingerprint(action: string, parameters: unknown): string {
  return createHash('sha256')
    .update(canonicalJson({ action, parameters }))
    .digest('hex');
}

export class MutationIdempotencyCoordinator {
  private readonly entries = new Map<string, Entry>();

  constructor(
    private readonly options: {
      ttlMs?: number;
      maxEntries?: number;
      pendingTimeoutMs?: number;
      now?: () => number;
    } = {}
  ) {}

  reserve(identity: string, idempotencyKey: string, fingerprint: string): MutationReservation {
    const now = (this.options.now ?? Date.now)();
    this.prune(now);
    const cacheKey = `${identity}\u0000${idempotencyKey}`;
    const existing = this.entries.get(cacheKey);
    if (existing) {
      if (existing.fingerprint !== fingerprint) return { kind: 'conflict' };
      return { kind: 'replay', response: existing.promise };
    }

    const maxEntries = this.options.maxEntries ?? 2_048;
    if (this.entries.size >= maxEntries) return { kind: 'capacity' };

    let resolve!: (response: CachedMutationResponse) => void;
    const promise = new Promise<CachedMutationResponse>((done) => {
      resolve = done;
    });
    const ttlMs = this.options.ttlMs ?? 5 * 60_000;
    const pendingTimeoutMs = this.options.pendingTimeoutMs ?? 65_000;
    const entry: Entry = {
      fingerprint,
      createdAt: now,
      expiresAt: now + ttlMs,
      promise,
      resolve,
      settled: false,
      pendingTimer: setTimeout(() => {
        if (entry.settled) return;
        entry.settled = true;
        entry.resolve({
          statusCode: 503,
          contentType: 'application/json; charset=utf-8',
          payload: JSON.stringify({ error: 'mutation_result_unknown' }),
        });
      }, pendingTimeoutMs),
    };
    entry.pendingTimer.unref?.();
    this.entries.set(cacheKey, entry);
    return { kind: 'owner', cacheKey };
  }

  complete(cacheKey: string, response: CachedMutationResponse): void {
    const entry = this.entries.get(cacheKey);
    if (!entry || entry.settled) return;
    entry.settled = true;
    clearTimeout(entry.pendingTimer);
    entry.resolve(response);
  }

  private prune(now: number): void {
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now && entry.settled) {
        clearTimeout(entry.pendingTimer);
        this.entries.delete(key);
      }
    }
    const maxEntries = this.options.maxEntries ?? 2_048;
    if (this.entries.size < maxEntries) return;
    const completed = [...this.entries.entries()]
      .filter(([, entry]) => entry.settled)
      .sort(([, left], [, right]) => left.createdAt - right.createdAt);
    for (const [key, entry] of completed) {
      clearTimeout(entry.pendingTimer);
      this.entries.delete(key);
      if (this.entries.size < maxEntries) break;
    }
  }
}
