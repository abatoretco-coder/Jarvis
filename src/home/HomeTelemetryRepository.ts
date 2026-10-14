import type Database from 'better-sqlite3';

export type HomeTelemetryEntity = {
  homeId: string;
  entityId: string;
  deviceId?: string;
  roomId?: string;
  domain: string;
  role: string;
  unitOfMeasurement?: string;
  deviceClass?: string;
  stateClass?: string;
};

export type HomeTelemetrySample = {
  entity: HomeTelemetryEntity;
  observedAtMs: number;
  state: string;
  numericValue?: number;
  attributes?: Record<string, unknown>;
  source: 'home_assistant_history' | 'home_assistant_snapshot';
  capturedAtMs: number;
};

export type HomeTelemetryHistoryPoint = {
  entityId: string;
  observedAt: string;
  state: string;
  numericValue?: number;
  attributes?: Record<string, unknown>;
  source: HomeTelemetrySample['source'];
};

export type HomeTelemetrySyncState = {
  historyCursorAtMs?: number;
  lastAttemptAtMs?: number;
  lastSuccessAtMs?: number;
  lastErrorCode?: string;
};

type EntityRow = {
  entity_id: string;
  device_id: string | null;
  room_id: string | null;
  domain: string;
  role: string;
  unit_of_measurement: string | null;
  device_class: string | null;
  state_class: string | null;
  first_seen_at_ms: number;
  last_seen_at_ms: number;
};

export class HomeTelemetryRepository {
  constructor(private readonly db: Database.Database) {}

  ingest(samples: HomeTelemetrySample[]): number {
    if (samples.length === 0) return 0;
    const upsertEntity = this.db.prepare(`
      INSERT INTO home_telemetry_entities(
        home_id,entity_id,device_id,room_id,domain,role,unit_of_measurement,
        device_class,state_class,first_seen_at_ms,last_seen_at_ms
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(home_id,entity_id) DO UPDATE SET
        device_id=excluded.device_id,
        room_id=excluded.room_id,
        domain=excluded.domain,
        role=excluded.role,
        unit_of_measurement=COALESCE(excluded.unit_of_measurement,home_telemetry_entities.unit_of_measurement),
        device_class=COALESCE(excluded.device_class,home_telemetry_entities.device_class),
        state_class=COALESCE(excluded.state_class,home_telemetry_entities.state_class),
        first_seen_at_ms=MIN(home_telemetry_entities.first_seen_at_ms,excluded.first_seen_at_ms),
        last_seen_at_ms=MAX(home_telemetry_entities.last_seen_at_ms,excluded.last_seen_at_ms)
    `);
    const insertSample = this.db.prepare(`
      INSERT OR IGNORE INTO home_telemetry_samples(
        home_id,entity_id,observed_at_ms,state,numeric_value,attributes_json,source,captured_at_ms
      ) VALUES (?,?,?,?,?,?,?,?)
    `);
    return this.db.transaction((batch: HomeTelemetrySample[]) => {
      let inserted = 0;
      for (const sample of batch) {
        const entity = sample.entity;
        upsertEntity.run(
          entity.homeId,
          entity.entityId,
          entity.deviceId ?? null,
          entity.roomId ?? null,
          entity.domain,
          entity.role,
          entity.unitOfMeasurement ?? null,
          entity.deviceClass ?? null,
          entity.stateClass ?? null,
          sample.observedAtMs,
          sample.observedAtMs
        );
        const result = insertSample.run(
          entity.homeId,
          entity.entityId,
          sample.observedAtMs,
          sample.state.slice(0, 512),
          sample.numericValue ?? null,
          sample.attributes ? JSON.stringify(sample.attributes) : null,
          sample.source,
          sample.capturedAtMs
        );
        inserted += result.changes;
      }
      return inserted;
    })(samples);
  }

  listEntities(homeId: string): Array<HomeTelemetryEntity & { firstSeenAt: string; lastSeenAt: string }> {
    const rows = this.db.prepare(`
      SELECT entity_id,device_id,room_id,domain,role,unit_of_measurement,device_class,state_class,
             first_seen_at_ms,last_seen_at_ms
      FROM home_telemetry_entities
      WHERE home_id=?
      ORDER BY room_id,device_id,entity_id
    `).all(homeId) as EntityRow[];
    return rows.map((row) => ({
      homeId,
      entityId: row.entity_id,
      ...(row.device_id ? { deviceId: row.device_id } : {}),
      ...(row.room_id ? { roomId: row.room_id } : {}),
      domain: row.domain,
      role: row.role,
      ...(row.unit_of_measurement ? { unitOfMeasurement: row.unit_of_measurement } : {}),
      ...(row.device_class ? { deviceClass: row.device_class } : {}),
      ...(row.state_class ? { stateClass: row.state_class } : {}),
      firstSeenAt: new Date(row.first_seen_at_ms).toISOString(),
      lastSeenAt: new Date(row.last_seen_at_ms).toISOString(),
    }));
  }

