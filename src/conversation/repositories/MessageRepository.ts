export type MessageRole = 'user' | 'assistant';

export type MessageRecord = {
  threadId: string;
  seq: number;
  role: MessageRole;
  content: string;
  createdAtMs: number;
};

export interface MessageRepository {
  appendMessage(input: { threadId: string; role: MessageRole; content: string; createdAtMs?: number }): Promise<number>;
  getRecentMessages(threadId: string, limit: number): Promise<MessageRecord[]>;
  getMessagesAfterSeq(threadId: string, afterExclusiveSeq: number, limit: number): Promise<MessageRecord[]>;
  getMessagesRange(threadId: string, fromExclusiveSeq: number, toInclusiveSeq: number): Promise<MessageRecord[]>;
  getMaxSeq(threadId: string): Promise<number>;
}
