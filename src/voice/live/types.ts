export type LiveClient = 'desktop' | 'android' | 'home_assistant';

export type LiveSessionState =
  | 'active'
  | 'closing'
  | 'closed'
  | 'finalization_unconfirmed';

export type LiveDelegationState =
  | 'capturing'
  | 'ready_to_delegate'
  | 'delegating'
  | 'ingest_sent'
  | 'ingest_running'
  | 'ingest_completed'
  | 'replying'
  | 'completed'
  | 'uncertain'
  | 'failed';

export type LiveSessionRecord = {
  sessionId: string;
  ownerUserId: string;
  deviceHash: string;
  threadId: string;
  client: LiveClient;
  state: LiveSessionState;
  sidebandAttached: boolean;
  finalizationConfirmed: boolean;
  usageSeconds: number;
  createdAtMs: number;
  expiresAtMs: number;
  lastEventAtMs: number;
  closedAtMs: number | null;
  lastErrorCode: string | null;
};

export type LiveDelegationRecord = {
  sessionId: string;
  delegationId: string;
  state: LiveDelegationState;
  operationKey: string | null;
  observedAtMs: number;
  updatedAtMs: number;
};

export type LiveAvailability = {
  available: boolean;
  reason?: 'disabled' | 'client_disabled' | 'not_configured' | 'budget_exhausted' | 'circuit_open';
};
