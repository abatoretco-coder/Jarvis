import { createHash } from 'node:crypto';

export type CachedMutationResponse = {
  statusCode: number;
  contentType?: string;
  payload: string | Buffer;
};

export type PersistedMutationEntry = {
  fingerprint: string;
  state: 'pending' | 'completed';
  response?: CachedMutationResponse;
  expiresAt: number;
};

export interface MutationIdempotencyStore {
  get(identity: string, idempotencyKey: string, now: number): PersistedMutationEntry | undefined;
  reserve(identity: string, idempotencyKey: string, fingerprint: string, createdAt: number, expiresAt: number): 'created' | 'exists';
  complete(identity: string, idempotencyKey: string, response: CachedMutationResponse): void;
  prune(now: number): void;
}

type Entry = {
  identity: string;
  idempotencyKey: string;
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
      store?: MutationIdempotencyStore;
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

    const persisted = this.options.store?.get(identity, idempotencyKey, now);
    if (persisted) {
      if (persisted.fingerprint !== fingerprint) return { kind: 'conflict' };
      if (persisted.state === 'completed' && persisted.response) {
        return { kind: 'replay', response: Promise.resolve(persisted.response) };
      }
      return {
        kind: 'replay',
        response: Promise.resolve({
          statusCode: 503,
          contentType: 'application/json; charset=utf-8',
          payload: JSON.stringify({
            error: 'mutation_result_unknown',
            operationStatus: 'uncertain',
          }),
        }),
      };
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
      identity,
      idempotencyKey,
      fingerprint,
      createdAt: now,
      expiresAt: now + ttlMs,
      promise,
      resolve,
      settled: false,
      pendingTimer: setTimeout(() => {
        if (entry.settled) return;
        entry.settled = true;
        const response: CachedMutationResponse = {
          statusCode: 503,
          contentType: 'application/json; charset=utf-8',
          payload: JSON.stringify({
            error: 'mutation_result_unknown',
            operationStatus: 'uncertain',
          }),
        };
        try {
          this.options.store?.complete(entry.identity, entry.idempotencyKey, response);
        } catch {
          // The in-memory waiter must still be released if persistence is no
          // longer available during shutdown.
        }
        entry.resolve(response);
      }, pendingTimeoutMs),
    };
    if (this.options.store?.reserve(identity, idempotencyKey, fingerprint, now, entry.expiresAt) === 'exists') {
      clearTimeout(entry.pendingTimer);
      return this.reserve(identity, idempotencyKey, fingerprint);
    }
    entry.pendingTimer.unref?.();
    this.entries.set(cacheKey, entry);
    return { kind: 'owner', cacheKey };
  }

  complete(cacheKey: string, response: CachedMutationResponse): void {
    const entry = this.entries.get(cacheKey);
    if (!entry || entry.settled) return;
    entry.settled = true;
    clearTimeout(entry.pendingTimer);
    this.options.store?.complete(entry.identity, entry.idempotencyKey, response);
    entry.resolve(response);
  }

  private prune(now: number): void {
    this.options.store?.prune(now);
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
