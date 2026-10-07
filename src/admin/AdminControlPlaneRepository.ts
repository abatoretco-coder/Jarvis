import { createHash, randomUUID } from 'node:crypto';

import Database from 'better-sqlite3';

import type { RoleKey } from '../identity/IdentityRepository';

export type AuditOutcome = 'success' | 'denied' | 'failed';
export type AdminMutationContext = {
  actorUserId: string;
  idempotencyKey: string;
  action: string;
  targetType: string;
  targetId?: string;
  correlationId?: string;
  clientIp?: string;
  clientReference?: string;
};

type AuditMetadata = Record<string, string | number | boolean | null>;

const grantPermissionsByResource: Record<string, ReadonlySet<string>> = {
  domain: new Set(['view', 'control', 'manage']),
  area: new Set(['view', 'control', 'manage']),
  device: new Set(['view', 'control', 'manage']),
  capability: new Set(['view', 'control', 'manage']),
  camera: new Set(['view', 'control', 'manage', 'stream']),
  lock: new Set(['view', 'control', 'manage']),
  'nas.operation': new Set(['view', 'control', 'manage']),
};

function parseJsonArray(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === 'string')
      : [];
  } catch {
    return [];
  }
}

function sanitizeMetadataValue(value: unknown, key = '', depth = 0): unknown {
  if (/(?:authorization|cookie|credential|password|secret|token|api[_-]?key)/iu.test(key))
    return '[redacted]';
  if (depth >= 4) return '[truncated]';
  if (typeof value === 'string') return value.slice(0, 2_048);
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return value;
  if (Array.isArray(value))
    return value.slice(0, 50).map((item) => sanitizeMetadataValue(item, '', depth + 1));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .slice(0, 50)
        .map(([childKey, childValue]) => [
          childKey,
          sanitizeMetadataValue(childValue, childKey, depth + 1),
        ])
    );
  }
  return undefined;
}

