import { randomUUID } from 'node:crypto';

import type Database from 'better-sqlite3';

type JsonObject = Record<string, unknown>;

export type ConversationResultSetItem = {
  position: number;
  entityType: string;
  entityId: string;
  displayLabel: string;
  metadata: JsonObject | null;
};

export type ConversationResultSet = {
  id: string;
  threadId: string;
  sourceAgent: string;
  sourceAction: string;
  createdAtMs: number;
  expiresAtMs: number;
  focusedPosition: number | null;
  context: JsonObject | null;
  items: ConversationResultSetItem[];
};

export type ResolvedConversationResult = ConversationResultSetItem & {
  resultSetId: string;
  resultSetContext: JsonObject | null;
};

export type ConversationReferenceResolution =
  | { status: 'resolved'; result: ResolvedConversationResult }
  | { status: 'ambiguous'; resultSetId: string; candidates: ConversationResultSetItem[] }
  | { status: 'not_found'; resultSetId: string }
  | { status: 'expired' }
  | { status: 'not_reference' };

export const MAX_CONVERSATION_RESULT_SET_ITEMS = 20;
const MAX_SET_CONTEXT_BYTES = 16_384;
const MAX_ITEM_METADATA_BYTES = 32_768;

function serializeBounded(value: JsonObject | null | undefined, maxBytes: number): string | null {
  if (!value) return null;
  const json = JSON.stringify(value);
  if (Buffer.byteLength(json, 'utf8') > maxBytes) throw new Error('conversation_result_set_payload_too_large');
  return json;
}

function parseObject(value: unknown): JsonObject | null {
  if (typeof value !== 'string' || !value) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as JsonObject : null;
  } catch {
    return null;
  }
}

