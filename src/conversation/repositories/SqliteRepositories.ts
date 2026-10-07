import fs from 'node:fs';
import path from 'node:path';

import Database from 'better-sqlite3';

import { getCurrentDataOwnerScope } from '../../identity/requestIdentity';
import { runConversationMigrations } from './conversationMigrations';
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
    const owner = ownerPredicate();
    const row = this.db
      .prepare(
        `SELECT thread_id, channel, title, summary, summary_upto_seq, summary_version,
                summary_candidate, summary_candidate_upto_seq, summary_status,
                interaction_count, last_response_time_ms, conversation_window_expires_at_ms
         FROM conversation_threads
         WHERE thread_id = ? AND ${owner.sql}`,
      )
      .get(threadId, ...owner.params) as
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
    const ownerColumnsValue = ownerColumns();
    const owner = ownerPredicate();
    const incomingChannel = typeof options?.channel === 'string' ? options.channel.trim() : '';
    this.db
      .prepare(
        `INSERT INTO conversation_threads (
          thread_id, channel, title, summary, summary_upto_seq, summary_version, summary_candidate, summary_candidate_upto_seq, summary_status, interaction_count, created_at_ms, updated_at_ms, owner_user_id, owner_service_id
        ) VALUES (?, ?, '', '', 0, 0, NULL, NULL, 'idle', 0, ?, ?, ?, ?)
        ON CONFLICT(thread_id) DO NOTHING`
      )
      .run(threadId, incomingChannel || null, now, now, ownerColumnsValue.ownerUserId, ownerColumnsValue.ownerServiceId);

    if (incomingChannel) {
      this.db
        .prepare(`UPDATE conversation_threads SET channel = ?, updated_at_ms = ? WHERE thread_id = ? AND ${owner.sql} AND (channel IS NULL OR channel = '' OR channel <> ?)`)
        .run(incomingChannel, now, threadId, ...owner.params, incomingChannel);
    }

    const row = await this.findById(threadId);
    if (!row) {
      throw new Error('conversation_thread_not_found');
    }
    return row;
  }

  async incrementInteractionCount(threadId: string): Promise<number> {
    await this.getOrCreate(threadId);
    const owner = ownerPredicate();
    this.db
      .prepare(`UPDATE conversation_threads SET interaction_count = interaction_count + 1, updated_at_ms = ? WHERE thread_id = ? AND ${owner.sql}`)
      .run(Date.now(), threadId, ...owner.params);
    const row = this.db
      .prepare(`SELECT interaction_count FROM conversation_threads WHERE thread_id = ? AND ${owner.sql}`)
      .get(threadId, ...owner.params) as { interaction_count: number };
    return Number(row.interaction_count);
  }

  async tryStartSummary(threadId: string): Promise<boolean> {
    await this.getOrCreate(threadId);
    const now = Date.now();
    const owner = ownerPredicate();
    const res = this.db
      .prepare(
        `UPDATE conversation_threads
         SET summary_status = 'running', updated_at_ms = ?
         WHERE thread_id = ? AND ${owner.sql} AND summary_status IN ('idle', 'failed')`
      )
      .run(now, threadId, ...owner.params);
    return res.changes > 0;
  }

  async markSummaryCandidateReady(threadId: string, candidate: string, uptoSeq: number): Promise<void> {
    await this.getOrCreate(threadId);
    const owner = ownerPredicate();
    this.db
      .prepare(
        `UPDATE conversation_threads
         SET summary_candidate = ?,
             summary_candidate_upto_seq = ?,
             summary_status = 'ready',
             summary_last_error = NULL,
             updated_at_ms = ?
         WHERE thread_id = ? AND ${owner.sql}`
      )
      .run(candidate, uptoSeq, Date.now(), threadId, ...owner.params);
  }

  async markSummaryFailed(threadId: string, reason: string): Promise<void> {
    await this.getOrCreate(threadId);
    const owner = ownerPredicate();
    this.db
      .prepare(
        `UPDATE conversation_threads
         SET summary_status = 'failed',
             summary_last_error = ?,
             updated_at_ms = ?
         WHERE thread_id = ? AND ${owner.sql}`
      )
      .run(reason.slice(0, 500), Date.now(), threadId, ...owner.params);
  }

  async resetSummaryStatus(threadId: string): Promise<void> {
    await this.getOrCreate(threadId);
    const owner = ownerPredicate();
    this.db
      .prepare(
        `UPDATE conversation_threads
         SET summary_status = 'idle',
             updated_at_ms = ?
         WHERE thread_id = ? AND ${owner.sql}`
      )
      .run(Date.now(), threadId, ...owner.params);
  }

  async commitCandidateIfReady(threadId: string): Promise<CommitCandidateResult> {
    await this.getOrCreate(threadId);
    const now = Date.now();
    const owner = ownerPredicate();

    const tx = this.db.transaction(() => {
      const row = this.db
        .prepare(
          `SELECT summary_candidate, summary_candidate_upto_seq, summary_status, summary_version
           FROM conversation_threads
           WHERE thread_id = ? AND ${owner.sql}`
        )
        .get(threadId, ...owner.params) as {
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
           WHERE thread_id = ? AND ${owner.sql}`
        )
        .run(row.summary_candidate, row.summary_candidate_upto_seq, nextVersion, now, threadId, ...owner.params);

      return { committed: true, usedSummaryVersion: `v${nextVersion}` } as CommitCandidateResult;
    });

    return tx();
  }

  async updateTitle(threadId: string, title: string): Promise<void> {
    const normalized = normalizeContent(title).slice(0, 80);
    if (!normalized) return;
    await this.getOrCreate(threadId);
    const owner = ownerPredicate();
    this.db
      .prepare(`UPDATE conversation_threads SET title = ?, title_source = 'ai' WHERE thread_id = ? AND ${owner.sql}`)
      .run(normalized, threadId, ...owner.params);
  }

  async listRecent(limit: number, options?: { channel?: string | null }): Promise<ThreadListItem[]> {
    const safeLimit = Math.max(1, Math.min(limit, 200));
    const filterChannel = typeof options?.channel === 'string' ? options.channel.trim() : '';
    const owner = ownerPredicate('t.owner_user_id');
    const updateOwner = ownerPredicate();
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
         WHERE t.channel = ? AND ${owner.sql}
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
         WHERE ${owner.sql}
         ORDER BY t.updated_at_ms DESC
         LIMIT ?`;

    const rows = this.db
      .prepare(selectSql)
      .all(...(filterChannel ? [filterChannel, ...owner.params, safeLimit] : [...owner.params, safeLimit])) as Array<{
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
          .prepare(`UPDATE conversation_threads SET title = ?, title_source = 'heuristic' WHERE thread_id = ? AND ${updateOwner.sql}`)
          .run(title, row.thread_id, ...updateOwner.params);
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
    const owner = ownerPredicate();
    const result = this.db.prepare(`DELETE FROM conversation_threads WHERE thread_id = ? AND ${owner.sql}`).run(threadId, ...owner.params);
    return result.changes > 0;
  }

  async purgeThreadsOlderThan(cutoffMs: number, options?: { allOwners?: boolean }): Promise<number> {
    const safeCutoff = Math.max(0, Math.floor(cutoffMs));
    const owner = ownerPredicate();
    const result = options?.allOwners
      ? this.db.prepare('DELETE FROM conversation_threads WHERE updated_at_ms < ?').run(safeCutoff)
      : this.db.prepare(`DELETE FROM conversation_threads WHERE updated_at_ms < ? AND ${owner.sql}`).run(safeCutoff, ...owner.params);
    return Number(result.changes ?? 0);
  }

  async updateResponseTime(threadId: string, responseTimeMs: number): Promise<void> {
    const nowMs = Date.now();
    const windowExpiresAtMs = nowMs + 10000; // Fenêtre de 10 secondes
    const owner = ownerPredicate();
    this.db
      .prepare(
        `UPDATE conversation_threads 
         SET last_response_time_ms = ?, conversation_window_expires_at_ms = ?, updated_at_ms = ? 
         WHERE thread_id = ? AND ${owner.sql}`
      )
      .run(responseTimeMs, windowExpiresAtMs, nowMs, threadId, ...owner.params);
  }

  async getActiveConversationThread(channel?: string | null): Promise<ThreadRecord | null> {
    const nowMs = Date.now();
    const channelFilter = typeof channel === 'string' ? channel.trim() : '';
    const owner = ownerPredicate();
    
    const row = this.db
      .prepare(
        `SELECT thread_id, channel, title, summary, summary_upto_seq, summary_version, summary_candidate, summary_candidate_upto_seq, summary_status, interaction_count, last_response_time_ms, conversation_window_expires_at_ms
         FROM conversation_threads
         WHERE conversation_window_expires_at_ms > ? AND (? = '' OR channel = ?) AND ${owner.sql}
         ORDER BY conversation_window_expires_at_ms DESC
         LIMIT 1`
      )
      .get(nowMs, channelFilter, channelFilter, ...owner.params) as
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
    const owner = ownerPredicate();
    const tx = this.db.transaction(() => {
      const accessible = this.db.prepare(`SELECT 1 FROM conversation_threads WHERE thread_id = ? AND ${owner.sql}`)
        .get(input.threadId, ...owner.params);
      if (!accessible) throw new Error('conversation_thread_not_found');
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
             WHERE thread_id = ? AND ${owner.sql} AND (title IS NULL OR trim(title) = '')`
          )
          .run(buildConversationTitle(normalized), now, input.threadId, ...owner.params);
      }
      return nextSeq;
    });

    return tx();
  }

  async getRecentMessages(threadId: string, limit: number): Promise<MessageRecord[]> {
    const owner = ownerPredicate('t.owner_user_id');
    const rows = this.db
      .prepare(
        `SELECT m.thread_id, m.seq, m.role, m.content, m.created_at_ms
         FROM conversation_messages m
         JOIN conversation_threads t ON t.thread_id = m.thread_id
         WHERE m.thread_id = ? AND ${owner.sql}
         ORDER BY m.seq DESC
         LIMIT ?`
      )
      .all(threadId, ...owner.params, Math.max(1, limit)) as Array<{
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
    const owner = ownerPredicate('t.owner_user_id');
    const rows = this.db
      .prepare(
        `SELECT m.thread_id, m.seq, m.role, m.content, m.created_at_ms
         FROM conversation_messages m
         JOIN conversation_threads t ON t.thread_id = m.thread_id
         WHERE m.thread_id = ? AND ${owner.sql} AND m.seq > ?
         ORDER BY m.seq ASC
         LIMIT ?`
      )
      .all(threadId, ...owner.params, Math.max(0, afterExclusiveSeq), Math.max(1, limit)) as Array<{
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
    const owner = ownerPredicate('t.owner_user_id');
    const rows = this.db
      .prepare(
        `SELECT m.thread_id, m.seq, m.role, m.content, m.created_at_ms
         FROM conversation_messages m
         JOIN conversation_threads t ON t.thread_id = m.thread_id
         WHERE m.thread_id = ? AND ${owner.sql} AND m.seq > ? AND m.seq <= ?
         ORDER BY m.seq ASC`
      )
      .all(threadId, ...owner.params, fromExclusiveSeq, toInclusiveSeq) as Array<{
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
    const owner = ownerPredicate('t.owner_user_id');
    const row = this.db
      .prepare(`SELECT COALESCE(MAX(m.seq), 0) AS max_seq FROM conversation_messages m
        JOIN conversation_threads t ON t.thread_id = m.thread_id
        WHERE m.thread_id = ? AND ${owner.sql}`)
      .get(threadId, ...owner.params) as { max_seq: number };
    return Number(row.max_seq ?? 0);
  }
}

export function createConversationDb(dbPath: string): Database.Database {
  const dir = path.dirname(dbPath);
  fs.mkdirSync(dir, { recursive: true });

  const db = new Database(dbPath);
  try {
    db.pragma('foreign_keys = ON');
    runConversationMigrations(db);
    db.pragma('journal_mode = WAL');
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

function ownerPredicate(column = 'owner_user_id'): { sql: string; params: string[] } {
  const serviceColumn = column.replace(/owner_user_id$/u, 'owner_service_id');
  const scope = getCurrentDataOwnerScope();
  if (scope.kind === 'user') {
    return { sql: `${column} = ? AND ${serviceColumn} IS NULL`, params: [scope.userId] };
  }
  if (scope.kind === 'service') {
    return { sql: `${column} IS NULL AND ${serviceColumn} = ?`, params: [scope.serviceId] };
  }
  return { sql: `${column} IS NULL AND ${serviceColumn} IS NULL`, params: [] };
}

function ownerColumns(): { ownerUserId: string | null; ownerServiceId: string | null } {
  const scope = getCurrentDataOwnerScope();
  return {
    ownerUserId: scope.kind === 'user' ? scope.userId : null,
    ownerServiceId: scope.kind === 'service' ? scope.serviceId : null,
  };
}
