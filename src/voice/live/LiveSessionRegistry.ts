import { createHash } from 'node:crypto';

import type Database from 'better-sqlite3';

import type {
  LiveClient,
  LiveDelegationRecord,
  LiveDelegationState,
  LiveSessionRecord,
  LiveSessionState,
  LiveTelemetryEventType,
} from './types';

type SessionRow = {
  session_id: string;
  owner_user_id: string;
  device_hash: string;
  thread_id: string;
  client: LiveClient;
  state: LiveSessionState;
  sideband_attached: number;
  finalization_confirmed: number;
  usage_seconds: number;
  created_at_ms: number;
  expires_at_ms: number;
  last_event_at_ms: number;
  closed_at_ms: number | null;
  last_error_code: string | null;
};

type DelegationRow = {
  session_id: string;
  delegation_id: string;
  state: LiveDelegationState;
  operation_key: string | null;
  observed_at_ms: number;
  updated_at_ms: number;
};

function toSession(row: SessionRow): LiveSessionRecord {
  return {
    sessionId: row.session_id,
    ownerUserId: row.owner_user_id,
    deviceHash: row.device_hash,
    threadId: row.thread_id,
    client: row.client,
    state: row.state,
    sidebandAttached: row.sideband_attached === 1,
    finalizationConfirmed: row.finalization_confirmed === 1,
    usageSeconds: Number(row.usage_seconds),
    createdAtMs: Number(row.created_at_ms),
    expiresAtMs: Number(row.expires_at_ms),
    lastEventAtMs: Number(row.last_event_at_ms),
    closedAtMs: row.closed_at_ms === null ? null : Number(row.closed_at_ms),
    lastErrorCode: row.last_error_code,
  };
}

function toDelegation(row: DelegationRow): LiveDelegationRecord {
  return {
    sessionId: row.session_id,
    delegationId: row.delegation_id,
    state: row.state,
    operationKey: row.operation_key,
    observedAtMs: Number(row.observed_at_ms),
    updatedAtMs: Number(row.updated_at_ms),
  };
}

const delegationStateRank: Record<LiveDelegationState, number> = {
  capturing: 0,
  ready_to_delegate: 1,
  delegating: 2,
  ingest_sent: 3,
  ingest_running: 4,
  ingest_completed: 5,
  replying: 6,
  completed: 7,
  uncertain: 7,
  failed: 7,
};

export function hashLiveDeviceId(deviceId: string): string {
  return createHash('sha256').update(deviceId.trim(), 'utf8').digest('hex');
}

export class LiveSessionRegistry {
  constructor(private readonly db: Database.Database) {}

  create(input: {
    sessionId: string;
    ownerUserId: string;
    deviceHash: string;
    threadId: string;
    client: LiveClient;
    nowMs: number;
    expiresAtMs: number;
  }): LiveSessionRecord {
    this.db
      .prepare(
        `INSERT INTO live_voice_sessions(
          session_id,owner_user_id,device_hash,thread_id,client,state,sideband_attached,
          finalization_confirmed,usage_seconds,created_at_ms,expires_at_ms,last_event_at_ms
        ) VALUES (?,?,?,?,?,'active',0,0,0,?,?,?)`
      )
      .run(
        input.sessionId,
        input.ownerUserId,
        input.deviceHash,
        input.threadId,
        input.client,
        input.nowMs,
        input.expiresAtMs,
        input.nowMs
      );
    return this.require(input.sessionId);
  }

  find(sessionId: string): LiveSessionRecord | null {
    const row = this.db
      .prepare('SELECT * FROM live_voice_sessions WHERE session_id=?')
      .get(sessionId) as SessionRow | undefined;
    return row ? toSession(row) : null;
  }

  require(sessionId: string): LiveSessionRecord {
    const session = this.find(sessionId);
    if (!session) throw new Error('live_session_not_found');
    return session;
  }

