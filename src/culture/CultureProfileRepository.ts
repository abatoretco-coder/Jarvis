import type Database from 'better-sqlite3';
import { z } from 'zod';

import { resolveTrustedCultureProfileId } from './CultureProfileIdentity';

export const cultureSignalSchema = z.enum([
  'explicit_like',
  'explicit_dislike',
  'save',
  'selection',
  'details',
  'dismiss',
  'query',
]);
export type CultureSignal = z.infer<typeof cultureSignalSchema>;

const weightsSchema = z.record(z.string().min(1).max(100), z.number().min(-20).max(20));
const exclusionsSchema = z.array(z.string().min(1).max(120)).max(100);
const sourceRefSchema = z.object({
  provider: z.string().min(1).max(64),
  externalId: z.string().min(1).max(256),
  sourceUrl: z.string().url().nullable().optional(),
});

export type CultureSourceRef = z.infer<typeof sourceRefSchema>;

export type CulturePreferenceProfile = {
  profileId: string;
  typeWeights: Record<string, number>;
  tagWeights: Record<string, number>;
  venueWeights: Record<string, number>;
  daypartWeights: Record<string, number>;
  weekdayWeights: Record<string, number>;
  priceAffinity: number;
  distanceAffinity: number;
  freeAffinity: number;
  indoorOutdoorAffinity: number;
  explicitExclusions: string[];
  proactiveEnabled: boolean;
  updatedAtMs: number;
};

export type CultureFeedback = {
  id: number;
  profileId: string;
  entityType: string;
  entityId: string;
  signal: CultureSignal;
  strength: number;
  createdAtMs: number;
  metadata: Record<string, unknown>;
};

export type CultureSavedEntity = {
  profileId: string;
  entityType: string;
  entityId: string;
  sourceRefs: CultureSourceRef[];
  title: string;
  categories: string[];
  venue: Record<string, unknown> | null;
  occurrenceDate: string | null;
  metadata: Record<string, unknown>;
  savedAtMs: number;
};

const MAX_FEEDBACK_METADATA_BYTES = 16_384;
const MAX_SAVED_METADATA_BYTES = 32_768;
const MAX_SOURCE_REFS_BYTES = 8_192;
const MAX_FEEDBACK_PER_PROFILE = 2_000;