function parseJsonObject(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return sanitizeMetadataValue(parsed) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function auditMetadata(context: AdminMutationContext, metadata: AuditMetadata): AuditMetadata {
  return {
    ...metadata,
    ...(context.clientIp ? { clientIp: context.clientIp.slice(0, 64) } : {}),
    ...(context.clientReference ? { clientReference: context.clientReference.slice(0, 160) } : {}),
  };
}

export function adminRequestFingerprint(
  action: string,
  targetId: string | undefined,
  body: unknown
): string {
  return createHash('sha256')
    .update(JSON.stringify({ action, targetId: targetId ?? null, body: body ?? null }))
    .digest('hex');
}

export class AdminControlPlaneRepository {
  constructor(private readonly db: Database.Database) {}

  executeMutation<T>(
    context: AdminMutationContext,
    requestFingerprint: string,
    mutation: () => T,
    metadata: AuditMetadata = {},
    now = Date.now()
  ): { value: T; replayed: boolean } {
    return this.db.transaction(() => {
      this.db
        .prepare('DELETE FROM admin_idempotency_keys WHERE created_at_ms < ?')
        .run(now - 86_400_000);
      const existing = this.db
        .prepare(
          `SELECT request_fingerprint requestFingerprint,response_json responseJson
        FROM admin_idempotency_keys WHERE actor_user_id=? AND idempotency_key=?`
        )
        .get(context.actorUserId, context.idempotencyKey) as
        { requestFingerprint: string; responseJson: string } | undefined;
      if (existing) {
        if (existing.requestFingerprint !== requestFingerprint)
          throw new Error('admin_idempotency_conflict');
        return { value: JSON.parse(existing.responseJson) as T, replayed: true };
      }

      const value = mutation();
      const responseJson = JSON.stringify(value ?? null);
      this.db
        .prepare(
          `INSERT INTO audit_events(
        event_id,actor_kind,actor_id,action,target_type,target_id,outcome,correlation_id,metadata_json,created_at_ms
      ) VALUES (?,'user',?,?,?,?, 'success',?,?,?)`
        )
        .run(
          randomUUID(),
          context.actorUserId,
          context.action,
          context.targetType,
          context.targetId ?? null,
          context.correlationId ?? null,
          JSON.stringify(auditMetadata(context, metadata)),
          now
        );
      this.db
        .prepare(
          `INSERT INTO admin_idempotency_keys(
        actor_user_id,idempotency_key,request_fingerprint,response_json,created_at_ms
      ) VALUES (?,?,?,?,?)`
        )
        .run(context.actorUserId, context.idempotencyKey, requestFingerprint, responseJson, now);
      return { value, replayed: false };
    })();
  }

  recordAudit(
    input: Omit<AdminMutationContext, 'idempotencyKey'> & {
      outcome: AuditOutcome;
      metadata?: AuditMetadata;
    },
    now = Date.now()
  ): void {
    this.recordActorAudit(
      {
        actorKind: 'user',
        actorId: input.actorUserId,
        action: input.action,
        targetType: input.targetType,
        targetId: input.targetId,
        outcome: input.outcome,
        correlationId: input.correlationId,
        clientIp: input.clientIp,
        clientReference: input.clientReference,
        metadata: input.metadata,
      },
      now
    );
  }

  recordActorAudit(
    input: {
      actorKind: 'user' | 'service' | 'system';
      actorId?: string;
      action: string;
      targetType: string;
      targetId?: string;
      outcome: AuditOutcome;
      correlationId?: string;
      clientIp?: string;
      clientReference?: string;
      metadata?: AuditMetadata;
    },
    now = Date.now()
  ): void {
    this.db
      .prepare(
        `INSERT INTO audit_events(
      event_id,actor_kind,actor_id,action,target_type,target_id,outcome,correlation_id,metadata_json,created_at_ms
    ) VALUES (?,?,?,?,?,?,?,?,?,?)`
      )
      .run(
        randomUUID(),
        input.actorKind,
        input.actorId ?? null,
        input.action,
        input.targetType,
        input.targetId ?? null,
        input.outcome,
        input.correlationId ?? null,
        JSON.stringify({
          ...(input.metadata ?? {}),
          ...(input.clientIp ? { clientIp: input.clientIp.slice(0, 64) } : {}),
          ...(input.clientReference
            ? { clientReference: input.clientReference.slice(0, 160) }
            : {}),
        }),
        now
      );
  }

  listHouseholds(): Array<Record<string, unknown>> {
    return this.db
      .prepare(
        `SELECT h.household_id householdId,h.name,h.created_by_user_id createdByUserId,
      h.created_at_ms createdAtMs,h.updated_at_ms updatedAtMs,
      SUM(CASE WHEN hm.status='active' THEN 1 ELSE 0 END) activeMemberCount
      FROM households h LEFT JOIN household_memberships hm ON hm.household_id=h.household_id
      GROUP BY h.household_id ORDER BY h.created_at_ms ASC`
      )
      .all() as Array<Record<string, unknown>>;
  }

  getUserMetadata(userId: string, now = Date.now()): Record<string, unknown> | null {
    const row = this.db
      .prepare(
        `SELECT created_at_ms createdAtMs,updated_at_ms updatedAtMs,
      last_login_at_ms lastLoginAtMs,
      (SELECT COUNT(*) FROM auth_sessions s
        WHERE s.user_id=u.user_id AND s.status='active' AND s.expires_at_ms>?) activeSessionCount
      FROM users u WHERE user_id=?`
      )
      .get(now, userId) as Record<string, unknown> | undefined;
    return row ?? null;
  }

  listRolePermissions(): Record<string, string[]> {
    const rows = this.db
      .prepare(
        `SELECT role_key role,permission_key permission
      FROM role_permissions ORDER BY role_key,permission_key`
      )
      .all() as Array<{ role: string; permission: string }>;
    return rows.reduce<Record<string, string[]>>((result, row) => {
      (result[row.role] ??= []).push(row.permission);
      return result;
    }, {});
  }

  listMemberships(householdId: string): Array<Record<string, unknown>> {
    return this.db
      .prepare(
        `SELECT hm.household_id householdId,hm.user_id userId,u.email_normalized email,
      u.display_name displayName,hm.role_key role,hm.status,hm.created_at_ms createdAtMs,hm.updated_at_ms updatedAtMs
      FROM household_memberships hm JOIN users u ON u.user_id=hm.user_id
      WHERE hm.household_id=? ORDER BY u.email_normalized`
      )
      .all(householdId) as Array<Record<string, unknown>>;
  }

  getMembership(
    householdId: string,
    userId: string
  ): { role: RoleKey; status: 'active' | 'revoked' } | null {
    const row = this.db
      .prepare(
        `SELECT role_key role,status FROM household_memberships
      WHERE household_id=? AND user_id=?`
      )
      .get(householdId, userId) as
      | {
          role: RoleKey;
          status: 'active' | 'revoked';
        }
      | undefined;
    return row ?? null;
  }

  listUserMemberships(userId: string): Array<Record<string, unknown>> {
    return this.db
      .prepare(
        `SELECT hm.household_id householdId,h.name,hm.role_key role,hm.status,
      hm.created_at_ms createdAtMs,hm.updated_at_ms updatedAtMs
      FROM household_memberships hm JOIN households h ON h.household_id=hm.household_id
      WHERE hm.user_id=? ORDER BY h.name`
      )
      .all(userId) as Array<Record<string, unknown>>;
  }

  setMembership(
    input: { householdId: string; userId: string; role: RoleKey; status: 'active' | 'revoked' },
    now = Date.now()
  ): Record<string, unknown> {
    const household = this.db
      .prepare('SELECT 1 found FROM households WHERE household_id=?')
      .get(input.householdId);
    const user = this.db.prepare('SELECT status FROM users WHERE user_id=?').get(input.userId) as
      { status: string } | undefined;
    if (!household) throw new Error('admin_household_not_found');
    if (!user) throw new Error('admin_user_not_found');
    if (input.status === 'active' && user.status !== 'active')
      throw new Error('admin_user_not_active');
    const existing = this.db
      .prepare(
        `SELECT role_key role,status FROM household_memberships
      WHERE household_id=? AND user_id=?`
      )
      .get(input.householdId, input.userId) as { role: RoleKey; status: string } | undefined;
    if (
      existing?.role === 'owner' &&
      existing.status === 'active' &&
      (input.role !== 'owner' || input.status !== 'active')
    ) {
      const owners = this.db
        .prepare(
          `SELECT COUNT(*) count FROM household_memberships
        WHERE household_id=? AND role_key='owner' AND status='active'`
        )
        .get(input.householdId) as { count: number };
      if (Number(owners.count) <= 1) throw new Error('admin_last_household_owner');
    }
    this.db
      .prepare(
        `INSERT INTO household_memberships(
      household_id,user_id,role_key,status,created_at_ms,updated_at_ms
    ) VALUES (?,?,?,?,?,?) ON CONFLICT(household_id,user_id) DO UPDATE SET
      role_key=excluded.role_key,status=excluded.status,updated_at_ms=excluded.updated_at_ms`
      )
      .run(input.householdId, input.userId, input.role, input.status, now, now);
    return this.listMemberships(input.householdId).find(
      (row) => row.userId === input.userId
    ) as Record<string, unknown>;
  }

  listGrants(): Array<Record<string, unknown>> {
    const rows = this.db
      .prepare(
        `SELECT grant_id grantId,resource_type resourceType,resource_id resourceId,
      grantee_user_id granteeUserId,grantee_household_id granteeHouseholdId,permissions_json permissionsJson,
      created_by_user_id createdByUserId,created_at_ms createdAtMs,expires_at_ms expiresAtMs,revoked_at_ms revokedAtMs
      FROM resource_grants ORDER BY created_at_ms DESC`
      )
      .all() as Array<Record<string, unknown> & { permissionsJson: string }>;
    return rows.map(({ permissionsJson, ...row }) => ({
      ...row,
      permissions: parseJsonArray(permissionsJson),
    }));
  }

  listActiveGrants(now = Date.now()): Array<Record<string, unknown>> {
    return this.listGrants().filter(
      (grant) =>
        grant.revokedAtMs === null &&
        (grant.expiresAtMs === null || Number(grant.expiresAtMs) > now)
    );
  }

  getGrant(grantId: string): Record<string, unknown> | null {
    return this.listGrants().find((grant) => grant.grantId === grantId) ?? null;
  }

  createGrant(
    input: {
      resourceType: string;
      resourceId: string;
      granteeUserId?: string;
      granteeHouseholdId?: string;
      permissions: string[];
      createdByUserId: string;
      expiresAtMs?: number;
    },
    now = Date.now()
  ): Record<string, unknown> {
    const allowedPermissions = grantPermissionsByResource[input.resourceType];
    if (
      !allowedPermissions ||
      input.permissions.some((permission) => !allowedPermissions.has(permission))
    ) {
      throw new Error('admin_grant_permissions_invalid');
    }
    if (input.expiresAtMs !== undefined && input.expiresAtMs <= now) {
      throw new Error('admin_grant_expiry_invalid');
    }
    if (input.granteeUserId) {
      const user = this.db
        .prepare("SELECT 1 found FROM users WHERE user_id=? AND status='active'")
        .get(input.granteeUserId);
      if (!user) throw new Error('admin_grantee_not_found');
    } else if (input.granteeHouseholdId) {
      const household = this.db
        .prepare('SELECT 1 found FROM households WHERE household_id=?')
        .get(input.granteeHouseholdId);
      if (!household) throw new Error('admin_grantee_not_found');
    } else {
      throw new Error('admin_grantee_not_found');
    }
    const grantId = randomUUID();
    this.db
      .prepare(
        `INSERT INTO resource_grants(
      grant_id,resource_type,resource_id,grantee_user_id,grantee_household_id,permissions_json,
      created_by_user_id,created_at_ms,expires_at_ms
    ) VALUES (?,?,?,?,?,?,?,?,?)`
      )
      .run(
        grantId,
        input.resourceType,
        input.resourceId,
        input.granteeUserId ?? null,
        input.granteeHouseholdId ?? null,
        JSON.stringify([...new Set(input.permissions)].sort()),
        input.createdByUserId,
        now,
        input.expiresAtMs ?? null
      );
    return this.listGrants().find((grant) => grant.grantId === grantId) as Record<string, unknown>;
  }

  revokeGrant(grantId: string, now = Date.now()): Record<string, unknown> {
    const changed = this.db
      .prepare(
        `UPDATE resource_grants SET revoked_at_ms=?
      WHERE grant_id=? AND revoked_at_ms IS NULL`
      )
      .run(now, grantId);
    if (changed.changes !== 1) throw new Error('admin_grant_not_found_or_revoked');
    return this.listGrants().find((grant) => grant.grantId === grantId) as Record<string, unknown>;
  }

  listIntegrations(): Array<Record<string, unknown>> {
    const rows = this.db
      .prepare(
        `SELECT connection_id connectionId,owner_user_id ownerUserId,
      household_id householdId,provider,connection_kind connectionKind,display_name displayName,
      provider_email providerEmail,scopes_json scopesJson,status,last_sync_at_ms lastSyncAtMs,
      last_error_code lastErrorCode,created_at_ms createdAtMs,updated_at_ms updatedAtMs,revoked_at_ms revokedAtMs
      FROM integration_connections ORDER BY updated_at_ms DESC`
      )
      .all() as Array<Record<string, unknown> & { scopesJson: string }>;
    return rows.map(({ scopesJson, ...row }) => ({
      ...row,
      lastErrorCode:
        typeof row.lastErrorCode === 'string' && /^[A-Za-z0-9_.:-]{1,96}$/u.test(row.lastErrorCode)
          ? row.lastErrorCode
          : row.lastErrorCode === null
            ? null
            : 'integration_error',
      scopes: parseJsonArray(scopesJson),
    }));
  }

  revokeIntegration(connectionId: string, now = Date.now()): Record<string, unknown> {
    this.db.transaction(() => {
      const existing = this.db.prepare(
        `SELECT credential_reference credentialReference FROM integration_connections
         WHERE connection_id=? AND status<>'revoked'`
      ).get(connectionId) as { credentialReference: string | null } | undefined;
      if (!existing) throw new Error('admin_integration_not_found_or_revoked');
      this.db.prepare(
        `UPDATE integration_connections SET
         status='revoked',credential_reference=NULL,last_error_code=NULL,revoked_at_ms=?,updated_at_ms=?
         WHERE connection_id=?`
      ).run(now, now, connectionId);
      if (existing.credentialReference) {
        this.db.prepare('DELETE FROM integration_credentials WHERE credential_id=?')
          .run(existing.credentialReference);
      }
      this.db.prepare(
        `UPDATE resource_grants SET revoked_at_ms=?
         WHERE resource_type='integration_connection' AND resource_id=? AND revoked_at_ms IS NULL`
      ).run(now, connectionId);
    })();
    return this.listIntegrations().find((item) => item.connectionId === connectionId) as Record<
      string,
      unknown
    >;
  }

  listAudit(input: {
    limit: number;
    cursor?: { createdAtMs: number; eventId: string };
    beforeMs?: number;
    afterMs?: number;
    actorId?: string;
    targetType?: string;
    action?: string;
    outcome?: AuditOutcome;
  }): {
    events: Array<Record<string, unknown>>;
    nextCursor?: string;
  } {
    const conditions: string[] = [];
    const parameters: unknown[] = [];
    if (input.cursor) {
      conditions.push('(created_at_ms < ? OR (created_at_ms = ? AND event_id < ?))');
      parameters.push(input.cursor.createdAtMs, input.cursor.createdAtMs, input.cursor.eventId);
    } else if (input.beforeMs !== undefined) {
      conditions.push('created_at_ms < ?');
      parameters.push(input.beforeMs);
    }
    if (input.afterMs !== undefined) {
      conditions.push('created_at_ms >= ?');
      parameters.push(input.afterMs);
    }
    if (input.actorId) {
      conditions.push('actor_id = ?');
      parameters.push(input.actorId);
    }
    if (input.targetType) {
      conditions.push('target_type = ?');
      parameters.push(input.targetType);
    }
    if (input.action) {
      conditions.push('action = ?');
      parameters.push(input.action);
    }
    if (input.outcome) {
      conditions.push('outcome = ?');
      parameters.push(input.outcome);
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const rows = this.db
      .prepare(
        `SELECT event_id eventId,actor_kind actorKind,actor_id actorId,action,
      target_type targetType,target_id targetId,outcome,correlation_id correlationId,
      metadata_json metadataJson,created_at_ms createdAtMs
      FROM audit_events ${where} ORDER BY created_at_ms DESC,event_id DESC LIMIT ?`
      )
      .all(...parameters, input.limit + 1) as Array<
      Record<string, unknown> & { metadataJson: string; createdAtMs: number }
    >;
    const hasMore = rows.length > input.limit;
    const page = rows.slice(0, input.limit);
    return {
      events: page.map(({ metadataJson, ...row }) => ({
        ...row,
        metadata: parseJsonObject(metadataJson),
      })),
      ...(hasMore && page.at(-1)
        ? {
            nextCursor: Buffer.from(
              JSON.stringify({
                createdAtMs: page.at(-1)?.createdAtMs,
                eventId: page.at(-1)?.eventId,
              })
            ).toString('base64url'),
          }
        : {}),
    };
  }
}

export function parseAuditCursor(value: string): { createdAtMs: number; eventId: string } | null {
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const candidate = parsed as Record<string, unknown>;
    if (!Number.isSafeInteger(candidate.createdAtMs) || Number(candidate.createdAtMs) <= 0)
      return null;
    if (
      typeof candidate.eventId !== 'string' ||
      !/^[A-Za-z0-9._:-]{1,128}$/u.test(candidate.eventId)
    )
      return null;
    return { createdAtMs: Number(candidate.createdAtMs), eventId: candidate.eventId };
  } catch {
    return null;
  }
}