  findOwnedActive(sessionId: string, ownerUserId: string, nowMs = Date.now()): LiveSessionRecord | null {
    const row = this.db
      .prepare(
        `SELECT * FROM live_voice_sessions
         WHERE session_id=? AND owner_user_id=? AND state='active' AND expires_at_ms>?`
      )
      .get(sessionId, ownerUserId, nowMs) as SessionRow | undefined;
    return row ? toSession(row) : null;
  }

  listActiveForOwner(ownerUserId: string, nowMs = Date.now()): LiveSessionRecord[] {
    return (this.db
      .prepare(
        `SELECT * FROM live_voice_sessions
         WHERE owner_user_id=? AND state IN ('active','closing') AND expires_at_ms>?
         ORDER BY created_at_ms ASC`
      )
      .all(ownerUserId, nowMs) as SessionRow[]).map(toSession);
  }

  listActiveForDevice(ownerUserId: string, deviceHash: string): LiveSessionRecord[] {
    return (this.db
      .prepare(
        `SELECT * FROM live_voice_sessions
         WHERE owner_user_id=? AND device_hash=? AND state IN ('active','closing')
         ORDER BY created_at_ms ASC`
      )
      .all(ownerUserId, deviceHash) as SessionRow[]).map(toSession);
  }

  listRecoverable(nowMs = Date.now()): LiveSessionRecord[] {
    return (this.db
      .prepare(
        `SELECT * FROM live_voice_sessions
         WHERE state IN ('active','closing') AND expires_at_ms>?
         ORDER BY created_at_ms ASC`
      )
      .all(nowMs) as SessionRow[]).map(toSession);
  }

  listOpen(): LiveSessionRecord[] {
    return (this.db
      .prepare(
        `SELECT * FROM live_voice_sessions
         WHERE state IN ('active','closing') ORDER BY created_at_ms ASC`
      )
      .all() as SessionRow[]).map(toSession);
  }

  countRecentCreations(ownerUserId: string, sinceMs: number): number {
    const row = this.db
      .prepare(
        'SELECT COUNT(*) AS count FROM live_voice_sessions WHERE owner_user_id=? AND created_at_ms>=?'
      )
      .get(ownerUserId, sinceMs) as { count: number };
    return Number(row.count);
  }

  usageSecondsSince(sinceMs: number): number {
    const row = this.db
      .prepare(
        'SELECT COALESCE(SUM(usage_seconds),0) AS seconds FROM live_voice_sessions WHERE created_at_ms>=?'
      )
      .get(sinceMs) as { seconds: number };
    return Number(row.seconds);
  }

  markSidebandAttached(sessionId: string, nowMs = Date.now()): void {
    this.db
      .prepare(
        `UPDATE live_voice_sessions
         SET sideband_attached=1,last_event_at_ms=? WHERE session_id=? AND state='active'`
      )
      .run(nowMs, sessionId);
  }

  updateUsage(sessionId: string, usageSeconds: number, nowMs = Date.now()): void {
    this.db
      .prepare(
        `UPDATE live_voice_sessions SET usage_seconds=MAX(usage_seconds,?),last_event_at_ms=?
         WHERE session_id=?`
      )
      .run(Math.max(0, Math.floor(usageSeconds)), nowMs, sessionId);
  }

  markClosing(sessionId: string, nowMs = Date.now()): void {
    this.db
      .prepare(
        `UPDATE live_voice_sessions SET state='closing',last_event_at_ms=?
         WHERE session_id=? AND state='active'`
      )
      .run(nowMs, sessionId);
  }

  markClosed(input: {
    sessionId: string;
    confirmed: boolean;
    usageSeconds?: number;
    errorCode?: string;
    nowMs?: number;
  }): void {
    const nowMs = input.nowMs ?? Date.now();
    this.db
      .prepare(
        `UPDATE live_voice_sessions
         SET state=?,finalization_confirmed=?,usage_seconds=MAX(usage_seconds,?),
             last_event_at_ms=?,closed_at_ms=?,last_error_code=?
         WHERE session_id=?`
      )
      .run(
        input.confirmed ? 'closed' : 'finalization_unconfirmed',
        input.confirmed ? 1 : 0,
        Math.max(0, Math.floor(input.usageSeconds ?? 0)),
        nowMs,
        nowMs,
        input.errorCode?.slice(0, 128) ?? null,
        input.sessionId
      );
  }