  history(input: {
    homeId: string;
    entityId: string;
    fromMs: number;
    toMs: number;
    limit: number;
  }): HomeTelemetryHistoryPoint[] {
    const rows = this.db.prepare(`
      SELECT entity_id,observed_at_ms,state,numeric_value,attributes_json,source
      FROM home_telemetry_samples
      WHERE home_id=? AND entity_id=? AND observed_at_ms BETWEEN ? AND ?
      ORDER BY observed_at_ms ASC
      LIMIT ?
    `).all(input.homeId, input.entityId, input.fromMs, input.toMs, input.limit) as Array<{
      entity_id: string;
      observed_at_ms: number;
      state: string;
      numeric_value: number | null;
      attributes_json: string | null;
      source: HomeTelemetrySample['source'];
    }>;
    return rows.map((row) => ({
      entityId: row.entity_id,
      observedAt: new Date(row.observed_at_ms).toISOString(),
      state: row.state,
      ...(row.numeric_value === null ? {} : { numericValue: row.numeric_value }),
      ...(row.attributes_json
        ? { attributes: JSON.parse(row.attributes_json) as Record<string, unknown> }
        : {}),
      source: row.source,
    }));
  }

  getSyncState(homeId: string): HomeTelemetrySyncState {
    const row = this.db.prepare(`
      SELECT history_cursor_at_ms,last_attempt_at_ms,last_success_at_ms,last_error_code
      FROM home_telemetry_sync_state WHERE home_id=?
    `).get(homeId) as {
      history_cursor_at_ms: number | null;
      last_attempt_at_ms: number | null;
      last_success_at_ms: number | null;
      last_error_code: string | null;
    } | undefined;
    if (!row) return {};
    return {
      ...(row.history_cursor_at_ms === null ? {} : { historyCursorAtMs: row.history_cursor_at_ms }),
      ...(row.last_attempt_at_ms === null ? {} : { lastAttemptAtMs: row.last_attempt_at_ms }),
      ...(row.last_success_at_ms === null ? {} : { lastSuccessAtMs: row.last_success_at_ms }),
      ...(row.last_error_code ? { lastErrorCode: row.last_error_code } : {}),
    };
  }

  markSyncAttempt(homeId: string, attemptedAtMs: number): void {
    this.db.prepare(`
      INSERT INTO home_telemetry_sync_state(home_id,last_attempt_at_ms)
      VALUES (?,?)
      ON CONFLICT(home_id) DO UPDATE SET last_attempt_at_ms=excluded.last_attempt_at_ms
    `).run(homeId, attemptedAtMs);
  }

  markSyncSuccess(homeId: string, cursorAtMs: number, completedAtMs: number): void {
    this.db.prepare(`
      INSERT INTO home_telemetry_sync_state(
        home_id,history_cursor_at_ms,last_attempt_at_ms,last_success_at_ms,last_error_code
      ) VALUES (?,?,?,?,NULL)
      ON CONFLICT(home_id) DO UPDATE SET
        history_cursor_at_ms=excluded.history_cursor_at_ms,
        last_attempt_at_ms=excluded.last_attempt_at_ms,
        last_success_at_ms=excluded.last_success_at_ms,
        last_error_code=NULL
    `).run(homeId, cursorAtMs, completedAtMs, completedAtMs);
  }

  markSyncFailure(homeId: string, attemptedAtMs: number, errorCode: string): void {
    this.db.prepare(`
      INSERT INTO home_telemetry_sync_state(home_id,last_attempt_at_ms,last_error_code)
      VALUES (?,?,?)
      ON CONFLICT(home_id) DO UPDATE SET
        last_attempt_at_ms=excluded.last_attempt_at_ms,
        last_error_code=excluded.last_error_code
    `).run(homeId, attemptedAtMs, errorCode.slice(0, 160));
  }

  purgeBefore(homeId: string, cutoffMs: number): number {
    return this.db.prepare(
      'DELETE FROM home_telemetry_samples WHERE home_id=? AND observed_at_ms<?'
    ).run(homeId, cutoffMs).changes;
  }
}
