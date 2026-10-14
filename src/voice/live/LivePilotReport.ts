import type Database from 'better-sqlite3';

type CountRow = { count: number };
type LatencyRow = { elapsed_ms: number };
type StateRow = { state: string; count: number };

function count(db: Database.Database, sql: string, sinceMs: number): number {
  return Number((db.prepare(sql).get(sinceMs) as CountRow).count);
}

function percentile95(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)] ?? null;
}

function latencyP95(
  db: Database.Database,
  eventType: string,
  sinceMs: number
): number | null {
  const rows = db.prepare(
    `SELECT t.elapsed_ms FROM live_voice_telemetry t
     JOIN live_voice_sessions s ON s.session_id=t.session_id
     WHERE s.client='desktop' AND t.event_type=? AND t.occurred_at_ms>=?
       AND t.elapsed_ms IS NOT NULL`
  ).all(eventType, sinceMs) as LatencyRow[];
  return percentile95(rows.map((row) => Number(row.elapsed_ms)));
}

export type LivePilotReport = ReturnType<typeof buildLivePilotReport>;

export function buildLivePilotReport(db: Database.Database, sinceMs = 0) {
  const sessions = count(
    db,
    "SELECT COUNT(*) AS count FROM live_voice_sessions WHERE client='desktop' AND created_at_ms>=?",
    sinceMs
  );
  const connectedSessions = count(
    db,
    `SELECT COUNT(DISTINCT t.session_id) AS count FROM live_voice_telemetry t
     JOIN live_voice_sessions s ON s.session_id=t.session_id
     WHERE s.client='desktop' AND t.event_type='client_connected' AND t.occurred_at_ms>=?`,
    sinceMs
  );
  const fallbackCount = count(
    db,
    `SELECT COUNT(*) AS count FROM live_voice_telemetry t
     JOIN live_voice_sessions s ON s.session_id=t.session_id
     WHERE s.client='desktop' AND t.event_type='fallback_started' AND t.occurred_at_ms>=?`,
    sinceMs
  );
  const delegationStates = Object.fromEntries(
    (db.prepare(
      `SELECT d.state,COUNT(*) AS count
       FROM live_voice_delegations d
       JOIN live_voice_sessions s ON s.session_id=d.session_id
       WHERE s.client='desktop' AND s.created_at_ms>=?
       GROUP BY d.state ORDER BY d.state`
    ).all(sinceMs) as StateRow[]).map((row) => [row.state, Number(row.count)])
  );
  const uncertainOrFailed = (delegationStates['uncertain'] ?? 0) + (delegationStates['failed'] ?? 0);

  return {
    since: new Date(sinceMs).toISOString(),
    sessions,
    connectedSessions,
    connectionSuccessRate: sessions === 0 ? null : connectedSessions / sessions,
    fallbackCount,
    delegationStates,
    latenciesMsP95: {
      connection: latencyP95(db, 'client_connected', sinceMs),
      ingest: latencyP95(db, 'ingest_completed', sinceMs),
      firstAudio: latencyP95(db, 'first_audio_played', sinceMs),
    },
    gates: {
      sampleComplete: connectedSessions >= 30,
      connectionRateAtLeast95Percent:
        sessions > 0 && connectedSessions / sessions >= 0.95,
      noUnresolvedFailure: uncertainOrFailed === 0,
    },
  };
}