  markExpired(nowMs = Date.now()): string[] {
    const ids = (this.db
      .prepare(
        `SELECT session_id FROM live_voice_sessions
         WHERE state IN ('active','closing') AND expires_at_ms<=?`
      )
      .all(nowMs) as Array<{ session_id: string }>).map((row) => row.session_id);
    if (ids.length > 0) {
      this.db
        .prepare(
          `UPDATE live_voice_sessions
           SET state='finalization_unconfirmed',closed_at_ms=?,last_event_at_ms=?,last_error_code='expired'
           WHERE state IN ('active','closing') AND expires_at_ms<=?`
        )
        .run(nowMs, nowMs, nowMs);
    }
    return ids;
  }

  observeDelegation(input: {
    sessionId: string;
    delegationId: string;
    nowMs?: number;
  }): LiveDelegationRecord {
    const nowMs = input.nowMs ?? Date.now();
    this.db
      .prepare(
        `INSERT INTO live_voice_delegations(
          session_id,delegation_id,state,operation_key,observed_at_ms,updated_at_ms
        ) VALUES (?,?,'ready_to_delegate',NULL,?,?)
        ON CONFLICT(session_id,delegation_id) DO UPDATE SET updated_at_ms=excluded.updated_at_ms`
      )
      .run(input.sessionId, input.delegationId, nowMs, nowMs);
    return this.requireDelegation(input.sessionId, input.delegationId);
  }

  findDelegation(sessionId: string, delegationId: string): LiveDelegationRecord | null {
    const row = this.db
      .prepare(
        'SELECT * FROM live_voice_delegations WHERE session_id=? AND delegation_id=?'
      )
      .get(sessionId, delegationId) as DelegationRow | undefined;
    return row ? toDelegation(row) : null;
  }

  requireDelegation(sessionId: string, delegationId: string): LiveDelegationRecord {
    const delegation = this.findDelegation(sessionId, delegationId);
    if (!delegation) throw new Error('live_delegation_not_observed');
    return delegation;
  }

  countDelegations(sessionId: string): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS count FROM live_voice_delegations WHERE session_id=?')
      .get(sessionId) as { count: number };
    return Number(row.count);
  }

  recordTelemetry(input: {
    sessionId: string;
    eventType: LiveTelemetryEventType;
    delegationId?: string;
    elapsedMs?: number;
    nowMs?: number;
  }): void {
    this.db
      .prepare(
        `INSERT INTO live_voice_telemetry(
          session_id,delegation_id,event_type,elapsed_ms,occurred_at_ms
        ) VALUES (?,?,?,?,?)`
      )
      .run(
        input.sessionId,
        input.delegationId ?? null,
        input.eventType,
        input.elapsedMs ?? null,
        input.nowMs ?? Date.now()
      );
  }

  transitionDelegation(input: {
    sessionId: string;
    delegationId: string;
    state: LiveDelegationState;
    operationKey?: string;
    nowMs?: number;
  }): LiveDelegationRecord {
    const nowMs = input.nowMs ?? Date.now();
    const current = this.requireDelegation(input.sessionId, input.delegationId);
    if (delegationStateRank[input.state] < delegationStateRank[current.state]) {
      throw new Error('live_delegation_state_regression');
    }
    if (
      delegationStateRank[current.state] === 7 &&
      input.state !== current.state
    ) {
      throw new Error('live_delegation_state_terminal');
    }
    const result = this.db
      .prepare(
        `UPDATE live_voice_delegations
         SET state=?,operation_key=COALESCE(operation_key,?),updated_at_ms=?
         WHERE session_id=? AND delegation_id=?`
      )
      .run(
        input.state,
        input.operationKey ?? null,
        nowMs,
        input.sessionId,
        input.delegationId
      );
    if (result.changes !== 1) throw new Error('live_delegation_not_observed');
    return this.requireDelegation(input.sessionId, input.delegationId);
  }
}
