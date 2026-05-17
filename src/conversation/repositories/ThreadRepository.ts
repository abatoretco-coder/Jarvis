export type SummaryStatus = 'idle' | 'running' | 'ready' | 'failed';

export type ThreadRecord = {
  threadId: string;
  channel: string | null;
  summary: string;
  summaryUptoSeq: number;
  summaryVersion: number;
  summaryCandidate: string | null;
  summaryCandidateUptoSeq: number | null;
  summaryStatus: SummaryStatus;
  interactionCount: number;
  lastResponseTimeMs: number;
  conversationWindowExpiresAtMs: number;
};

export type CommitCandidateResult = {
  committed: boolean;
  usedSummaryVersion?: string;
};

export type ThreadListItem = {
  threadId: string;
  channel: string | null;
  summary: string;
  lastActivityMs: number;
  messageCount: number;
};

export interface ThreadRepository {
  getOrCreate(threadId: string, options?: { channel?: string | null }): Promise<ThreadRecord>;
  incrementInteractionCount(threadId: string): Promise<number>;
  tryStartSummary(threadId: string): Promise<boolean>;
  markSummaryCandidateReady(threadId: string, candidate: string, uptoSeq: number): Promise<void>;
  markSummaryFailed(threadId: string, reason: string): Promise<void>;
  resetSummaryStatus(threadId: string): Promise<void>;
  commitCandidateIfReady(threadId: string): Promise<CommitCandidateResult>;
  listRecent(limit: number, options?: { channel?: string | null }): Promise<ThreadListItem[]>;
  deleteThread(threadId: string): Promise<boolean>;
  purgeThreadsOlderThan(cutoffMs: number): Promise<number>;
  updateResponseTime(threadId: string, responseTimeMs: number): Promise<void>;
  getActiveConversationThread(channel?: string | null): Promise<ThreadRecord | null>;
}
