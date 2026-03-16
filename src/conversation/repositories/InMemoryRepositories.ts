import type { MessageRecord, MessageRepository, MessageRole } from './MessageRepository';
import type { CommitCandidateResult, ThreadListItem, ThreadRecord, ThreadRepository } from './ThreadRepository';

export class InMemoryThreadRepository implements ThreadRepository {
  private readonly threads = new Map<string, ThreadRecord>();

  async getOrCreate(threadId: string): Promise<ThreadRecord> {
    const existing = this.threads.get(threadId);
    if (existing) {
      return { ...existing };
    }

    const created: ThreadRecord = {
      threadId,
      summary: '',
      summaryUptoSeq: 0,
      summaryVersion: 0,
      summaryCandidate: null,
      summaryCandidateUptoSeq: null,
      summaryStatus: 'idle',
      interactionCount: 0,
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

  async listRecent(_limit: number): Promise<ThreadListItem[]> {
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
