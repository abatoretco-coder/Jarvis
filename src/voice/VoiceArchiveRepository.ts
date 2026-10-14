import type Database from 'better-sqlite3';

import { getCurrentDataOwnerScope } from '../identity/requestIdentity';

export type VoiceArtifactDirection = 'input' | 'output';

export type VoiceArtifact = {
  voiceTurnId: string;
  direction: VoiceArtifactDirection;
  threadId?: string;
  transcript?: string;
  engineId?: string;
  sourceContentType: string;
  sourceByteLength: number;
  mp3Audio: Buffer;
  latencyMs?: number;
  createdAtMs: number;
};

export class VoiceArchiveRepository {
  constructor(private readonly db: Database.Database) {}

  save(artifact: VoiceArtifact): void {
    const scope = getCurrentDataOwnerScope();
    const ownerUserId = scope.kind === 'user' ? scope.userId : null;
    const ownerServiceId = scope.kind === 'service' ? scope.serviceId : null;
    const linkedThread = artifact.threadId ?? this.findLinkedThread(artifact.voiceTurnId);
    this.db.prepare(`
      INSERT INTO voice_artifacts(
        voice_turn_id,direction,thread_id,owner_user_id,owner_service_id,transcript,
        engine_id,source_content_type,source_byte_length,mp3_audio,mp3_byte_length,
        latency_ms,created_at_ms
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(voice_turn_id,direction) DO UPDATE SET
        thread_id=COALESCE(excluded.thread_id,voice_artifacts.thread_id),
        transcript=COALESCE(excluded.transcript,voice_artifacts.transcript),
        engine_id=COALESCE(excluded.engine_id,voice_artifacts.engine_id),
        source_content_type=excluded.source_content_type,
        source_byte_length=excluded.source_byte_length,
        mp3_audio=excluded.mp3_audio,
        mp3_byte_length=excluded.mp3_byte_length,
        latency_ms=COALESCE(excluded.latency_ms,voice_artifacts.latency_ms)
    `).run(
      artifact.voiceTurnId,
      artifact.direction,
      linkedThread,
      ownerUserId,
      ownerServiceId,
      artifact.transcript ?? null,
      artifact.engineId ?? null,
      artifact.sourceContentType,
      artifact.sourceByteLength,
      artifact.mp3Audio,
      artifact.mp3Audio.length,
      artifact.latencyMs ?? null,
      artifact.createdAtMs
    );
  }

  linkTurn(voiceTurnId: string, threadId: string): number {
    const scope = getCurrentDataOwnerScope();
    const ownerClause = scope.kind === 'user'
      ? 'owner_user_id=? AND owner_service_id IS NULL'
      : scope.kind === 'service'
        ? 'owner_user_id IS NULL AND owner_service_id=?'
        : 'owner_user_id IS NULL AND owner_service_id IS NULL';
    const params = scope.kind === 'user'
      ? [threadId, voiceTurnId, scope.userId]
      : scope.kind === 'service'
        ? [threadId, voiceTurnId, scope.serviceId]
        : [threadId, voiceTurnId];
    return this.db.prepare(
      `UPDATE voice_artifacts SET thread_id=? WHERE voice_turn_id=? AND ${ownerClause}`
    ).run(...params).changes;
  }

  purgeCreatedBefore(cutoffMs: number): number {
    return this.db.prepare('DELETE FROM voice_artifacts WHERE created_at_ms < ?').run(cutoffMs).changes;
  }

  find(voiceTurnId: string, direction: VoiceArtifactDirection): VoiceArtifact | null {
    const row = this.db.prepare(`SELECT voice_turn_id,direction,thread_id,transcript,engine_id,
      source_content_type,source_byte_length,mp3_audio,latency_ms,created_at_ms
      FROM voice_artifacts WHERE voice_turn_id=? AND direction=?`).get(voiceTurnId, direction) as {
        voice_turn_id: string; direction: VoiceArtifactDirection; thread_id: string | null;
        transcript: string | null; engine_id: string | null; source_content_type: string;
        source_byte_length: number; mp3_audio: Buffer; latency_ms: number | null; created_at_ms: number;
      } | undefined;
    return row ? {
      voiceTurnId: row.voice_turn_id,
      direction: row.direction,
      ...(row.thread_id ? { threadId: row.thread_id } : {}),
      ...(row.transcript ? { transcript: row.transcript } : {}),
      ...(row.engine_id ? { engineId: row.engine_id } : {}),
      sourceContentType: row.source_content_type,
      sourceByteLength: row.source_byte_length,
      mp3Audio: row.mp3_audio,
      ...(row.latency_ms === null ? {} : { latencyMs: row.latency_ms }),
      createdAtMs: row.created_at_ms,
    } : null;
  }

  private findLinkedThread(voiceTurnId: string): string | undefined {
    const row = this.db.prepare(
      'SELECT thread_id FROM voice_artifacts WHERE voice_turn_id=? AND thread_id IS NOT NULL LIMIT 1'
    ).get(voiceTurnId) as { thread_id: string } | undefined;
    return row?.thread_id;
  }
}
