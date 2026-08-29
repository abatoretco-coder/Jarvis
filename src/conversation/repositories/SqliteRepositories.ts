import fs from 'node:fs';
import path from 'node:path';

import Database from 'better-sqlite3';

import type { MessageRecord, MessageRepository, MessageRole } from './MessageRepository';
import type { CommitCandidateResult, SummaryStatus, ThreadListItem, ThreadRecord, ThreadRepository } from './ThreadRepository';

function normalizeContent(content: string): string {
  return String(content ?? '')
    .replace(/\0/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function buildConversationTitle(content: string): string {
  const normalized = normalizeContent(content)
    .replace(/^(?:ok\s+)?(?:jarvis|jervis|charvis)\b[\s,;:!.-]*/i, '')
    .replace(/^(bonjour|bonsoir|salut|hello|hey)\b[\s,;:!-]*/i, '')
    .replace(/^(?:est[\s-]*ce que\s+)?tu\s+(?:peux|pourrais)\s+(?:me\s+)?/i, '')
    .replace(/^(?:peux|pourrais)[\s-]*tu\s+(?:me\s+)?/i, '')
    .replace(
      /^(?:je\s+)?(?:voudrais|veux|souhaite|j'aimerais)\s+|^merci de\s+|^(?:donne|mets|remets|coupe)[\s-]*(?:moi|nous)?\s*/i,
      '',
    )
    .replace(/[\s,;:!.-]*(?:s['’]il te pla[iî]t|merci)\s*$/i, '')
    .replace(/^[\s,;:!?.-]+/, '')
    .replace(/[?.!]+$/g, '')
    .trim();
  if (!normalized) return 'Nouvelle conversation';

  const firstSentence = normalized.split(/[.!?]\s/)[0]?.trim() || normalized;
  const words = firstSentence.split(/\s+/).filter(Boolean);
  let title = '';
  for (const word of words) {
    const candidate = title ? `${title} ${word}` : word;
    if (candidate.length > 52) break;
    title = candidate;
    if (title.split(/\s+/).length >= 7) break;
  }
  title = title || firstSentence.slice(0, 52).trim();
  return title.charAt(0).toLocaleUpperCase('fr-FR') + title.slice(1);
}

function assertSummaryStatus(value: string): SummaryStatus {
  if (value === 'idle' || value === 'running' || value === 'ready' || value === 'failed') {
    return value;
  }
  return 'idle';
}

export class SqliteThreadRepository implements ThreadRepository {
  constructor(private readonly db: Database.Database) {}

  async findById(threadId: string): Promise<ThreadRecord | null> {
    const row = this.db
      .prepare(
        `SELECT thread_id, channel, title, summary, summary_upto_seq, summary_version,
                summary_candidate, summary_candidate_upto_seq, summary_status,
                interaction_count, last_response_time_ms, conversation_window_expires_at_ms
         FROM conversation_threads
         WHERE thread_id = ?`,
      )
      .get(threadId) as
      | {
          thread_id: string;
          channel: string | null;
          title: string;
          summary: string;
          summary_upto_seq: number;
          summary_version: number;
          summary_candidate: string | null;
          summary_candidate_upto_seq: number | null;
          summary_status: string;
          interaction_count: number;
          last_response_time_ms: number;
          conversation_window_expires_at_ms: number;
        }
      | undefined;

    if (!row) return null;
    return {
      threadId: row.thread_id,
      channel: row.channel,
      title: row.title ?? '',
      summary: row.summary ?? '',
      summaryUptoSeq: Number(row.summary_upto_seq ?? 0),
      summaryVersion: Number(row.summary_version ?? 0),
      summaryCandidate: row.summary_candidate,
      summaryCandidateUptoSeq: row.summary_candidate_upto_seq === null ? null : Number(row.summary_candidate_upto_seq),
      summaryStatus: assertSummaryStatus(row.summary_status),
      interactionCount: Number(row.interaction_count ?? 0),
      lastResponseTimeMs: Number(row.last_response_time_ms ?? 0),
      conversationWindowExpiresAtMs: Number(row.conversation_window_expires_at_ms ?? 0),
    };
  }

  async getOrCreate(threadId: string, options?: { channel?: string | null }): Promise<ThreadRecord> {
    const now = Date.now();
    const incomingChannel = typeof options?.channel === 'string' ? options.channel.trim() : '';
    this.db
      .prepare(
        `INSERT INTO conversation_threads (
          thread_id, channel, title, summary, summary_upto_seq, summary_version, summary_candidate, summary_candidate_upto_seq, summary_status, interaction_count, created_at_ms, updated_at_ms
        ) VALUES (?, ?, '', '', 0, 0, NULL, NULL, 'idle', 0, ?, ?)
        ON CONFLICT(thread_id) DO NOTHING`
      )
      .run(threadId, incomingChannel || null, now, now);

    if (incomingChannel) {
      this.db
        .prepare("UPDATE conversation_threads SET channel = ?, updated_at_ms = ? WHERE thread_id = ? AND (channel IS NULL OR channel = '' OR channel <> ?)")
        .run(incomingChannel, now, threadId, incomingChannel);
    }

    const row = await this.findById(threadId);
    if (!row) {
      throw new Error(`Thread not found after create: ${threadId}`);
    }
    return row;
  }

  async incrementInteractionCount(threadId: string): Promise<number> {
    await this.getOrCreate(threadId);
    this.db
      .prepare('UPDATE conversation_threads SET interaction_count = interaction_count + 1, updated_at_ms = ? WHERE thread_id = ?')
      .run(Date.now(), threadId);
    const row = this.db
      .prepare('SELECT interaction_count FROM conversation_threads WHERE thread_id = ?')
      .get(threadId) as { interaction_count: number };
    return Number(row.interaction_count);
  }

  async tryStartSummary(threadId: string): Promise<boolean> {
    await this.getOrCreate(threadId);
    const now = Date.now();
    const res = this.db
      .prepare(
        `UPDATE conversation_threads
         SET summary_status = 'running', updated_at_ms = ?
         WHERE thread_id = ? AND summary_status IN ('idle', 'failed')`
      )
      .run(now, threadId);
    return res.changes > 0;
  }

  async markSummaryCandidateReady(threadId: string, candidate: string, uptoSeq: number): Promise<void> {
    await this.getOrCreate(threadId);
    this.db
      .prepare(
        `UPDATE conversation_threads
         SET summary_candidate = ?,
             summary_candidate_upto_seq = ?,
             summary_status = 'ready',
             summary_last_error = NULL,
             updated_at_ms = ?
         WHERE thread_id = ?`
      )
      .run(candidate, uptoSeq, Date.now(), threadId);
  }

  async markSummaryFailed(threadId: string, reason: string): Promise<void> {
    await this.getOrCreate(threadId);
    this.db
      .prepare(
        `UPDATE conversation_threads
         SET summary_status = 'failed',
             summary_last_error = ?,
             updated_at_ms = ?
         WHERE thread_id = ?`
      )
      .run(reason.slice(0, 500), Date.now(), threadId);
  }

  async resetSummaryStatus(threadId: string): Promise<void> {
    await this.getOrCreate(threadId);
    this.db
      .prepare(
        `UPDATE conversation_threads
         SET summary_status = 'idle',
             updated_at_ms = ?
         WHERE thread_id = ?`
      )
      .run(Date.now(), threadId);
  }

  async commitCandidateIfReady(threadId: string): Promise<CommitCandidateResult> {
    await this.getOrCreate(threadId);
    const now = Date.now();

    const tx = this.db.transaction(() => {
      const row = this.db
        .prepare(
          `SELECT summary_candidate, summary_candidate_upto_seq, summary_status, summary_version
           FROM conversation_threads
           WHERE thread_id = ?`
        )
        .get(threadId) as {
        summary_candidate: string | null;
        summary_candidate_upto_seq: number | null;
        summary_status: string;
        summary_version: number;
      };

      if (row.summary_status !== 'ready' || !row.summary_candidate || row.summary_candidate_upto_seq === null) {
        return { committed: false } as CommitCandidateResult;
      }

      const nextVersion = Number(row.summary_version ?? 0) + 1;
      this.db
        .prepare(
          `UPDATE conversation_threads
           SET summary = ?,
               summary_upto_seq = ?,
               summary_version = ?,
               summary_candidate = NULL,
               summary_candidate_upto_seq = NULL,
               summary_status = 'idle',
               summary_last_error = NULL,
               updated_at_ms = ?
           WHERE thread_id = ?`
        )
        .run(row.summary_candidate, row.summary_candidate_upto_seq, nextVersion, now, threadId);

      return { committed: true, usedSummaryVersion: `v${nextVersion}` } as CommitCandidateResult;
    });

    return tx();
  }

  async updateTitle(threadId: string, title: string): Promise<void> {
    const normalized = normalizeContent(title).slice(0, 80);
    if (!normalized) return;
    await this.getOrCreate(threadId);
    this.db
      .prepare("UPDATE conversation_threads SET title = ?, title_source = 'ai' WHERE thread_id = ?")
      .run(normalized, threadId);
  }

  async listRecent(limit: number, options?: { channel?: string | null }): Promise<ThreadListItem[]> {
    const safeLimit = Math.max(1, Math.min(limit, 200));
    const filterChannel = typeof options?.channel === 'string' ? options.channel.trim() : '';
    const selectSql = filterChannel
      ? `SELECT
          t.thread_id,
          t.channel,
          t.title,
          t.title_source,
          t.summary,
          t.updated_at_ms,
          (SELECT m.content FROM conversation_messages m WHERE m.thread_id = t.thread_id AND m.role = 'user' ORDER BY m.seq ASC LIMIT 1) as first_user_content,
          (SELECT COUNT(*) FROM conversation_messages m WHERE m.thread_id = t.thread_id) as message_count
         FROM conversation_threads t
         WHERE t.channel = ?
         ORDER BY t.updated_at_ms DESC
         LIMIT ?`
      : `SELECT
          t.thread_id,
          t.channel,
          t.title,
          t.title_source,
          t.summary,
          t.updated_at_ms,
          (SELECT m.content FROM conversation_messages m WHERE m.thread_id = t.thread_id AND m.role = 'user' ORDER BY m.seq ASC LIMIT 1) as first_user_content,
          (SELECT COUNT(*) FROM conversation_messages m WHERE m.thread_id = t.thread_id) as message_count
         FROM conversation_threads t
         ORDER BY t.updated_at_ms DESC
         LIMIT ?`;

    const rows = this.db
      .prepare(selectSql)
      .all(...(filterChannel ? [filterChannel, safeLimit] : [safeLimit])) as Array<{
      thread_id: string;
      channel: string | null;
      title: string;
      title_source: string;
      summary: string;
      updated_at_ms: number;
      first_user_content: string | null;
      message_count: number;
    }>;

    return rows.map((row) => {
      const title =
        row.title_source === 'ai'
          ? row.title
          : row.first_user_content
            ? buildConversationTitle(row.first_user_content)
            : row.title || '';
      if (title && row.title_source !== 'ai' && row.title !== title) {
        this.db
          .prepare("UPDATE conversation_threads SET title = ?, title_source = 'heuristic' WHERE thread_id = ?")
          .run(title, row.thread_id);
      }
      return {
        threadId: row.thread_id,
        channel: row.channel,
        title,
        summary: row.summary || `Conversation ${row.thread_id.slice(-8)}`,
        lastActivityMs: Number(row.updated_at_ms),
        messageCount: Number(row.message_count),
      };
    });
  }

  async deleteThread(threadId: string): Promise<boolean> {
    const result = this.db.prepare('DELETE FROM conversation_threads WHERE thread_id = ?').run(threadId);
    return result.changes > 0;
  }

  async purgeThreadsOlderThan(cutoffMs: number): Promise<number> {
    const safeCutoff = Math.max(0, Math.floor(cutoffMs));
    const result = this.db.prepare('DELETE FROM conversation_threads WHERE updated_at_ms < ?').run(safeCutoff);
    return Number(result.changes ?? 0);
  }

  async updateResponseTime(threadId: string, responseTimeMs: number): Promise<void> {
    const nowMs = Date.now();
    const windowExpiresAtMs = nowMs + 10000; // Fenêtre de 10 secondes
    this.db
      .prepare(
        `UPDATE conversation_threads 
         SET last_response_time_ms = ?, conversation_window_expires_at_ms = ?, updated_at_ms = ? 
         WHERE thread_id = ?`
      )
      .run(responseTimeMs, windowExpiresAtMs, nowMs, threadId);
  }

  async getActiveConversationThread(channel?: string | null): Promise<ThreadRecord | null> {
    const nowMs = Date.now();
    const channelFilter = typeof channel === 'string' ? channel.trim() : '';
    
    const row = this.db
      .prepare(
        `SELECT thread_id, channel, title, summary, summary_upto_seq, summary_version, summary_candidate, summary_candidate_upto_seq, summary_status, interaction_count, last_response_time_ms, conversation_window_expires_at_ms
         FROM conversation_threads
         WHERE conversation_window_expires_at_ms > ? AND (? = '' OR channel = ?)
         ORDER BY conversation_window_expires_at_ms DESC
         LIMIT 1`
      )
      .get(nowMs, channelFilter, channelFilter) as
      | {
          thread_id: string;
          channel: string | null;
          title: string;
          summary: string;
          summary_upto_seq: number;
          summary_version: number;
          summary_candidate: string | null;
          summary_candidate_upto_seq: number | null;
          summary_status: string;
          interaction_count: number;
          last_response_time_ms: number;
          conversation_window_expires_at_ms: number;
        }
      | undefined;

    if (!row) {
      return null;
    }

    return {
      threadId: row.thread_id,
      channel: row.channel,
      title: row.title ?? '',
      summary: row.summary ?? '',
      summaryUptoSeq: Number(row.summary_upto_seq ?? 0),
      summaryVersion: Number(row.summary_version ?? 0),
      summaryCandidate: row.summary_candidate,
      summaryCandidateUptoSeq: row.summary_candidate_upto_seq === null ? null : Number(row.summary_candidate_upto_seq),
      summaryStatus: assertSummaryStatus(row.summary_status),
      interactionCount: Number(row.interaction_count ?? 0),
      lastResponseTimeMs: Number(row.last_response_time_ms ?? 0),
      conversationWindowExpiresAtMs: Number(row.conversation_window_expires_at_ms ?? 0),
    };
  }
}

export class SqliteMessageRepository implements MessageRepository {
  constructor(private readonly db: Database.Database) {}

  async appendMessage(input: { threadId: string; role: MessageRole; content: string; createdAtMs?: number }): Promise<number> {
    const normalized = normalizeContent(input.content);
    if (!normalized) {
      return 0;
    }

    const now = input.createdAtMs ?? Date.now();
    const tx = this.db.transaction(() => {
      const row = this.db
        .prepare('SELECT COALESCE(MAX(seq), 0) AS max_seq FROM conversation_messages WHERE thread_id = ?')
        .get(input.threadId) as { max_seq: number };
      const nextSeq = Number(row.max_seq) + 1;
      this.db
        .prepare(
          `INSERT INTO conversation_messages (thread_id, seq, role, content, created_at_ms)
           VALUES (?, ?, ?, ?, ?)`
        )
        .run(input.threadId, nextSeq, input.role, normalized, now);
      if (input.role === 'user') {
        this.db
          .prepare(
            `UPDATE conversation_threads
             SET title = ?, title_source = 'heuristic', updated_at_ms = ?
             WHERE thread_id = ? AND (title IS NULL OR trim(title) = '')`
          )
          .run(buildConversationTitle(normalized), now, input.threadId);
      }
      return nextSeq;
    });

    return tx();
  }

  async getRecentMessages(threadId: string, limit: number): Promise<MessageRecord[]> {
    const rows = this.db
      .prepare(
        `SELECT thread_id, seq, role, content, created_at_ms
         FROM conversation_messages
         WHERE thread_id = ?
         ORDER BY seq DESC
         LIMIT ?`
      )
      .all(threadId, Math.max(1, limit)) as Array<{
      thread_id: string;
      seq: number;
      role: MessageRole;
      content: string;
      created_at_ms: number;
    }>;

    return rows
      .reverse()
      .map((row) => ({
        threadId: row.thread_id,
        seq: Number(row.seq),
        role: row.role,
        content: row.content,
        createdAtMs: Number(row.created_at_ms),
      }));
  }

  async getMessagesAfterSeq(threadId: string, afterExclusiveSeq: number, limit: number): Promise<MessageRecord[]> {
    const rows = this.db
      .prepare(
        `SELECT thread_id, seq, role, content, created_at_ms
         FROM conversation_messages
         WHERE thread_id = ? AND seq > ?
         ORDER BY seq ASC
         LIMIT ?`
      )
      .all(threadId, Math.max(0, afterExclusiveSeq), Math.max(1, limit)) as Array<{
      thread_id: string;
      seq: number;
      role: MessageRole;
      content: string;
      created_at_ms: number;
    }>;

    return rows.map((row) => ({
      threadId: row.thread_id,
      seq: Number(row.seq),
      role: row.role,
      content: row.content,
      createdAtMs: Number(row.created_at_ms),
    }));
  }

  async getMessagesRange(threadId: string, fromExclusiveSeq: number, toInclusiveSeq: number): Promise<MessageRecord[]> {
    const rows = this.db
      .prepare(
        `SELECT thread_id, seq, role, content, created_at_ms
         FROM conversation_messages
         WHERE thread_id = ? AND seq > ? AND seq <= ?
         ORDER BY seq ASC`
      )
      .all(threadId, fromExclusiveSeq, toInclusiveSeq) as Array<{
      thread_id: string;
      seq: number;
      role: MessageRole;
      content: string;
      created_at_ms: number;
    }>;

    return rows.map((row) => ({
      threadId: row.thread_id,
      seq: Number(row.seq),
      role: row.role,
      content: row.content,
      createdAtMs: Number(row.created_at_ms),
    }));
  }

  async getMaxSeq(threadId: string): Promise<number> {
    const row = this.db
      .prepare('SELECT COALESCE(MAX(seq), 0) AS max_seq FROM conversation_messages WHERE thread_id = ?')
      .get(threadId) as { max_seq: number };
    return Number(row.max_seq ?? 0);
  }
}

export function createConversationDb(dbPath: string): Database.Database {
  const dir = path.dirname(dbPath);
  fs.mkdirSync(dir, { recursive: true });

  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE IF NOT EXISTS conversation_threads (
      thread_id TEXT PRIMARY KEY,
      channel TEXT,
      title TEXT NOT NULL DEFAULT '',
      title_source TEXT NOT NULL DEFAULT 'heuristic',
      summary TEXT NOT NULL DEFAULT '',
      summary_upto_seq INTEGER NOT NULL DEFAULT 0,
      summary_version INTEGER NOT NULL DEFAULT 0,
      summary_candidate TEXT,
      summary_candidate_upto_seq INTEGER,
      summary_status TEXT NOT NULL DEFAULT 'idle' CHECK (summary_status IN ('idle','running','ready','failed')),
      summary_last_error TEXT,
      interaction_count INTEGER NOT NULL DEFAULT 0,
      created_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS conversation_messages (
      thread_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('user','assistant')),
      content TEXT NOT NULL,
      created_at_ms INTEGER NOT NULL,
      PRIMARY KEY (thread_id, seq),
      FOREIGN KEY(thread_id) REFERENCES conversation_threads(thread_id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_conversation_messages_thread_seq
      ON conversation_messages(thread_id, seq DESC);

    CREATE INDEX IF NOT EXISTS idx_conversation_threads_updated_at
      ON conversation_threads(updated_at_ms DESC);

    CREATE TABLE IF NOT EXISTS pending_mutations (
      proposal_id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      client_channel TEXT,
      agent TEXT NOT NULL,
      action TEXT NOT NULL,
      effect TEXT NOT NULL,
      route_key TEXT,
      preview TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending','executing','executed','failed','cancelled')),
      expires_at_ms INTEGER NOT NULL,
      created_at_ms INTEGER NOT NULL,
      executed_at_ms INTEGER,
      FOREIGN KEY(thread_id) REFERENCES conversation_threads(thread_id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_pending_mutations_thread_status
      ON pending_mutations(thread_id, status, expires_at_ms DESC);

    CREATE TABLE IF NOT EXISTS conversation_result_sets (
      id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      source_agent TEXT NOT NULL,
      source_action TEXT NOT NULL,
      created_at_ms INTEGER NOT NULL,
      expires_at_ms INTEGER NOT NULL,
      focused_position INTEGER,
      active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
      context_json TEXT,
      FOREIGN KEY(thread_id) REFERENCES conversation_threads(thread_id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS conversation_result_set_items (
      result_set_id TEXT NOT NULL,
      position INTEGER NOT NULL CHECK (position > 0),
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      display_label TEXT NOT NULL,
      metadata_json TEXT,
      PRIMARY KEY(result_set_id, position),
      FOREIGN KEY(result_set_id) REFERENCES conversation_result_sets(id) ON DELETE CASCADE
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_conversation_result_sets_active_thread
      ON conversation_result_sets(thread_id) WHERE active = 1;

    CREATE INDEX IF NOT EXISTS idx_conversation_result_sets_expiry
      ON conversation_result_sets(thread_id, expires_at_ms DESC);

    CREATE TABLE IF NOT EXISTS culture_preference_profiles (
      profile_id TEXT PRIMARY KEY,
      type_weights_json TEXT NOT NULL DEFAULT '{}',
      tag_weights_json TEXT NOT NULL DEFAULT '{}',
      venue_weights_json TEXT NOT NULL DEFAULT '{}',
      daypart_weights_json TEXT NOT NULL DEFAULT '{}',
      weekday_weights_json TEXT NOT NULL DEFAULT '{}',
      price_affinity REAL NOT NULL DEFAULT 0,
      distance_affinity REAL NOT NULL DEFAULT 0,
      free_affinity REAL NOT NULL DEFAULT 0,
      indoor_outdoor_affinity REAL NOT NULL DEFAULT 0,
      explicit_exclusions_json TEXT NOT NULL DEFAULT '[]',
      proactive_enabled INTEGER NOT NULL DEFAULT 0 CHECK (proactive_enabled IN (0,1)),
      updated_at_ms INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS culture_feedback (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      profile_id TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      signal TEXT NOT NULL CHECK (signal IN (
        'explicit_like','explicit_dislike','save','selection','details','dismiss','query'
      )),
      strength REAL NOT NULL,
      created_at_ms INTEGER NOT NULL,
      metadata_json TEXT NOT NULL DEFAULT '{}'
    );

    CREATE INDEX IF NOT EXISTS idx_culture_feedback_profile_created
      ON culture_feedback(profile_id, created_at_ms DESC);

    CREATE INDEX IF NOT EXISTS idx_culture_feedback_profile_entity
      ON culture_feedback(profile_id, entity_type, entity_id, created_at_ms DESC);

    CREATE TABLE IF NOT EXISTS culture_saved_entities (
      profile_id TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      source_refs_json TEXT NOT NULL DEFAULT '[]',
      title TEXT NOT NULL,
      categories_json TEXT NOT NULL DEFAULT '[]',
      venue_json TEXT,
      occurrence_date TEXT,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      saved_at_ms INTEGER NOT NULL,
      PRIMARY KEY(profile_id, entity_type, entity_id)
    );

    CREATE INDEX IF NOT EXISTS idx_culture_saved_profile_date
      ON culture_saved_entities(profile_id, saved_at_ms DESC);

    CREATE TABLE IF NOT EXISTS culture_proactive_notifications (
      profile_id TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      reason TEXT NOT NULL,
      notified_at_ms INTEGER NOT NULL,
      PRIMARY KEY(profile_id, fingerprint)
    );

    CREATE INDEX IF NOT EXISTS idx_culture_proactive_profile_notified
      ON culture_proactive_notifications(profile_id, notified_at_ms DESC);
  `);

  const resultSetColumns = db.prepare('PRAGMA table_info(conversation_result_sets)').all() as Array<{ name: string }>;
  if (!resultSetColumns.some((column) => column.name === 'context_json')) {
    db.exec('ALTER TABLE conversation_result_sets ADD COLUMN context_json TEXT;');
  }
  const resultSetItemColumns = db.prepare('PRAGMA table_info(conversation_result_set_items)').all() as Array<{ name: string }>;
  if (!resultSetItemColumns.some((column) => column.name === 'metadata_json')) {
    db.exec('ALTER TABLE conversation_result_set_items ADD COLUMN metadata_json TEXT;');
  }

  const threadColumns = db
    .prepare('PRAGMA table_info(conversation_threads)')
    .all() as Array<{ name: string }>;
  const hasChannelColumn = threadColumns.some((column) => column.name === 'channel');
  if (!hasChannelColumn) {
    db.exec('ALTER TABLE conversation_threads ADD COLUMN channel TEXT;');
  }
  if (!threadColumns.some((column) => column.name === 'title')) {
    db.exec("ALTER TABLE conversation_threads ADD COLUMN title TEXT NOT NULL DEFAULT '';");
  }
  if (!threadColumns.some((column) => column.name === 'title_source')) {
    db.exec("ALTER TABLE conversation_threads ADD COLUMN title_source TEXT NOT NULL DEFAULT 'heuristic';");
  }

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_conversation_threads_channel_updated
      ON conversation_threads(channel, updated_at_ms DESC);
  `);

  // Ajouter colonnes pour gérer la fenêtre de conversation (10s)
  const threadColumnsAfterMigration = db
    .prepare('PRAGMA table_info(conversation_threads)')
    .all() as Array<{ name: string }>;
  
  if (!threadColumnsAfterMigration.some((col) => col.name === 'last_response_time_ms')) {
    db.exec('ALTER TABLE conversation_threads ADD COLUMN last_response_time_ms INTEGER DEFAULT 0;');
  }
  
  if (!threadColumnsAfterMigration.some((col) => col.name === 'conversation_window_expires_at_ms')) {
    db.exec('ALTER TABLE conversation_threads ADD COLUMN conversation_window_expires_at_ms INTEGER DEFAULT 0;');
  }

  return db;
}