function parseObject(raw: unknown): Record<string, unknown> {
  if (typeof raw !== 'string' || !raw) return {};
  try {
    const value = JSON.parse(raw) as unknown;
    return value && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function parseWeights(raw: unknown): Record<string, number> {
  const parsed = weightsSchema.safeParse(parseObject(raw));
  return parsed.success ? parsed.data : {};
}

function parseArray(raw: unknown): unknown[] {
  if (typeof raw !== 'string' || !raw) return [];
  try {
    const value = JSON.parse(raw) as unknown;
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

function stringifyBounded(value: unknown, maxBytes: number): string {
  const serialized = JSON.stringify(value ?? {});
  if (Buffer.byteLength(serialized, 'utf8') > maxBytes) throw new Error('culture_profile_payload_too_large');
  return serialized;
}

function clampWeight(value: number): number {
  return Math.max(-20, Math.min(20, Math.round(value * 100) / 100));
}

function mapProfile(row: Record<string, unknown>): CulturePreferenceProfile {
  const exclusions = exclusionsSchema.safeParse(parseArray(row.explicit_exclusions_json));
  return {
    profileId: String(row.profile_id),
    typeWeights: parseWeights(row.type_weights_json),
    tagWeights: parseWeights(row.tag_weights_json),
    venueWeights: parseWeights(row.venue_weights_json),
    daypartWeights: parseWeights(row.daypart_weights_json),
    weekdayWeights: parseWeights(row.weekday_weights_json),
    priceAffinity: Number(row.price_affinity),
    distanceAffinity: Number(row.distance_affinity),
    freeAffinity: Number(row.free_affinity),
    indoorOutdoorAffinity: Number(row.indoor_outdoor_affinity),
    explicitExclusions: exclusions.success ? exclusions.data : [],
    proactiveEnabled: Number(row.proactive_enabled) === 1,
    updatedAtMs: Number(row.updated_at_ms),
  };
}

function mapSaved(row: Record<string, unknown>): CultureSavedEntity {
  const refs = z.array(sourceRefSchema).max(20).safeParse(parseArray(row.source_refs_json));
  const categories = z.array(z.string()).max(50).safeParse(parseArray(row.categories_json));
  return {
    profileId: String(row.profile_id),
    entityType: String(row.entity_type),
    entityId: String(row.entity_id),
    sourceRefs: refs.success ? refs.data : [],
    title: String(row.title),
    categories: categories.success ? categories.data : [],
    venue: row.venue_json ? parseObject(row.venue_json) : null,
    occurrenceDate: typeof row.occurrence_date === 'string' ? row.occurrence_date : null,
    metadata: parseObject(row.metadata_json),
    savedAtMs: Number(row.saved_at_ms),
  };
}

export class CultureProfileRepository {
  constructor(private readonly db: Database.Database, private readonly feedbackRetentionDays = 730) {}

  getProfile(profileId: string): CulturePreferenceProfile {
    this.ensureProfile(profileId);
    const row = this.db.prepare('SELECT * FROM culture_preference_profiles WHERE profile_id=?').get(profileId) as Record<string, unknown>;
    return mapProfile(row);
  }

  updatePreferences(profileId: string, changes: {
    typeWeights?: Record<string, number>;
    tagWeights?: Record<string, number>;
    venueWeights?: Record<string, number>;
    daypartWeights?: Record<string, number>;
    weekdayWeights?: Record<string, number>;
    priceAffinityDelta?: number;
    distanceAffinityDelta?: number;
    freeAffinityDelta?: number;
    indoorOutdoorAffinityDelta?: number;
    addExclusions?: string[];
    removeExclusions?: string[];
  }): CulturePreferenceProfile {
    const current = this.getProfile(profileId);
    const mergeWeights = (base: Record<string, number>, delta: Record<string, number> | undefined) => {
      const merged = { ...base };
      for (const [key, value] of Object.entries(delta ?? {})) {
        const normalizedKey = key.trim().toLowerCase();
        if (!normalizedKey) continue;
        merged[normalizedKey] = clampWeight((merged[normalizedKey] ?? 0) + value);
        if (Math.abs(merged[normalizedKey]) < 0.01) delete merged[normalizedKey];
      }
      return weightsSchema.parse(merged);
    };
    const removals = new Set((changes.removeExclusions ?? []).map((value) => value.toLowerCase()));
    const exclusions = [...new Set([
      ...current.explicitExclusions.filter((value) => !removals.has(value.toLowerCase())),
      ...(changes.addExclusions ?? []).map((value) => value.trim().toLowerCase()).filter(Boolean),
    ])].slice(0, 100);
    const next = {
      typeWeights: mergeWeights(current.typeWeights, changes.typeWeights),
      tagWeights: mergeWeights(current.tagWeights, changes.tagWeights),
      venueWeights: mergeWeights(current.venueWeights, changes.venueWeights),
      daypartWeights: mergeWeights(current.daypartWeights, changes.daypartWeights),
      weekdayWeights: mergeWeights(current.weekdayWeights, changes.weekdayWeights),
      priceAffinity: clampWeight(current.priceAffinity + (changes.priceAffinityDelta ?? 0)),
      distanceAffinity: clampWeight(current.distanceAffinity + (changes.distanceAffinityDelta ?? 0)),
      freeAffinity: clampWeight(current.freeAffinity + (changes.freeAffinityDelta ?? 0)),
      indoorOutdoorAffinity: clampWeight(current.indoorOutdoorAffinity + (changes.indoorOutdoorAffinityDelta ?? 0)),
      exclusions,
    };
    this.db.prepare(`
      UPDATE culture_preference_profiles SET
        type_weights_json=?, tag_weights_json=?, venue_weights_json=?, daypart_weights_json=?, weekday_weights_json=?,
        price_affinity=?, distance_affinity=?, free_affinity=?, indoor_outdoor_affinity=?, explicit_exclusions_json=?, updated_at_ms=?
      WHERE profile_id=?
    `).run(
      JSON.stringify(next.typeWeights), JSON.stringify(next.tagWeights), JSON.stringify(next.venueWeights),
      JSON.stringify(next.daypartWeights), JSON.stringify(next.weekdayWeights), next.priceAffinity,
      next.distanceAffinity, next.freeAffinity, next.indoorOutdoorAffinity, JSON.stringify(next.exclusions),
      Date.now(), profileId,
    );
    return this.getProfile(profileId);
  }

  setProactiveEnabled(profileId: string, enabled: boolean): CulturePreferenceProfile {
    this.ensureProfile(profileId);
    this.db.prepare('UPDATE culture_preference_profiles SET proactive_enabled=?, updated_at_ms=? WHERE profile_id=?')
      .run(enabled ? 1 : 0, Date.now(), profileId);
    return this.getProfile(profileId);
  }

  recordFeedback(input: Omit<CultureFeedback, 'id' | 'createdAtMs'> & { createdAtMs?: number }): CultureFeedback {
    this.ensureProfile(input.profileId);
    const createdAtMs = input.createdAtMs ?? Date.now();
    const metadataJson = stringifyBounded(input.metadata, MAX_FEEDBACK_METADATA_BYTES);
    const result = this.db.prepare(`
      INSERT INTO culture_feedback(profile_id,entity_type,entity_id,signal,strength,created_at_ms,metadata_json)
      VALUES(?,?,?,?,?,?,?)
    `).run(
      input.profileId, input.entityType, input.entityId, cultureSignalSchema.parse(input.signal),
      clampWeight(input.strength), createdAtMs, metadataJson,
    );
    this.cleanupFeedback(input.profileId, createdAtMs);
    return { ...input, id: Number(result.lastInsertRowid), createdAtMs };
  }

  listFeedback(profileId: string, limit = MAX_FEEDBACK_PER_PROFILE): CultureFeedback[] {
    const rows = this.db.prepare(`
      SELECT id,profile_id,entity_type,entity_id,signal,strength,created_at_ms,metadata_json
      FROM culture_feedback WHERE profile_id=? ORDER BY created_at_ms DESC LIMIT ?
    `).all(profileId, Math.min(MAX_FEEDBACK_PER_PROFILE, Math.max(1, limit))) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      id: Number(row.id),
      profileId: String(row.profile_id),
      entityType: String(row.entity_type),
      entityId: String(row.entity_id),
      signal: cultureSignalSchema.parse(row.signal),
      strength: Number(row.strength),
      createdAtMs: Number(row.created_at_ms),
      metadata: parseObject(row.metadata_json),
    }));
  }

  forgetPreference(
    profileId: string,
    preference: { kind: 'type' | 'tag' | 'venue' | 'entity'; key: string },
  ): number {
    const normalized = preference.key.trim().toLowerCase();
    if (!normalized) return 0;
    const transaction = this.db.transaction((): number => {
      const profile = this.getProfile(profileId);
      this.updatePreferences(profileId, {
        typeWeights: preference.kind === 'type' ? { [normalized]: -(profile.typeWeights[normalized] ?? 0) } : undefined,
        tagWeights: preference.kind === 'tag' ? { [normalized]: -(profile.tagWeights[normalized] ?? 0) } : undefined,
        venueWeights: preference.kind === 'venue' ? { [normalized]: -(profile.venueWeights[normalized] ?? 0) } : undefined,
        removeExclusions: [`${preference.kind}:${normalized}`],
      });
      const ids = this.listFeedback(profileId).filter((feedback) => {
        const type = typeof feedback.metadata.type === 'string' ? feedback.metadata.type.toLowerCase() : '';
        const venueId = typeof feedback.metadata.venueId === 'string' ? feedback.metadata.venueId.toLowerCase() : '';
        const categories = Array.isArray(feedback.metadata.categories)
          ? feedback.metadata.categories.filter((value): value is string => typeof value === 'string').map((value) => value.toLowerCase())
          : [];
        if (preference.kind === 'entity') return feedback.entityId.toLowerCase() === normalized;
        if (preference.kind === 'type') return type === normalized;
        if (preference.kind === 'venue') return venueId === normalized;
        return categories.includes(normalized);
      }).map((feedback) => feedback.id);
      const remove = this.db.prepare('DELETE FROM culture_feedback WHERE profile_id=? AND id=?');
      for (const id of ids) remove.run(profileId, id);
      return ids.length;
    });
    return transaction();
  }

  saveEntity(entity: Omit<CultureSavedEntity, 'savedAtMs'> & { savedAtMs?: number }): CultureSavedEntity {
    this.ensureProfile(entity.profileId);
    const savedAtMs = entity.savedAtMs ?? Date.now();
    const refs = z.array(sourceRefSchema).max(20).parse(entity.sourceRefs);
    const categories = z.array(z.string().max(100)).max(50).parse(entity.categories);
    this.db.prepare(`
      INSERT INTO culture_saved_entities(
        profile_id,entity_type,entity_id,source_refs_json,title,categories_json,venue_json,occurrence_date,metadata_json,saved_at_ms
      ) VALUES(?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(profile_id,entity_type,entity_id) DO UPDATE SET
        source_refs_json=excluded.source_refs_json,title=excluded.title,categories_json=excluded.categories_json,
        venue_json=excluded.venue_json,occurrence_date=excluded.occurrence_date,metadata_json=excluded.metadata_json,
        saved_at_ms=excluded.saved_at_ms
    `).run(
      entity.profileId, entity.entityType, entity.entityId,
      stringifyBounded(refs, MAX_SOURCE_REFS_BYTES), entity.title.trim().slice(0, 500), JSON.stringify(categories),
      entity.venue ? stringifyBounded(entity.venue, MAX_FEEDBACK_METADATA_BYTES) : null,
      entity.occurrenceDate, stringifyBounded(entity.metadata, MAX_SAVED_METADATA_BYTES), savedAtMs,
    );
    return this.getSavedEntity(entity.profileId, entity.entityType, entity.entityId)!;
  }

  getSavedEntity(profileId: string, entityType: string, entityId: string): CultureSavedEntity | null {
    const row = this.db.prepare(`
      SELECT * FROM culture_saved_entities WHERE profile_id=? AND entity_type=? AND entity_id=?
    `).get(profileId, entityType, entityId) as Record<string, unknown> | undefined;
    return row ? mapSaved(row) : null;
  }

  listSaved(profileId: string, limit = 100): CultureSavedEntity[] {
    const rows = this.db.prepare(`
      SELECT * FROM culture_saved_entities WHERE profile_id=? ORDER BY saved_at_ms DESC LIMIT ?
    `).all(profileId, Math.min(100, Math.max(1, limit))) as Array<Record<string, unknown>>;
    return rows.map(mapSaved);
  }

  removeSaved(profileId: string, entityType: string, entityId: string): boolean {
    return this.db.prepare(`
      DELETE FROM culture_saved_entities WHERE profile_id=? AND entity_type=? AND entity_id=?
    `).run(profileId, entityType, entityId).changes > 0;
  }

  resetProfile(profileId: string): void {
    const transaction = this.db.transaction(() => {
      this.db.prepare('DELETE FROM culture_feedback WHERE profile_id=?').run(profileId);
      this.db.prepare('DELETE FROM culture_saved_entities WHERE profile_id=?').run(profileId);
      this.db.prepare('DELETE FROM culture_proactive_notifications WHERE profile_id=?').run(profileId);
      this.db.prepare('DELETE FROM culture_preference_profiles WHERE profile_id=?').run(profileId);
    });
    transaction();
  }

  lastNotificationAt(profileId: string): number | null {
    const row = this.db.prepare(`
      SELECT MAX(notified_at_ms) AS notified_at_ms FROM culture_proactive_notifications WHERE profile_id=?
    `).get(profileId) as { notified_at_ms: number | null };
    return row.notified_at_ms === null ? null : Number(row.notified_at_ms);
  }

  wasNotified(profileId: string, fingerprint: string): boolean {
    return Boolean(this.db.prepare(`
      SELECT 1 FROM culture_proactive_notifications WHERE profile_id=? AND fingerprint=?
    `).get(profileId, fingerprint));
  }

  recordNotification(input: {
    profileId: string;
    entityType: string;
    entityId: string;
    fingerprint: string;
    reason: string;
    notifiedAtMs?: number;
  }): boolean {
    const notifiedAtMs = input.notifiedAtMs ?? Date.now();
    const transaction = this.db.transaction(() => {
      const result = this.db.prepare(`
        INSERT OR IGNORE INTO culture_proactive_notifications(
          profile_id,entity_type,entity_id,fingerprint,reason,notified_at_ms
        ) VALUES(?,?,?,?,?,?)
      `).run(
        input.profileId, input.entityType, input.entityId, input.fingerprint,
        input.reason.slice(0, 500), notifiedAtMs,
      );
      const cutoff = notifiedAtMs - this.feedbackRetentionDays * 86_400_000;
      this.db.prepare('DELETE FROM culture_proactive_notifications WHERE profile_id=? AND notified_at_ms<?')
        .run(input.profileId, cutoff);
      this.db.prepare(`
        DELETE FROM culture_proactive_notifications WHERE profile_id=? AND fingerprint NOT IN (
          SELECT fingerprint FROM culture_proactive_notifications
          WHERE profile_id=? ORDER BY notified_at_ms DESC LIMIT 2000
        )
      `).run(input.profileId, input.profileId);
      return result.changes > 0;
    });
    return transaction();
  }

  exportProfile(profileId: string): Record<string, unknown> {
    return {
      profile: this.getProfile(profileId),
      savedEntities: this.listSaved(profileId),
      feedback: this.listFeedback(profileId),
    };
  }

  private ensureProfile(profileId: string): void {
    resolveTrustedCultureProfileId(profileId, profileId);
    this.db.prepare(`
      INSERT OR IGNORE INTO culture_preference_profiles(profile_id,updated_at_ms) VALUES(?,?)
    `).run(profileId, Date.now());
  }

  private cleanupFeedback(profileId: string, nowMs: number): void {
    const cutoff = nowMs - this.feedbackRetentionDays * 86_400_000;
    this.db.prepare('DELETE FROM culture_feedback WHERE profile_id=? AND created_at_ms<?').run(profileId, cutoff);
    this.db.prepare(`
      DELETE FROM culture_feedback WHERE profile_id=? AND id NOT IN (
        SELECT id FROM culture_feedback WHERE profile_id=? ORDER BY created_at_ms DESC LIMIT ?
      )
    `).run(profileId, profileId, MAX_FEEDBACK_PER_PROFILE);
  }
}
