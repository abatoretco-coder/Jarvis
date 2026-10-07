import { randomUUID } from 'node:crypto';

import Database from 'better-sqlite3';

export type UserStatus = 'pending' | 'active' | 'suspended' | 'rejected' | 'revoked';
export type RoleKey = 'owner' | 'resident' | 'guest';
export type PermissionKey =
  | 'chat'
  | 'history'
  | 'mail'
  | 'calendar'
  | 'todo'
  | 'music'
  | 'home'
  | 'cameras'
  | 'admin'
  | 'nas.operations';
export type JarvisUser = { userId: string; email: string; displayName: string; status: UserStatus };
export type AuthorizedUser = JarvisUser & { roles: RoleKey[]; permissions: PermissionKey[] };
export type AuthSession = {
  sessionId: string;
  status: 'active' | 'revoked' | 'expired';
  createdAtMs: number;
  expiresAtMs: number;
  lastSeenAtMs: number;
};

function normalizeEmail(email: string): string {
  const normalized = email.trim().toLocaleLowerCase('en-US');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(normalized) || normalized.length > 320) {
    throw new Error('identity_invalid_email');
  }
  return normalized;
}

function normalizeIssuer(value: string): string {
  try {
    const issuer = new URL(value.trim());
    if (issuer.protocol !== 'https:' && issuer.protocol !== 'http:') throw new Error();
    return issuer.toString().replace(/\/$/u, '');
  } catch {
    throw new Error('identity_invalid_issuer');
  }
}

export class IdentityRepository {
  constructor(private readonly db: Database.Database) {}

  provisionOidcIdentity(
    input: {
      issuer: string;
      subject: string;
      email: string;
      emailVerified: boolean;
      displayName?: string;
    },
    now = Date.now()
  ): JarvisUser {
    if (!input.emailVerified) throw new Error('identity_email_not_verified');
    const issuer = normalizeIssuer(input.issuer);
    const subject = input.subject.trim();
    const hasControlCharacter = [...subject].some((character) => character.charCodeAt(0) < 32);
    if (!subject || issuer.length > 512 || subject.length > 512 || hasControlCharacter)
      throw new Error('identity_invalid_subject');
    const email = normalizeEmail(input.email);
    return this.db.transaction(() => {
      const existing = this.db
        .prepare(
          `SELECT u.user_id userId,u.email_normalized email,u.display_name displayName,u.status
        FROM oidc_identities i JOIN users u ON u.user_id=i.user_id WHERE i.issuer=? AND i.subject=?`
        )
        .get(issuer, subject) as JarvisUser | undefined;
      if (existing) {
        this.db
          .prepare('UPDATE oidc_identities SET last_seen_at_ms=? WHERE issuer=? AND subject=?')
          .run(now, issuer, subject);
        this.db
          .prepare('UPDATE users SET last_login_at_ms=?,updated_at_ms=? WHERE user_id=?')
          .run(now, now, existing.userId);
        return existing;
      }
      const userId = randomUUID();
      this.db
        .prepare(
          `INSERT INTO users(user_id,email_normalized,display_name,status,created_at_ms,updated_at_ms,last_login_at_ms)
        VALUES (?,?,?,'pending',?,?,?)`
        )
        .run(userId, email, input.displayName?.trim().slice(0, 160) ?? '', now, now, now);
      this.db
        .prepare(
          `INSERT INTO oidc_identities(issuer,subject,user_id,email_verified,created_at_ms,last_seen_at_ms)
        VALUES (?,?,?,1,?,?)`
        )
        .run(issuer, subject, userId, now, now);
      return {
        userId,
        email,
        displayName: input.displayName?.trim().slice(0, 160) ?? '',
        status: 'pending' as const,
      };
    })();
  }