function normalizeReference(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/['’_-]+/gu, ' ')
    .replace(/[^a-z0-9\s]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

const REFERENCE_TEXT_PATTERN = /\b(?:celui|celle|lui|elle|premier|premiere|deuxieme|second|seconde|troisieme|quatrieme|cinquieme|dernier|derniere|film|seance|cinema|parmi ceux la|lequel|laquelle|quelle heure|passe ou|c est ou|combien|coute|pitche)\b/u;

export function isConversationResultSetReferenceText(text: string): boolean {
  return REFERENCE_TEXT_PATTERN.test(normalizeReference(text));
}

function containsNormalizedLabel(text: string, label: string): boolean {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  return new RegExp(`(?:^|\\s)${escaped}(?=\\s|$)`, 'u').test(text);
}

function referenceLabels(item: ConversationResultSetItem): string[] {
  const configured = item.metadata?.referenceLabels;
  const labels = Array.isArray(configured)
    ? configured.filter((label): label is string => typeof label === 'string')
    : [];
  return [item.displayLabel, ...labels].map(normalizeReference).filter((label) => label.length >= 2);
}

function toResolved(set: ConversationResultSet, item: ConversationResultSetItem): ResolvedConversationResult {
  return { ...item, resultSetId: set.id, resultSetContext: set.context };
}

export class ConversationResultSetRepository {
  constructor(private readonly db: Database.Database) {}

  create(input: {
    threadId: string;
    sourceAgent: string;
    sourceAction: string;
    context?: JsonObject | null;
    items: Array<Omit<ConversationResultSetItem, 'position' | 'metadata'> & { metadata?: JsonObject | null }>;
    ttlMs?: number;
  }): ConversationResultSet {
    const now = Date.now();
    this.cleanupExpired(now);
    const id = randomUUID();
    const expiresAtMs = now + (input.ttlMs ?? 86_400_000);
    const contextJson = serializeBounded(input.context, MAX_SET_CONTEXT_BYTES);
    const items = input.items.slice(0, MAX_CONVERSATION_RESULT_SET_ITEMS).map((item, index) => ({
      ...item,
      position: index + 1,
      metadata: item.metadata ?? null,
    }));
    const serializedItems = items.map((item) => ({
      ...item,
      metadataJson: serializeBounded(item.metadata, MAX_ITEM_METADATA_BYTES),
    }));

    const transaction = this.db.transaction(() => {
      this.db.prepare('UPDATE conversation_result_sets SET active=0 WHERE thread_id=? AND active=1').run(input.threadId);
      this.db.prepare(`
        INSERT INTO conversation_result_sets(
          id,thread_id,source_agent,source_action,created_at_ms,expires_at_ms,focused_position,active,context_json
        ) VALUES(?,?,?,?,?,?,NULL,1,?)
      `).run(id, input.threadId, input.sourceAgent, input.sourceAction, now, expiresAtMs, contextJson);
      const insert = this.db.prepare(`
        INSERT INTO conversation_result_set_items(
          result_set_id,position,entity_type,entity_id,display_label,metadata_json
        ) VALUES(?,?,?,?,?,?)
      `);
      for (const item of serializedItems) {
        insert.run(id, item.position, item.entityType, item.entityId, item.displayLabel, item.metadataJson);
      }
    });
    transaction();

    return {
      id,
      threadId: input.threadId,
      sourceAgent: input.sourceAgent,
      sourceAction: input.sourceAction,
      createdAtMs: now,
      expiresAtMs,
      focusedPosition: null,
      context: input.context ?? null,
      items,
    };
  }

  cleanupExpired(now = Date.now()): number {
    return this.db.prepare('DELETE FROM conversation_result_sets WHERE expires_at_ms<=?').run(now).changes;
  }

  findActive(threadId: string): ConversationResultSet | null {
    return this.loadActive(threadId);
  }

  resolveReferenceDetailed(threadId: string, text: string): ConversationReferenceResolution {
    const now = Date.now();
    const expired = this.db.prepare(`
      SELECT 1 FROM conversation_result_sets
      WHERE thread_id=? AND active=1 AND expires_at_ms<=?
      LIMIT 1
    `).get(threadId, now);
    this.cleanupExpired(now);
    const set = this.loadActive(threadId);
    if (!set) return expired ? { status: 'expired' } : { status: 'not_reference' };

    const normalized = normalizeReference(text);
    const ordinals: Record<string, number> = {
      premier: 1,
      premiere: 1,
      deuxieme: 2,
      second: 2,
      seconde: 2,
      troisieme: 3,
      quatrieme: 4,
      cinquieme: 5,
    };
    let requestedPosition: number | null = null;
    for (const [word, position] of Object.entries(ordinals)) {
      if (new RegExp(`\\b${word}\\b`, 'u').test(normalized)) {
        requestedPosition = position;
        break;
      }
    }
    if (requestedPosition === null && /\bdernier(?:e)?\b/u.test(normalized)) {
      requestedPosition = set.items.at(-1)?.position ?? null;
    }
    if (requestedPosition !== null) {
      const item = set.items.find((candidate) => candidate.position === requestedPosition);
      return item ? this.resolveAndFocus(set, item) : { status: 'not_found', resultSetId: set.id };
    }

    const focusedFollowUp = /\b(?:et\s+)?(?:lui|elle|celui la|celle la)\b|\bil passe ou\b|\bc est ou\b|\ba quelle heure\b|\bcombien (?:ca )?coute\b|\bpitche?\s+(?:le|la)\s+moi\b|\bet demain\b|\bce cinema\b|\b(?:et\s+)?(?:apres|avant)\b/u.test(normalized);
    if (focusedFollowUp && set.focusedPosition !== null) {
      const item = set.items.find((candidate) => candidate.position === set.focusedPosition);
      return item ? this.resolveAndFocus(set, item) : { status: 'not_found', resultSetId: set.id };
    }

    const refinementExpression = /\b(?:seulement|moins de|apres|avant)\b/u.test(normalized);
    const explicitSelector = /\b(?:celui|celle)\b|\b(?:le film|la seance|ce cinema)\b/u.test(normalized);
    if (refinementExpression && !explicitSelector) return { status: 'not_reference' };

    const scored = set.items.map((item) => {
      const matches = referenceLabels(item).filter((label) => containsNormalizedLabel(normalized, label));
      return { item, score: matches.reduce((total, label) => total + label.length, 0) };
    }).filter(({ score }) => score > 0);
    if (scored.length) {
      const bestScore = Math.max(...scored.map(({ score }) => score));
      const best = scored.filter(({ score }) => score === bestScore).map(({ item }) => item);
      return best.length === 1
        ? this.resolveAndFocus(set, best[0]!)
        : { status: 'ambiguous', resultSetId: set.id, candidates: best.slice(0, 5) };
    }

    const looksLikeReference = isConversationResultSetReferenceText(normalized);
    return looksLikeReference
      ? { status: 'not_found', resultSetId: set.id }
      : { status: 'not_reference' };
  }

  resolveReference(threadId: string, text: string): ResolvedConversationResult | null {
    const resolution = this.resolveReferenceDetailed(threadId, text);
    return resolution.status === 'resolved' ? resolution.result : null;
  }

  private resolveAndFocus(
    set: ConversationResultSet,
    item: ConversationResultSetItem,
  ): { status: 'resolved'; result: ResolvedConversationResult } {
    this.db.prepare('UPDATE conversation_result_sets SET focused_position=? WHERE id=?').run(item.position, set.id);
    return { status: 'resolved', result: toResolved(set, item) };
  }

  private loadActive(threadId: string): ConversationResultSet | null {
    const row = this.db.prepare(`
      SELECT * FROM conversation_result_sets
      WHERE thread_id=? AND active=1 AND expires_at_ms>?
      ORDER BY created_at_ms DESC LIMIT 1
    `).get(threadId, Date.now()) as Record<string, unknown> | undefined;
    if (!row) return null;
    const itemRows = this.db.prepare(`
      SELECT position,entity_type,entity_id,display_label,metadata_json
      FROM conversation_result_set_items WHERE result_set_id=? ORDER BY position
    `).all(row.id) as Array<{
      position: number;
      entity_type: string;
      entity_id: string;
      display_label: string;
      metadata_json: string | null;
    }>;
    return {
      id: String(row.id),
      threadId: String(row.thread_id),
      sourceAgent: String(row.source_agent),
      sourceAction: String(row.source_action),
      createdAtMs: Number(row.created_at_ms),
      expiresAtMs: Number(row.expires_at_ms),
      focusedPosition: row.focused_position === null ? null : Number(row.focused_position),
      context: parseObject(row.context_json),
      items: itemRows.map((item) => ({
        position: item.position,
        entityType: item.entity_type,
        entityId: item.entity_id,
        displayLabel: item.display_label,
        metadata: parseObject(item.metadata_json),
      })),
    };
  }
}
