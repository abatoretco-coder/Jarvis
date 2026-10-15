import { createHash } from 'node:crypto';

import type { LiveSessionRegistry } from './LiveSessionRegistry';

const LIVE_ID = /^[A-Za-z0-9._:-]{1,160}$/u;

export function deriveLiveIdempotencyKey(sessionId: string, delegationId: string): string {
  const digest = createHash('sha256')
    .update(`${sessionId}:${delegationId}`, 'utf8')
    .digest('hex')
    .slice(0, 32);
  return `live-${digest}`;
}

export class LiveDelegationCoordinator {
  private readonly waiters = new Map<string, Set<() => void>>();

  constructor(
    private readonly registry: LiveSessionRegistry,
    private readonly maxDelegationsPerSession: number
  ) {}

  observe(sessionId: string, delegationId: string): void {
    if (!LIVE_ID.test(sessionId) || !LIVE_ID.test(delegationId)) {
      throw new Error('live_delegation_invalid');
    }
    if (!this.registry.findActive(sessionId)) {
      throw new Error('live_session_inactive');
    }
    const existing = this.registry.findDelegation(sessionId, delegationId);
    if (!existing && this.registry.countDelegations(sessionId) >= this.maxDelegationsPerSession) {
      throw new Error('live_delegation_limit');
    }
    this.registry.observeDelegation({ sessionId, delegationId });
    const key = `${sessionId}\0${delegationId}`;
    const callbacks = this.waiters.get(key);
    if (callbacks) {
      this.waiters.delete(key);
      callbacks.forEach((callback) => callback());
    }
  }

  async waitUntilObserved(
    sessionId: string,
    delegationId: string,
    timeoutMs: number
  ): Promise<boolean> {
    if (this.registry.findDelegation(sessionId, delegationId)) return true;
    const key = `${sessionId}\0${delegationId}`;
    return new Promise<boolean>((resolve) => {
      let settled = false;
      const callbacks = this.waiters.get(key) ?? new Set<() => void>();
      const done = (value: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        callbacks.delete(onObserved);
        if (callbacks.size === 0) this.waiters.delete(key);
        resolve(value);
      };
      const onObserved = () => done(true);
      callbacks.add(onObserved);
      this.waiters.set(key, callbacks);
      const timer = setTimeout(() => done(false), timeoutMs);
      timer.unref();
    });
  }

  markIngestSent(sessionId: string, delegationId: string, operationKey: string): void {
    const expected = deriveLiveIdempotencyKey(sessionId, delegationId);
    if (operationKey !== expected) throw new Error('live_idempotency_key_mismatch');
    const current = this.registry.requireDelegation(sessionId, delegationId);
    if (current.operationKey && current.operationKey !== operationKey) {
      throw new Error('live_delegation_operation_conflict');
    }
    // A retry with the exact same operation key must be allowed to reach the
    // existing ingest idempotency coordinator, even after client telemetry has
    // advanced the delegation. It will replay the cached result, not execute it.
    if (current.operationKey === operationKey) return;
    this.registry.transitionDelegation({
      sessionId,
      delegationId,
      state: current.state === 'ingest_sent' || current.state === 'ingest_running'
        ? current.state
        : 'ingest_sent',
      operationKey,
    });
  }

  markClientState(
    sessionId: string,
    delegationId: string,
    state: 'ingest_running' | 'ingest_completed' | 'replying' | 'completed' | 'uncertain' | 'failed'
  ): void {
    this.registry.transitionDelegation({ sessionId, delegationId, state });
  }
}