  changeStatus(userId: string, expected: UserStatus, next: UserStatus, now = Date.now()): boolean {
    const allowed: Record<UserStatus, UserStatus[]> = {
      pending: ['active', 'rejected'],
      active: ['suspended', 'revoked'],
      suspended: ['active', 'revoked'],
      rejected: [],
      revoked: [],
    };
    if (!allowed[expected].includes(next)) throw new Error('identity_invalid_status_transition');
    return this.db.transaction(() => {
      const changed =
        this.db
          .prepare('UPDATE users SET status=?,updated_at_ms=? WHERE user_id=? AND status=?')
          .run(next, now, userId, expected).changes === 1;
      if (changed && (next === 'suspended' || next === 'revoked')) {
        const owner = this.db
          .prepare(
            `SELECT 1 found FROM user_roles
          WHERE user_id=? AND role_key='owner'`
          )
          .get(userId);
        if (owner && this.countActiveOwners() === 0) throw new Error('identity_last_owner');
      }
      if (changed && next === 'revoked') {
        const orphanedHousehold = this.db
          .prepare(
            `SELECT hm.household_id householdId
          FROM household_memberships hm
          WHERE hm.user_id=? AND hm.role_key='owner' AND hm.status='active'
            AND NOT EXISTS (
              SELECT 1 FROM household_memberships other
              JOIN users u ON u.user_id=other.user_id
              WHERE other.household_id=hm.household_id AND other.user_id<>hm.user_id
                AND other.role_key='owner' AND other.status='active' AND u.status='active'
            ) LIMIT 1`
          )
          .get(userId);
        if (orphanedHousehold) throw new Error('identity_last_household_owner');
      }
      if (changed && (next === 'suspended' || next === 'revoked')) {
        this.db
          .prepare(
            "UPDATE auth_sessions SET status='revoked',revoked_at_ms=? WHERE user_id=? AND status='active'"
          )
          .run(now, userId);
      }
      if (changed && next === 'revoked') {
        const credentialRows = this.db.prepare(
          `SELECT credential_reference credentialReference FROM integration_connections
           WHERE owner_user_id=? AND credential_reference IS NOT NULL`
        ).all(userId) as Array<{ credentialReference: string }>;
        this.db
          .prepare(
            `UPDATE household_memberships SET status='revoked',updated_at_ms=?
          WHERE user_id=? AND status='active'`
          )
          .run(now, userId);
        this.db
          .prepare(
            `UPDATE resource_grants SET revoked_at_ms=?
          WHERE grantee_user_id=? AND revoked_at_ms IS NULL`
          )
          .run(now, userId);
        this.db
          .prepare(
            `UPDATE integration_connections SET status='revoked',credential_reference=NULL,
          last_error_code=NULL,revoked_at_ms=?,updated_at_ms=?
          WHERE owner_user_id=? AND status<>'revoked'`
          )
          .run(now, now, userId);
        const deleteCredential = this.db.prepare(
          'DELETE FROM integration_credentials WHERE credential_id=?'
        );
        credentialRows.forEach((row) => deleteCredential.run(row.credentialReference));
      }
      return changed;
    })();
  }

  findAuthorizedUser(userId: string): AuthorizedUser | null {
    const user = this.db
      .prepare(
        `SELECT user_id userId,email_normalized email,display_name displayName,status
      FROM users WHERE user_id=?`
      )
      .get(userId) as JarvisUser | undefined;
    if (!user) return null;
    const roles = this.db
      .prepare('SELECT role_key role FROM user_roles WHERE user_id=? ORDER BY role_key')
      .all(userId) as Array<{ role: RoleKey }>;
    const permissions = this.db
      .prepare(
        `SELECT DISTINCT rp.permission_key permission
      FROM user_roles ur JOIN role_permissions rp ON rp.role_key=ur.role_key
      WHERE ur.user_id=? ORDER BY rp.permission_key`
      )
      .all(userId) as Array<{ permission: PermissionKey }>;
    return {
      ...user,
      roles: roles.map((row) => row.role),
      permissions: permissions.map((row) => row.permission),
    };
  }

  listUsers(): AuthorizedUser[] {
    const rows = this.db
      .prepare(
        `SELECT user_id userId,email_normalized email,display_name displayName,status
      FROM users ORDER BY created_at_ms ASC`
      )
      .all() as JarvisUser[];
    return rows.map((user) => this.findAuthorizedUser(user.userId) as AuthorizedUser);
  }

