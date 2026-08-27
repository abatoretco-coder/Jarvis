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

const MAX_SET_CONTEXT_BYTES = 16_384;
const MAX_ITEM_METADATA_BYTES = 32_768;

function serializeBounded(value: JsonObject | null | undefined, maxBytes: number): string | null {
  if (!value) return null;
  const json = JSON.stringify(value);
  if (Buffer.byteLength(json, 'utf8') > maxBytes) throw new Error('conversation_result_set_context_too_large');
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
    const id = randomUUID();
    const expiresAtMs = now + (input.ttlMs ?? 86_400_000);
    const contextJson = serializeBounded(input.context, MAX_SET_CONTEXT_BYTES);
    const items = input.items.slice(0, 20).map((item, index) => ({
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

  findActive(threadId: string): ConversationResultSet | null {
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

  resolveReference(threadId: string, text: string): ResolvedConversationResult | null {
    const set = this.findActive(threadId);
    if (!set) return null;
    const normalized = text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
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
    let position: number | null = null;
    for (const [word, value] of Object.entries(ordinals)) {
      if (new RegExp(`\\b${word}\\b`, 'u').test(normalized)) {
        position = value;
        break;
      }
    }
    if (position === null && /\b(lui|celui la|celle la|et lui)\b/u.test(normalized)) {
      position = set.focusedPosition;
    }
    if (position === null) return null;
    const item = set.items.find((candidate) => candidate.position === position) ?? null;
    if (!item) return null;
    this.db.prepare('UPDATE conversation_result_sets SET focused_position=? WHERE id=?').run(position, set.id);
    return { ...item, resultSetId: set.id, resultSetContext: set.context };
  }
}
