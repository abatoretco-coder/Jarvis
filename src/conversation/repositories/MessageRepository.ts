export type MessageRole = 'user' | 'assistant';

export const MESSAGE_AUDIT_SCHEMA_VERSION = 1 as const;
export const MAX_RAW_CONTENT_LENGTH = 64_000;
export const MAX_AUDIT_SOURCES = 20;
export const MAX_AUDIT_SOURCE_LENGTH = 2_048;
export const MAX_DECISION_METADATA_LENGTH = 16_000;

export type MessageDecisionMetadata = {
  schemaVersion: typeof MESSAGE_AUDIT_SCHEMA_VERSION;
  requestId?: string;
  correlationId?: string;
  kind?: string;
  source?: string;
  routeKey?: string;
  semanticDecision?: string;
  fallbackReason?: string;
  proposalId?: string;
  pendingAction?: string;
  operationStatus?: string;
  llmProvider?: string;
  llmModel?: string;
  llmLatencyMs?: number;
  llmFallbackReason?: string;
};

export type MessageAuditSource = {
  url: string;
  title: string;
  provider: string;
  capturedAtMs: number;
};

export function normalizeMessageRawContent(value: string): string {
  return String(value ?? '').replace(/\0/g, '').slice(0, MAX_RAW_CONTENT_LENGTH);
}

export function normalizeMessageAuditSources(values: string[]): string[] {
  const normalized: string[] = [];
  for (const value of values) {
    if (typeof value !== 'string') continue;
    const candidate = value.trim();
    if (!candidate || candidate.length > MAX_AUDIT_SOURCE_LENGTH) continue;
    try {
      const parsed = new URL(candidate);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') continue;
      normalized.push(candidate);
    } catch {
      continue;
    }
    if (normalized.length >= MAX_AUDIT_SOURCES) break;
  }
  return normalized;
}

export function buildMessageAuditSources(
  values: string[],
  metadata: MessageDecisionMetadata | undefined,
  capturedAtMs: number
): MessageAuditSource[] {
  const normalizedMetadata = metadata
    ? normalizeMessageDecisionMetadata(metadata)
    : undefined;
  return normalizeMessageAuditSources(values).map((url) => {
    const title = new URL(url).hostname || url;
    return {
      url,
      title,
      provider:
        normalizedMetadata?.llmProvider ?? normalizedMetadata?.source ?? 'unknown',
      capturedAtMs: Number.isFinite(capturedAtMs) ? Math.max(0, Math.floor(capturedAtMs)) : 0,
    };
  });
}

export function normalizeMessageDecisionMetadata(
  value: MessageDecisionMetadata
): MessageDecisionMetadata {
  const cleanString = (input: string | undefined): string | undefined =>
    input ? input.replace(/\0/g, '').slice(0, 512) : undefined;
  return {
    schemaVersion: MESSAGE_AUDIT_SCHEMA_VERSION,
    ...(cleanString(value.requestId) ? { requestId: cleanString(value.requestId) } : {}),
    ...(cleanString(value.correlationId) ? { correlationId: cleanString(value.correlationId) } : {}),
    ...(cleanString(value.kind) ? { kind: cleanString(value.kind) } : {}),
    ...(cleanString(value.source) ? { source: cleanString(value.source) } : {}),
    ...(cleanString(value.routeKey) ? { routeKey: cleanString(value.routeKey) } : {}),
    ...(cleanString(value.semanticDecision)
      ? { semanticDecision: cleanString(value.semanticDecision) }
      : {}),
    ...(cleanString(value.fallbackReason) ? { fallbackReason: cleanString(value.fallbackReason) } : {}),
    ...(cleanString(value.proposalId) ? { proposalId: cleanString(value.proposalId) } : {}),
    ...(cleanString(value.pendingAction) ? { pendingAction: cleanString(value.pendingAction) } : {}),
    ...(cleanString(value.operationStatus)
      ? { operationStatus: cleanString(value.operationStatus) }
      : {}),
    ...(cleanString(value.llmProvider) ? { llmProvider: cleanString(value.llmProvider) } : {}),
    ...(cleanString(value.llmModel) ? { llmModel: cleanString(value.llmModel) } : {}),
    ...(Number.isFinite(value.llmLatencyMs) && value.llmLatencyMs !== undefined
      ? { llmLatencyMs: Math.max(0, Math.floor(value.llmLatencyMs)) }
      : {}),
    ...(cleanString(value.llmFallbackReason)
      ? { llmFallbackReason: cleanString(value.llmFallbackReason) }
      : {}),
  };
}

export type MessageRecord = {
  threadId: string;
  seq: number;
  role: MessageRole;
  content: string;
  spokenContent?: string;
  rawContent?: string;
  sources?: string[];
  sourceDetails?: MessageAuditSource[];
  decisionMetadata?: MessageDecisionMetadata;
  createdAtMs: number;
};

export interface MessageRepository {
  appendMessage(input: {
    threadId: string;
    role: MessageRole;
    content: string;
    spokenContent?: string;
    rawContent?: string;
    sources?: string[];
    decisionMetadata?: MessageDecisionMetadata;
    createdAtMs?: number;
  }): Promise<number>;
  getRecentMessages(threadId: string, limit: number): Promise<MessageRecord[]>;
  getMessagesAfterSeq(threadId: string, afterExclusiveSeq: number, limit: number): Promise<MessageRecord[]>;
  getMessagesRange(threadId: string, fromExclusiveSeq: number, toInclusiveSeq: number): Promise<MessageRecord[]>;
  getMaxSeq(threadId: string): Promise<number>;
}
