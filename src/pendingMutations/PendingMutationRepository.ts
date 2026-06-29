import Database from 'better-sqlite3';

import type { CapabilityAgent, CapabilityEffect } from '../capabilities/capabilityRegistry';

export type PendingMutationStatus = 'pending' | 'executing' | 'executed' | 'failed' | 'cancelled';

export type PendingMutationRecord = {
  proposalId: string;
  threadId: string;
  clientChannel?: string;
  agent: CapabilityAgent;
  action: string;
  effect: CapabilityEffect;
  routeKey?: string;
  preview: string;
  payload: unknown;
  status: PendingMutationStatus;
  expiresAtMs: number;
  createdAtMs: number;
  executedAtMs?: number;
};

type PendingMutationRow = {
  proposal_id: string;
  thread_id: string;
  client_channel: string | null;
  agent: string;
  action: string;
  effect: string;
  route_key: string | null;
  preview: string;
  payload_json: string;
  status: PendingMutationStatus;
  expires_at_ms: number;
  created_at_ms: number;
  executed_at_ms: number | null;
};

function parsePayload(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return {};
  }
}

function mapRow(row: PendingMutationRow): PendingMutationRecord {
  return {
    proposalId: row.proposal_id,
    threadId: row.thread_id,
    clientChannel: row.client_channel ?? undefined,
    agent: row.agent as CapabilityAgent,
    action: row.action,
    effect: row.effect as CapabilityEffect,
    routeKey: row.route_key ?? undefined,
    preview: row.preview,
    payload: parsePayload(row.payload_json),
    status: row.status,
    expiresAtMs: Number(row.expires_at_ms),
    createdAtMs: Number(row.created_at_ms),
    executedAtMs: row.executed_at_ms === null ? undefined : Number(row.executed_at_ms),
  };
}

function safeJson(value: unknown): string {
  return JSON.stringify(value ?? {});
}

export class PendingMutationRepository {
  constructor(private readonly db: Database.Database) {}

  async create(input: Omit<PendingMutationRecord, 'status' | 'createdAtMs' | 'executedAtMs'>): Promise<PendingMutationRecord> {
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO pending_mutations (
          proposal_id, thread_id, client_channel, agent, action, effect, route_key, preview, payload_json, status, expires_at_ms, created_at_ms, executed_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, NULL)`,
      )
      .run(
        input.proposalId,
        input.threadId,
        input.clientChannel ?? null,
        input.agent,
        input.action,
        input.effect,
        input.routeKey ?? null,
        input.preview,
        safeJson(input.payload),
        input.expiresAtMs,
        now,
      );
    const created = await this.findByProposalId(input.proposalId);
    if (!created) throw new Error(`pending_mutation_create_failed:${input.proposalId}`);
    return created;
  }

  async findByProposalId(proposalId: string): Promise<PendingMutationRecord | null> {
    const row = this.db
      .prepare(
        `SELECT proposal_id, thread_id, client_channel, agent, action, effect, route_key, preview, payload_json, status, expires_at_ms, created_at_ms, executed_at_ms
         FROM pending_mutations
         WHERE proposal_id = ?`,
      )
      .get(proposalId) as PendingMutationRow | undefined;
    return row ? mapRow(row) : null;
  }

  async findActiveByThread(threadId: string): Promise<PendingMutationRecord | null> {
    const row = this.db
      .prepare(
        `SELECT proposal_id, thread_id, client_channel, agent, action, effect, route_key, preview, payload_json, status, expires_at_ms, created_at_ms, executed_at_ms
         FROM pending_mutations
         WHERE thread_id = ? AND status = 'pending'
         ORDER BY created_at_ms DESC
         LIMIT 1`,
      )
      .get(threadId) as PendingMutationRow | undefined;
    return row ? mapRow(row) : null;
  }

  async listPendingByThread(threadId: string): Promise<PendingMutationRecord[]> {
    const rows = this.db
      .prepare(
        `SELECT proposal_id, thread_id, client_channel, agent, action, effect, route_key, preview, payload_json, status, expires_at_ms, created_at_ms, executed_at_ms
         FROM pending_mutations
         WHERE thread_id = ? AND status = 'pending'
         ORDER BY created_at_ms DESC`,
      )
      .all(threadId) as PendingMutationRow[];
    return rows.map(mapRow);
  }

  async expirePending(nowMs = Date.now()): Promise<number> {
    const result = this.db
      .prepare("UPDATE pending_mutations SET status = 'cancelled' WHERE status = 'pending' AND expires_at_ms <= ?")
      .run(nowMs);
    return Number(result.changes ?? 0);
  }

  async cancel(proposalId: string, reason?: string): Promise<PendingMutationRecord | null> {
    const current = await this.findByProposalId(proposalId);
    if (!current) return null;
    if (current.status === 'pending') {
      const payload = { ...(typeof current.payload === 'object' && current.payload ? current.payload as Record<string, unknown> : {}), cancelledReason: reason };
      this.db
        .prepare("UPDATE pending_mutations SET status = 'cancelled', payload_json = ? WHERE proposal_id = ? AND status = 'pending'")
        .run(safeJson(payload), proposalId);
    }
    return this.findByProposalId(proposalId);
  }

  async cancelActiveByThread(threadId: string, reason?: string): Promise<PendingMutationRecord | null> {
    const active = await this.findActiveByThread(threadId);
    if (!active) return null;
    return this.cancel(active.proposalId, reason);
  }

  async tryStartExecution(proposalId: string): Promise<'started' | 'not_found' | PendingMutationStatus> {
    const result = this.db
      .prepare("UPDATE pending_mutations SET status = 'executing' WHERE proposal_id = ? AND status = 'pending'")
      .run(proposalId);
    if (Number(result.changes ?? 0) === 1) return 'started';
    const current = await this.findByProposalId(proposalId);
    return current?.status ?? 'not_found';
  }

  async markExecuted(proposalId: string): Promise<void> {
    this.db
      .prepare("UPDATE pending_mutations SET status = 'executed', executed_at_ms = ? WHERE proposal_id = ?")
      .run(Date.now(), proposalId);
  }

  async markFailed(proposalId: string, safeMessage: string): Promise<void> {
    const current = await this.findByProposalId(proposalId);
    const payload = {
      ...(typeof current?.payload === 'object' && current.payload ? current.payload as Record<string, unknown> : {}),
      failureMessage: safeMessage,
    };
    this.db
      .prepare("UPDATE pending_mutations SET status = 'failed', executed_at_ms = ?, payload_json = ? WHERE proposal_id = ?")
      .run(Date.now(), safeJson(payload), proposalId);
  }
}