  bootstrapOwner(userId: string, now = Date.now()): AuthorizedUser {
    return this.db.transaction(() => {
      const user = this.findAuthorizedUser(userId);
      if (!user) throw new Error('identity_user_not_found');
      this.db
        .prepare(
          `UPDATE users SET status='active',updated_at_ms=?
        WHERE user_id=? AND status='pending'`
        )
        .run(now, userId);
      this.db
        .prepare(
          `INSERT OR IGNORE INTO user_roles(user_id,role_key,granted_at_ms)
        VALUES (?,'owner',?)`
        )
        .run(userId, now);
      this.ensureOwnerHousehold(userId, now);
      return this.findAuthorizedUser(userId) as AuthorizedUser;
    })();
  }

  ensureOwnerHousehold(userId: string, now = Date.now()): string {
    const owner = this.findAuthorizedUser(userId);
    if (!owner || owner.status !== 'active' || !owner.roles.includes('owner')) {
      throw new Error('identity_owner_required');
    }
    const householdId = `home:${userId}`;
    this.db
      .prepare(
        `INSERT OR IGNORE INTO households(
      household_id,name,created_by_user_id,created_at_ms,updated_at_ms
    ) VALUES (?,'Domicile principal',?,?,?)`
      )
      .run(householdId, userId, now, now);
    this.db
      .prepare(
        `INSERT OR IGNORE INTO household_memberships(
      household_id,user_id,role_key,status,created_at_ms,updated_at_ms
    ) VALUES (?,?,'owner','active',?,?)`
      )
      .run(householdId, userId, now, now);
    return householdId;
  }

  claimLegacyConversationData(userId: string, now = Date.now(), batchSize = 250): number {
    const owner = this.findAuthorizedUser(userId);
    if (!owner || owner.status !== 'active' || !owner.roles.includes('owner')) {
      throw new Error('identity_owner_required');
    }
    const safeBatchSize = Math.max(1, Math.min(Math.floor(batchSize), 1_000));
    let claimedTotal = 0;

    while (true) {
      const claimed = this.db.transaction(() => {
        const rows = this.db
          .prepare(
            `SELECT thread_id threadId FROM conversation_threads
          WHERE owner_user_id IS NULL AND owner_service_id IS NULL
          ORDER BY rowid ASC LIMIT ?`
          )
          .all(safeBatchSize) as Array<{ threadId: string }>;
        if (rows.length === 0) return 0;
        const placeholders = rows.map(() => '?').join(',');
        const threadIds = rows.map((row) => row.threadId);
        const changed = this.db
          .prepare(
            `UPDATE conversation_threads SET owner_user_id=?
          WHERE owner_user_id IS NULL AND owner_service_id IS NULL
            AND thread_id IN (${placeholders})`
          )
          .run(userId, ...threadIds).changes;
        this.db
          .prepare(
            `UPDATE pending_mutations SET owner_user_id=?
          WHERE owner_user_id IS NULL AND owner_service_id IS NULL
            AND thread_id IN (${placeholders})`
          )
          .run(userId, ...threadIds);
        this.db
          .prepare(
            `UPDATE conversation_result_sets SET owner_user_id=?
          WHERE owner_user_id IS NULL AND owner_service_id IS NULL
            AND thread_id IN (${placeholders})`
          )
          .run(userId, ...threadIds);
        this.db
          .prepare(
            `INSERT INTO audit_events(
          event_id,actor_kind,actor_id,action,target_type,target_id,outcome,metadata_json,created_at_ms
        ) VALUES (?,'system',NULL,'conversation_ownership_backfill_batch','user',?,'success',?,?)`
          )
          .run(
            randomUUID(),
            userId,
            JSON.stringify({ claimedThreads: Number(changed), batchSize: safeBatchSize }),
            now
          );
        return Number(changed);
      })();
      if (claimed === 0) break;
      claimedTotal += claimed;
    }
    return claimedTotal;
  }

  approveUser(userId: string, role: RoleKey, now = Date.now()): AuthorizedUser {
    return this.db.transaction(() => {
      const changed = this.db
        .prepare(
          `UPDATE users SET status='active',updated_at_ms=?
        WHERE user_id=? AND status='pending'`
        )
        .run(now, userId);
      if (changed.changes !== 1) throw new Error('identity_approval_conflict');
      this.db
        .prepare('INSERT INTO user_roles(user_id,role_key,granted_at_ms) VALUES (?,?,?)')
        .run(userId, role, now);
      return this.findAuthorizedUser(userId) as AuthorizedUser;
    })();
  }

