import { deriveLiveIdempotencyKey } from './LiveDelegationCoordinator';

export class LiveFallbackCoordinator {
  operationKey(sessionId: string, delegationId: string): string {
    return deriveLiveIdempotencyKey(sessionId, delegationId);
  }

  mayStartClassicFallback(input: { ingestAttempted: boolean; transcriptFinal: boolean }): boolean {
    return !input.ingestAttempted && input.transcriptFinal;
  }

  recoveryAction(state: 'pending' | 'completed' | 'uncertain' | 'missing'):
    | 'wait'
    | 'use_result'
    | 'report_uncertain' {
    if (state === 'pending') return 'wait';
    if (state === 'completed') return 'use_result';
    return 'report_uncertain';
  }
}
