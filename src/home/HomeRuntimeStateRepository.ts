import Database from 'better-sqlite3';

import type { AdaptiveLightingTarget } from './AdaptiveLightingPolicy';

export type PersistedLightingIntent = {
  roomId: string;
  mode: 'on' | 'dimmed' | 'off';
  target?: AdaptiveLightingTarget;
  updatedAtMs: number;
};

export type PersistedAutomationSuspension = {
  operationId: string;
  automationId: string;
  entityId: string;
  sceneId: string;
  state: 'pending' | 'suspended' | 'restored' | 'skipped' | 'failed';
  errorCode: string | null;
  suspendedAtMs: number;
  updatedAtMs: number;
};

function parseTarget(value: string | null): AdaptiveLightingTarget | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    if (
      typeof parsed.brightnessPercent !== 'number'
      || typeof parsed.colorTemperatureKelvin !== 'number'
      || !['dawn', 'day', 'dusk', 'night'].includes(String(parsed.phase))
      || typeof parsed.weatherBrightnessAdjustment !== 'number'
      || typeof parsed.weatherColorTemperatureAdjustmentKelvin !== 'number'
    ) return undefined;
    return {
      brightnessPercent: parsed.brightnessPercent,
      colorTemperatureKelvin: parsed.colorTemperatureKelvin,
      phase: parsed.phase as AdaptiveLightingTarget['phase'],
      weatherBrightnessAdjustment: parsed.weatherBrightnessAdjustment,
      weatherColorTemperatureAdjustmentKelvin: parsed.weatherColorTemperatureAdjustmentKelvin,
    };
  } catch {
    return undefined;
  }
}

export class HomeRuntimeStateRepository {
  constructor(private readonly db: Database.Database) {}

  listLightingIntents(): PersistedLightingIntent[] {
    const rows = this.db.prepare(
      'SELECT room_id,mode,target_json,updated_at_ms FROM home_lighting_intents'
    ).all() as Array<{
      room_id: string;
      mode: PersistedLightingIntent['mode'];
      target_json: string | null;
      updated_at_ms: number;
    }>;
    return rows.flatMap((row) => {
      const target = parseTarget(row.target_json);
      if (row.mode !== 'off' && !target) return [];
      return [{
        roomId: row.room_id,
        mode: row.mode,
        ...(target ? { target } : {}),
        updatedAtMs: row.updated_at_ms,
      }];
    });
  }

  saveLightingIntent(intent: Omit<PersistedLightingIntent, 'updatedAtMs'>, now = Date.now()): void {
    this.db.prepare(
      `INSERT INTO home_lighting_intents(room_id,mode,target_json,updated_at_ms)
       VALUES (?,?,?,?)
       ON CONFLICT(room_id) DO UPDATE SET
         mode=excluded.mode,target_json=excluded.target_json,updated_at_ms=excluded.updated_at_ms`
    ).run(intent.roomId, intent.mode, intent.target ? JSON.stringify(intent.target) : null, now);
  }

  deleteLightingIntent(roomId: string): void {
    this.db.prepare('DELETE FROM home_lighting_intents WHERE room_id=?').run(roomId);
  }

  recordAutomationSuspension(input: {
    operationId: string;
    automationId: string;
    entityId: string;
    sceneId: string;
  }, now = Date.now()): void {
    this.db.prepare(
      `INSERT INTO home_automation_suspensions(
         operation_id,automation_id,entity_id,scene_id,state,suspended_at_ms,updated_at_ms
       ) VALUES (?,?,?,?,'pending',?,?)
       ON CONFLICT(operation_id,automation_id) DO NOTHING`
    ).run(input.operationId, input.automationId, input.entityId, input.sceneId, now, now);
  }

  updateAutomationSuspension(
    operationId: string,
    automationId: string,
    state: PersistedAutomationSuspension['state'],
    errorCode: string | null = null,
    now = Date.now()
  ): void {
    this.db.prepare(
      `UPDATE home_automation_suspensions
       SET state=?,error_code=?,updated_at_ms=?
       WHERE operation_id=? AND automation_id=?`
    ).run(state, errorCode?.slice(0, 128) ?? null, now, operationId, automationId);
  }

  listRecoverableAutomationSuspensions(staleBeforeMs = Number.MAX_SAFE_INTEGER): PersistedAutomationSuspension[] {
    return this.listAutomationSuspensions().filter((item) =>
      ['pending', 'suspended', 'failed'].includes(item.state)
      && item.updatedAtMs <= staleBeforeMs
    );
  }

  listAutomationSuspensions(): PersistedAutomationSuspension[] {
    return (this.db.prepare(
      `SELECT operation_id,automation_id,entity_id,scene_id,state,error_code,suspended_at_ms,updated_at_ms
       FROM home_automation_suspensions
       ORDER BY suspended_at_ms,automation_id`
    ).all() as Array<{
      operation_id: string;
      automation_id: string;
      entity_id: string;
      scene_id: string;
      state: PersistedAutomationSuspension['state'];
      error_code: string | null;
      suspended_at_ms: number;
      updated_at_ms: number;
    }>).map((row) => ({
      operationId: row.operation_id,
      automationId: row.automation_id,
      entityId: row.entity_id,
      sceneId: row.scene_id,
      state: row.state,
      errorCode: row.error_code,
      suspendedAtMs: row.suspended_at_ms,
      updatedAtMs: row.updated_at_ms,
    }));
  }
}
