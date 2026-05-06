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

function assertSummaryStatus(value: string): SummaryStatus {
  if (value === 'idle' || value === 'running' || value === 'ready' || value === 'failed') {
    return value;
  }
  return 'idle';
}

export class SqliteThreadRepository implements ThreadRepository {
  constructor(private readonly db: Database.Database) {}

  async getOrCreate(threadId: string, options?: { channel?: string | null }): Promise<ThreadRecord> {
    const now = Date.now();
    const incomingChannel = typeof options?.channel === 'string' ? options.channel.trim() : '';
    this.db
      .prepare(
        `INSERT INTO conversation_threads (
          thread_id, channel, summary, summary_upto_seq, summary_version, summary_candidate, summary_candidate_upto_seq, summary_status, interaction_count, created_at_ms, updated_at_ms
        ) VALUES (?, ?, '', 0, 0, NULL, NULL, 'idle', 0, ?, ?)
        ON CONFLICT(thread_id) DO NOTHING`
      )
      .run(threadId, incomingChannel || null, now, now);

    if (incomingChannel) {
      this.db
        .prepare("UPDATE conversation_threads SET channel = ?, updated_at_ms = ? WHERE thread_id = ? AND (channel IS NULL OR channel = '' OR channel <> ?)")
        .run(incomingChannel, now, threadId, incomingChannel);
    }

    const row = this.db
      .prepare(
        `SELECT thread_id, channel, summary, summary_upto_seq, summary_version, summary_candidate, summary_candidate_upto_seq, summary_status, interaction_count
         FROM conversation_threads
         WHERE thread_id = ?`
      )
      .get(threadId) as
      | {
          thread_id: string;
          channel: string | null;
          summary: string;
          summary_upto_seq: number;
          summary_version: number;
          summary_candidate: string | null;
          summary_candidate_upto_seq: number | null;
          summary_status: string;
          interaction_count: number;
        }
      | undefined;

    if (!row) {
      throw new Error(`Thread not found after create: ${threadId}`);
    }

    return {
      threadId: row.thread_id,
      channel: row.channel,
      summary: row.summary ?? '',
      summaryUptoSeq: Number(row.summary_upto_seq ?? 0),
      summaryVersion: Number(row.summary_version ?? 0),
      summaryCandidate: row.summary_candidate,
      summaryCandidateUptoSeq: row.summary_candidate_upto_seq === null ? null : Number(row.summary_candidate_upto_seq),
      summaryStatus: assertSummaryStatus(row.summary_status),
      interactionCount: Number(row.interaction_count ?? 0),
    };
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

  async listRecent(limit: number, options?: { channel?: string | null }): Promise<ThreadListItem[]> {
    const safeLimit = Math.max(1, Math.min(limit, 200));
    const filterChannel = typeof options?.channel === 'string' ? options.channel.trim() : '';
    const selectSql = filterChannel
      ? `SELECT
          t.thread_id,
          t.channel,
          t.summary,
          t.updated_at_ms,
          (SELECT COUNT(*) FROM conversation_messages m WHERE m.thread_id = t.thread_id) as message_count
         FROM conversation_threads t
         WHERE t.channel = ?
         ORDER BY t.updated_at_ms DESC
         LIMIT ?`
      : `SELECT
          t.thread_id,
          t.channel,
          t.summary,
          t.updated_at_ms,
          (SELECT COUNT(*) FROM conversation_messages m WHERE m.thread_id = t.thread_id) as message_count
         FROM conversation_threads t
         ORDER BY t.updated_at_ms DESC
         LIMIT ?`;

    const rows = this.db
      .prepare(selectSql)
      .all(...(filterChannel ? [filterChannel, safeLimit] : [safeLimit])) as Array<{
      thread_id: string;
      channel: string | null;
      summary: string;
      updated_at_ms: number;
      message_count: number;
    }>;

    return rows.map((row) => ({
      threadId: row.thread_id,
      channel: row.channel,
      summary: row.summary || `Conversation ${row.thread_id.slice(-8)}`,
      lastActivityMs: Number(row.updated_at_ms),
      messageCount: Number(row.message_count),
    }));
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
  `);

  const threadColumns = db
    .prepare('PRAGMA table_info(conversation_threads)')
    .all() as Array<{ name: string }>;
  const hasChannelColumn = threadColumns.some((column) => column.name === 'channel');
  if (!hasChannelColumn) {
    db.exec('ALTER TABLE conversation_threads ADD COLUMN channel TEXT;');
  }

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_conversation_threads_channel_updated
      ON conversation_threads(channel, updated_at_ms DESC);
  `);

  return db;
}
