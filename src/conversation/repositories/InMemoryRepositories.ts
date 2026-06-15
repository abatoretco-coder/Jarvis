import type { MessageRecord, MessageRepository, MessageRole } from './MessageRepository';
import type { CommitCandidateResult, ThreadListItem, ThreadRecord, ThreadRepository } from './ThreadRepository';

export class InMemoryThreadRepository implements ThreadRepository {
  private readonly threads = new Map<string, ThreadRecord>();

  async findById(threadId: string): Promise<ThreadRecord | null> {
    const row = this.threads.get(threadId);
    return row ? { ...row } : null;
  }

  async getOrCreate(threadId: string, options?: { channel?: string | null }): Promise<ThreadRecord> {
    const incomingChannel = typeof options?.channel === 'string' ? options.channel.trim() : '';
    const existing = this.threads.get(threadId);
    if (existing) {
      if (incomingChannel && existing.channel !== incomingChannel) {
        const next = { ...existing, channel: incomingChannel };
        this.threads.set(threadId, next);
        return { ...next };
      }
      return { ...existing };
    }

    const created: ThreadRecord = {
      threadId,
      channel: incomingChannel || null,
      title: '',
      summary: '',
      summaryUptoSeq: 0,
      summaryVersion: 0,
      summaryCandidate: null,
      summaryCandidateUptoSeq: null,
      summaryStatus: 'idle',
      interactionCount: 0,
      lastResponseTimeMs: 0,
      conversationWindowExpiresAtMs: 0,
    };
    this.threads.set(threadId, created);
    return { ...created };
  }

  async incrementInteractionCount(threadId: string): Promise<number> {
    const row = await this.getOrCreate(threadId);
    row.interactionCount += 1;
    this.threads.set(threadId, row);
    return row.interactionCount;
  }

  async updateResponseTime(threadId: string, responseTimeMs: number): Promise<void> {
    const thread = await this.getOrCreate(threadId);
    thread.lastResponseTimeMs = responseTimeMs;
    thread.conversationWindowExpiresAtMs = responseTimeMs + 10000;
    this.threads.set(threadId, thread);
  }

  async getActiveConversationThread(channel?: string | null): Promise<ThreadRecord | null> {
    const now = Date.now();
    const candidates = Array.from(this.threads.values()).filter(
      (t) =>
        t.conversationWindowExpiresAtMs > now &&
        (!channel || t.channel === channel)
    );
    if (candidates.length === 0) return null;
    // Return the thread with the most recent expiry time
    return candidates.reduce((latest, current) =>
      current.conversationWindowExpiresAtMs > latest.conversationWindowExpiresAtMs
        ? current
        : latest
    );
  }

  async tryStartSummary(threadId: string): Promise<boolean> {
    const row = await this.getOrCreate(threadId);
    if (row.summaryStatus !== 'idle' && row.summaryStatus !== 'failed') {
      return false;
    }
    row.summaryStatus = 'running';
    this.threads.set(threadId, row);
    return true;
  }

  async markSummaryCandidateReady(threadId: string, candidate: string, uptoSeq: number): Promise<void> {
    const row = await this.getOrCreate(threadId);
    row.summaryCandidate = candidate;
    row.summaryCandidateUptoSeq = uptoSeq;
    row.summaryStatus = 'ready';
    this.threads.set(threadId, row);
  }

  async markSummaryFailed(threadId: string): Promise<void> {
    const row = await this.getOrCreate(threadId);
    row.summaryStatus = 'failed';
    this.threads.set(threadId, row);
  }

  async resetSummaryStatus(threadId: string): Promise<void> {
    const row = await this.getOrCreate(threadId);
    row.summaryStatus = 'idle';
    this.threads.set(threadId, row);
  }

  async commitCandidateIfReady(threadId: string): Promise<CommitCandidateResult> {
    const row = await this.getOrCreate(threadId);
    if (row.summaryStatus !== 'ready' || !row.summaryCandidate || row.summaryCandidateUptoSeq === null) {
      return { committed: false };
    }

    row.summary = row.summaryCandidate;
    row.summaryUptoSeq = row.summaryCandidateUptoSeq;
    row.summaryVersion += 1;
    row.summaryCandidate = null;
    row.summaryCandidateUptoSeq = null;
    row.summaryStatus = 'idle';
    this.threads.set(threadId, row);
    return { committed: true, usedSummaryVersion: `v${row.summaryVersion}` };
  }

  async updateTitle(threadId: string, title: string): Promise<void> {
    const row = await this.getOrCreate(threadId);
    row.title = title.trim();
    this.threads.set(threadId, row);
  }

  async listRecent(_limit: number, _options?: { channel?: string | null }): Promise<ThreadListItem[]> {
    // In-memory implementation returns empty list
    return [];
  }

  async deleteThread(threadId: string): Promise<boolean> {
    return this.threads.delete(threadId);
  }

  async purgeThreadsOlderThan(_cutoffMs: number): Promise<number> {
    // In-memory repository does not track timestamps; no automatic purge.
    return 0;
  }
}

export class InMemoryMessageRepository implements MessageRepository {
  private readonly messagesByThread = new Map<string, MessageRecord[]>();

  async appendMessage(input: { threadId: string; role: MessageRole; content: string; createdAtMs?: number }): Promise<number> {
    const list = this.messagesByThread.get(input.threadId) ?? [];
    const seq = (list.at(-1)?.seq ?? 0) + 1;
    const row: MessageRecord = {
      threadId: input.threadId,
      seq,
      role: input.role,
      content: input.content,
      createdAtMs: input.createdAtMs ?? Date.now(),
    };
    list.push(row);
    this.messagesByThread.set(input.threadId, list);
    return seq;
  }

  async getRecentMessages(threadId: string, limit: number): Promise<MessageRecord[]> {
    const list = this.messagesByThread.get(threadId) ?? [];
    return list.slice(Math.max(0, list.length - Math.max(1, limit)));
  }

  async getMessagesAfterSeq(threadId: string, afterExclusiveSeq: number, limit: number): Promise<MessageRecord[]> {
    const list = this.messagesByThread.get(threadId) ?? [];
    return list.filter((m) => m.seq > Math.max(0, afterExclusiveSeq)).slice(0, Math.max(1, limit));
  }

  async getMessagesRange(threadId: string, fromExclusiveSeq: number, toInclusiveSeq: number): Promise<MessageRecord[]> {
    const list = this.messagesByThread.get(threadId) ?? [];
    return list.filter((m) => m.seq > fromExclusiveSeq && m.seq <= toInclusiveSeq);
  }

  async getMaxSeq(threadId: string): Promise<number> {
    const list = this.messagesByThread.get(threadId) ?? [];
    return list.at(-1)?.seq ?? 0;
  }
}
