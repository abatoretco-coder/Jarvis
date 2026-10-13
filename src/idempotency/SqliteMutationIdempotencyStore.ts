import type Database from 'better-sqlite3';

import type {
  CachedMutationResponse,
  MutationIdempotencyStore,
  PersistedMutationEntry,
} from './MutationIdempotencyCoordinator';

type StoredRow = {
  request_fingerprint: string;
  state: 'pending' | 'completed';
  status_code: number | null;
  content_type: string | null;
  payload: Buffer | null;
  expires_at_ms: number;
};

export class SqliteMutationIdempotencyStore implements MutationIdempotencyStore {
  constructor(private readonly db: Database.Database) {}

  get(identity: string, idempotencyKey: string, now: number): PersistedMutationEntry | undefined {
    const row = this.db.prepare(`
      SELECT request_fingerprint,state,status_code,content_type,payload,expires_at_ms
      FROM mutation_idempotency_results
      WHERE identity=? AND idempotency_key=? AND expires_at_ms>?
    `).get(identity, idempotencyKey, now) as StoredRow | undefined;
    if (!row) return undefined;
    const response: CachedMutationResponse | undefined = row.state === 'completed'
      && row.status_code !== null
      && row.payload !== null
      ? {
          statusCode: row.status_code,
          ...(row.content_type ? { contentType: row.content_type } : {}),
          payload: Buffer.from(row.payload),
        }
      : undefined;
    return {
      fingerprint: row.request_fingerprint,
      state: row.state,
      ...(response ? { response } : {}),
      expiresAt: row.expires_at_ms,
    };
  }

  reserve(
    identity: string,
    idempotencyKey: string,
    fingerprint: string,
    createdAt: number,
    expiresAt: number
  ): 'created' | 'exists' {
    const result = this.db.prepare(`
      INSERT OR IGNORE INTO mutation_idempotency_results(
        identity,idempotency_key,request_fingerprint,state,created_at_ms,expires_at_ms
      ) VALUES (?,?,?,'pending',?,?)
    `).run(identity, idempotencyKey, fingerprint, createdAt, expiresAt);
    return result.changes === 1 ? 'created' : 'exists';
  }

  complete(identity: string, idempotencyKey: string, response: CachedMutationResponse): void {
    const payload = Buffer.isBuffer(response.payload)
      ? Buffer.from(response.payload)
      : Buffer.from(response.payload, 'utf8');
    this.db.prepare(`
      UPDATE mutation_idempotency_results
      SET state='completed',status_code=?,content_type=?,payload=?
      WHERE identity=? AND idempotency_key=?
    `).run(response.statusCode, response.contentType ?? null, payload, identity, idempotencyKey);
  }

  prune(now: number): void {
    this.db.prepare('DELETE FROM mutation_idempotency_results WHERE expires_at_ms<=?').run(now);
  }
}