  replaceRoles(userId: string, roles: RoleKey[], now = Date.now()): AuthorizedUser {
    const uniqueRoles = [...new Set(roles)];
    if (uniqueRoles.length !== 1) throw new Error('identity_single_role_required');
    return this.db.transaction(() => {
      const user = this.findAuthorizedUser(userId);
      if (!user) throw new Error('identity_user_not_found');
      if (user.status !== 'active' && user.status !== 'suspended')
        throw new Error('identity_role_status_invalid');
      if (
        user.roles.includes('owner') &&
        !uniqueRoles.includes('owner') &&
        this.countActiveOwners() <= 1
      ) {
        throw new Error('identity_last_owner');
      }
      this.db.prepare('DELETE FROM user_roles WHERE user_id=?').run(userId);
      const insert = this.db.prepare(
        'INSERT INTO user_roles(user_id,role_key,granted_at_ms) VALUES (?,?,?)'
      );
      uniqueRoles.forEach((role) => insert.run(userId, role, now));
      return this.findAuthorizedUser(userId) as AuthorizedUser;
    })();
  }

  changeStatusSafely(
    userId: string,
    expected: UserStatus,
    next: UserStatus,
    now = Date.now()
  ): boolean {
    return this.changeStatus(userId, expected, next, now);
  }

  touchSession(
    input: { userId: string; providerSessionId: string; expiresAtMs: number },
    now = Date.now()
  ): AuthSession {
    if (
      !input.providerSessionId ||
      input.providerSessionId.length > 1024 ||
      input.expiresAtMs <= now
    ) {
      throw new Error('identity_invalid_session');
    }
    return this.db.transaction(() => {
      const existing = this.db
        .prepare(
          `SELECT session_id sessionId,user_id userId,status,created_at_ms createdAtMs,
        expires_at_ms expiresAtMs,last_seen_at_ms lastSeenAtMs FROM auth_sessions
        WHERE provider_session_id=?`
        )
        .get(input.providerSessionId) as (AuthSession & { userId: string }) | undefined;
      if (existing) {
        if (existing.userId !== input.userId) throw new Error('identity_session_subject_mismatch');
        if (existing.status === 'revoked') return existing;
        this.db
          .prepare(
            `UPDATE auth_sessions SET status='active',expires_at_ms=?,last_seen_at_ms=?
          WHERE session_id=?`
          )
          .run(input.expiresAtMs, now, existing.sessionId);
        return {
          ...existing,
          status: 'active' as const,
          expiresAtMs: input.expiresAtMs,
          lastSeenAtMs: now,
        };
      }
      const sessionId = randomUUID();
      this.db
        .prepare(
          `INSERT INTO auth_sessions(
        session_id,user_id,provider_session_id,status,created_at_ms,expires_at_ms,last_seen_at_ms
      ) VALUES (?,?,?,'active',?,?,?)`
        )
        .run(sessionId, input.userId, input.providerSessionId, now, input.expiresAtMs, now);
      return {
        sessionId,
        status: 'active' as const,
        createdAtMs: now,
        expiresAtMs: input.expiresAtMs,
        lastSeenAtMs: now,
      };
    })();
  }

  listSessions(userId: string, now = Date.now()): AuthSession[] {
    this.db
      .prepare(
        `UPDATE auth_sessions SET status='expired'
      WHERE user_id=? AND status='active' AND expires_at_ms<=?`
      )
      .run(userId, now);
    return this.db
      .prepare(
        `SELECT session_id sessionId,status,created_at_ms createdAtMs,
      expires_at_ms expiresAtMs,last_seen_at_ms lastSeenAtMs FROM auth_sessions
      WHERE user_id=? ORDER BY last_seen_at_ms DESC`
      )
      .all(userId) as AuthSession[];
  }

  revokeSession(userId: string, sessionId: string, now = Date.now()): boolean {
    return (
      this.db
        .prepare(
          `UPDATE auth_sessions SET status='revoked',revoked_at_ms=?
      WHERE session_id=? AND user_id=? AND status='active'`
        )
        .run(now, sessionId, userId).changes === 1
    );
  }

  private countActiveOwners(): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) count FROM users u
      JOIN user_roles ur ON ur.user_id=u.user_id
      WHERE u.status='active' AND ur.role_key='owner'`
      )
      .get() as { count: number };
    return Number(row.count);
  }
}
