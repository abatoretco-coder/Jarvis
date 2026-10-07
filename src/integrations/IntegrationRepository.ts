import { createHash, randomUUID } from 'node:crypto';

import Database from 'better-sqlite3';

import type { EncryptedCredential } from './credentialVault';

export type ConnectionKind = 'personal' | 'household_shared';
export type ConnectionStatus = 'pending' | 'active' | 'error' | 'revoked';

export type PublicIntegrationConnection = {
  connectionId: string;
  provider: string;
  kind: ConnectionKind;
  displayName: string | null;
  providerEmail: string | null;
  scopes: string[];
  status: ConnectionStatus;
  householdId: string | null;
  lastErrorCode: string | null;
  createdAtMs: number;
  updatedAtMs: number;
};

type ConnectionRow = {
  connection_id: string;
  owner_user_id: string;
  household_id: string | null;
  provider: string;
  connection_kind: ConnectionKind;
  display_name: string | null;
  provider_email: string | null;
  scopes_json: string;
  status: ConnectionStatus;
  credential_reference: string | null;
  last_error_code: string | null;
  created_at_ms: number;
  updated_at_ms: number;
};

export type OAuthTransaction = {
  connectionId: string;
  ownerUserId: string;
  provider: string;
  codeVerifier: string;
  redirectUri: string;
};

export type ManagedHousehold = { householdId: string; name: string };

function stateHash(state: string): string {
  return createHash('sha256').update(state, 'utf8').digest('hex');
}

function toPublic(row: ConnectionRow): PublicIntegrationConnection {
  let scopes: string[] = [];
  try {
    const parsed = JSON.parse(row.scopes_json) as unknown;
    if (Array.isArray(parsed)) scopes = parsed.filter((item): item is string => typeof item === 'string');
  } catch {
    scopes = [];
  }
  return {
    connectionId: row.connection_id,
    provider: row.provider,
    kind: row.connection_kind,
    displayName: row.display_name,
    providerEmail: row.provider_email,
    scopes,
    status: row.status,
    householdId: row.household_id,
    lastErrorCode: row.last_error_code,
    createdAtMs: row.created_at_ms,
    updatedAtMs: row.updated_at_ms,
  };
}

export class IntegrationRepository {
  constructor(private readonly db: Database.Database) {}

  userHasPermission(userId: string, permission: string): boolean {
    return Boolean(this.db.prepare(
      `SELECT 1 FROM users u
       JOIN user_roles ur ON ur.user_id=u.user_id
       JOIN role_permissions rp ON rp.role_key=ur.role_key
       WHERE u.user_id=? AND u.status='active' AND rp.permission_key=? LIMIT 1`
    ).get(userId, permission));
  }

  listForUser(userId: string): PublicIntegrationConnection[] {
    const rows = this.db.prepare(
      `SELECT DISTINCT c.* FROM integration_connections c
       LEFT JOIN resource_grants g
         ON g.resource_type='integration_connection' AND g.resource_id=c.connection_id
        AND g.revoked_at_ms IS NULL AND (g.expires_at_ms IS NULL OR g.expires_at_ms>?)
       LEFT JOIN household_memberships hm
         ON hm.household_id=g.grantee_household_id AND hm.user_id=? AND hm.status='active'
       WHERE (c.connection_kind='personal' AND c.owner_user_id=?)
          OR (c.connection_kind='household_shared' AND (g.grantee_user_id=? OR hm.user_id IS NOT NULL))
       ORDER BY c.updated_at_ms DESC`
    ).all(Date.now(), userId, userId, userId) as ConnectionRow[];
    return rows.map(toPublic);
  }

  listManagedHouseholds(userId: string): ManagedHousehold[] {
    return this.db.prepare(
      `SELECT h.household_id householdId,h.name
       FROM households h JOIN household_memberships hm ON hm.household_id=h.household_id
       WHERE hm.user_id=? AND hm.status='active' AND hm.role_key='owner'
       ORDER BY h.name COLLATE NOCASE`
    ).all(userId) as ManagedHousehold[];
  }

  assertCanCreateShared(userId: string, householdId: string): void {
    const membership = this.db.prepare(
      `SELECT role_key FROM household_memberships
       WHERE household_id=? AND user_id=? AND status='active'`
    ).get(householdId, userId) as { role_key: string } | undefined;
    if (!membership || membership.role_key !== 'owner') {
      throw new Error('integration_household_admin_required');
    }
  }

  beginOAuth(input: {
    ownerUserId: string;
    provider: string;
    kind: ConnectionKind;
    displayName?: string;
    householdId?: string;
    scopes: readonly string[];
    state: string;
    codeVerifier: string;
    redirectUri: string;
    expiresAtMs: number;
  }): string {
    const connectionId = randomUUID();
    const now = Date.now();
    const displayName = input.displayName?.trim() || null;
    if (input.kind === 'household_shared') {
      if (!input.householdId || !displayName) throw new Error('integration_shared_name_required');
      this.assertCanCreateShared(input.ownerUserId, input.householdId);
    }
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM oauth_transactions WHERE expires_at_ms<=?').run(now);
      const existing = input.kind === 'personal'
        ? this.db.prepare(
            `SELECT 1 FROM integration_connections
             WHERE owner_user_id=? AND provider=? AND connection_kind='personal' AND status<>'revoked'`
          ).get(input.ownerUserId, input.provider)
        : this.db.prepare(
            `SELECT 1 FROM integration_connections
             WHERE household_id=? AND provider=? AND connection_kind='household_shared'
               AND display_name=? AND status<>'revoked'`
          ).get(input.householdId, input.provider, displayName);
      if (existing) throw new Error('integration_connection_exists');
      this.db.prepare(
        `INSERT INTO integration_connections(
          connection_id,owner_user_id,household_id,provider,scopes_json,status,
          connection_kind,display_name,created_at_ms,updated_at_ms
        ) VALUES (?,?,?,?,?,'pending',?,?,?,?)`
      ).run(
        connectionId,
        input.ownerUserId,
        input.kind === 'household_shared' ? input.householdId : null,
        input.provider,
        JSON.stringify(input.scopes),
        input.kind,
        displayName,
        now,
        now
      );
      this.recordAudit(input.ownerUserId, 'integration.authorization_started', connectionId, 'success', {
        provider: input.provider,
        kind: input.kind,
      }, now);
      this.db.prepare(
        `INSERT INTO oauth_transactions(
          state_hash,connection_id,owner_user_id,provider,code_verifier,redirect_uri,
          expires_at_ms,created_at_ms
        ) VALUES (?,?,?,?,?,?,?,?)`
      ).run(
        stateHash(input.state),
        connectionId,
        input.ownerUserId,
        input.provider,
        input.codeVerifier,
        input.redirectUri,
        input.expiresAtMs,
        now
      );
    })();
    return connectionId;
  }

  beginReauthorization(input: {
    actorUserId: string;
    connectionId: string;
    state: string;
    codeVerifier: string;
    redirectUri: string;
    expiresAtMs: number;
  }): { provider: string } {
    const now = Date.now();
    const connection = this.db.prepare(
      `SELECT c.provider,c.owner_user_id,c.connection_kind,c.household_id,c.status,hm.role_key
       FROM integration_connections c
       LEFT JOIN household_memberships hm
         ON hm.household_id=c.household_id AND hm.user_id=? AND hm.status='active'
       WHERE c.connection_id=?`
    ).get(input.actorUserId, input.connectionId) as {
      provider: string;
      owner_user_id: string;
      connection_kind: ConnectionKind;
      household_id: string | null;
      status: ConnectionStatus;
      role_key: string | null;
    } | undefined;
    const canManage = connection && (
      connection.owner_user_id === input.actorUserId
      || (connection.connection_kind === 'household_shared' && connection.role_key === 'owner')
    );
    if (!canManage || connection.status === 'revoked') throw new Error('integration_not_found');
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM oauth_transactions WHERE expires_at_ms<=?').run(now);
      this.db.prepare(
        `INSERT INTO oauth_transactions(
          state_hash,connection_id,owner_user_id,provider,code_verifier,redirect_uri,
          expires_at_ms,created_at_ms
        ) VALUES (?,?,?,?,?,?,?,?)`
      ).run(
        stateHash(input.state), input.connectionId, connection.owner_user_id, connection.provider,
        input.codeVerifier, input.redirectUri, input.expiresAtMs, now
      );
      this.recordAudit(input.actorUserId, 'integration.reauthorization_started', input.connectionId, 'success', {
        provider: connection.provider,
      }, now);
    })();
    return { provider: connection.provider };
  }

  consumeOAuthTransaction(state: string): OAuthTransaction | null {
    const hash = stateHash(state);
    const now = Date.now();
    return this.db.transaction(() => {
      const changed = this.db.prepare(
        `UPDATE oauth_transactions SET consumed_at_ms=?
         WHERE state_hash=? AND consumed_at_ms IS NULL AND expires_at_ms>?`
      ).run(now, hash, now);
      if (changed.changes !== 1) return null;
      const row = this.db.prepare(
        `SELECT connection_id,owner_user_id,provider,code_verifier,redirect_uri
         FROM oauth_transactions WHERE state_hash=?`
      ).get(hash) as {
        connection_id: string;
        owner_user_id: string;
        provider: string;
        code_verifier: string;
        redirect_uri: string;
      };
      return {
        connectionId: row.connection_id,
        ownerUserId: row.owner_user_id,
        provider: row.provider,
        codeVerifier: row.code_verifier,
        redirectUri: row.redirect_uri,
      };
    })();
  }

  activate(input: {
    connectionId: string;
    credentialId: string;
    encrypted: EncryptedCredential;
    providerSubject?: string;
    providerEmail?: string;
    scopes: readonly string[];
  }): void {
    const now = Date.now();
    this.db.transaction(() => {
      const previous = this.db.prepare(
        'SELECT credential_reference FROM integration_connections WHERE connection_id=?'
      ).get(input.connectionId) as { credential_reference: string | null } | undefined;
      this.db.prepare(
        `INSERT INTO integration_credentials(
          credential_id,ciphertext,iv,auth_tag,key_version,created_at_ms,updated_at_ms
        ) VALUES (?,?,?,?,?,?,?)`
      ).run(
        input.credentialId,
        input.encrypted.ciphertext,
        input.encrypted.iv,
        input.encrypted.authTag,
        input.encrypted.keyVersion,
        now,
        now
      );
      const changed = this.db.prepare(
        `UPDATE integration_connections SET status='active',credential_reference=?,
          provider_subject=?,provider_email=?,scopes_json=?,last_error_code=NULL,updated_at_ms=?
         WHERE connection_id=? AND status<>'revoked'`
      ).run(
        input.credentialId,
        input.providerSubject ?? null,
        input.providerEmail?.toLowerCase() ?? null,
        JSON.stringify(input.scopes),
        now,
        input.connectionId
      );
      if (changed.changes !== 1) throw new Error('integration_activation_conflict');
      if (previous?.credential_reference && previous.credential_reference !== input.credentialId) {
        this.db.prepare('DELETE FROM integration_credentials WHERE credential_id=?').run(previous.credential_reference);
      }

      const connection = this.db.prepare(
        'SELECT connection_kind,household_id,owner_user_id FROM integration_connections WHERE connection_id=?'
      ).get(input.connectionId) as {
        connection_kind: ConnectionKind;
        household_id: string | null;
        owner_user_id: string;
      };
      if (connection.connection_kind === 'household_shared' && connection.household_id) {
        this.db.prepare(
          `INSERT INTO resource_grants(
            grant_id,resource_type,resource_id,grantee_household_id,permissions_json,
            created_by_user_id,created_at_ms
          ) SELECT ?,'integration_connection',?,?,?, ?,?
            WHERE NOT EXISTS (
              SELECT 1 FROM resource_grants
              WHERE resource_type='integration_connection' AND resource_id=?
                AND revoked_at_ms IS NULL
            )`
        ).run(
          randomUUID(),
          input.connectionId,
          connection.household_id,
          JSON.stringify(['use']),
          connection.owner_user_id,
          now,
          input.connectionId
        );
      }
      this.recordAudit(connection.owner_user_id, 'integration.connected', input.connectionId, 'success', {
        providerEmailPresent: Boolean(input.providerEmail),
      }, now);
    })();
  }

  markError(connectionId: string, code: string): void {
    const now = Date.now();
    const row = this.db.prepare(
      'SELECT owner_user_id ownerUserId FROM integration_connections WHERE connection_id=?'
    ).get(connectionId) as { ownerUserId: string } | undefined;
    this.db.transaction(() => {
      this.db.prepare(
        `UPDATE integration_connections SET
           status=CASE WHEN status='pending' THEN 'error' ELSE status END,
           last_error_code=?,updated_at_ms=? WHERE connection_id=? AND status<>'revoked'`
      ).run(code.slice(0, 128), now, connectionId);
      if (row) this.recordAudit(row.ownerUserId, 'integration.authorization_failed', connectionId, 'failed', {
        errorCode: code.slice(0, 128),
      }, now);
    })();
  }

  getCredentialForUser(input: {
    userId: string;
    provider: string;
    connectionId?: string;
  }): { connection: PublicIntegrationConnection; credentialId: string; encrypted: EncryptedCredential } | null {
    const requester = this.db.prepare('SELECT status FROM users WHERE user_id=?').get(input.userId) as
      | { status: string }
      | undefined;
    if (requester?.status !== 'active') return null;
    const candidates = this.listForUser(input.userId).filter(
      (connection) => connection.provider === input.provider && connection.status === 'active'
    );
    const selected = input.connectionId
      ? candidates.find((connection) => connection.connectionId === input.connectionId)
      : candidates.find((connection) => connection.kind === 'personal');
    if (!selected) return null;
    if (!input.connectionId && selected.kind !== 'personal') return null;
    const row = this.db.prepare(
      `SELECT c.credential_reference,i.ciphertext,i.iv,i.auth_tag,i.key_version
       FROM integration_connections c JOIN integration_credentials i
         ON i.credential_id=c.credential_reference
       WHERE c.connection_id=? AND c.status='active'`
    ).get(selected.connectionId) as {
      credential_reference: string;
      ciphertext: string;
      iv: string;
      auth_tag: string;
      key_version: number;
    } | undefined;
    return row ? {
      connection: selected,
      credentialId: row.credential_reference,
      encrypted: {
        ciphertext: row.ciphertext,
        iv: row.iv,
        authTag: row.auth_tag,
        keyVersion: row.key_version,
      },
    } : null;
  }

  updateCredential(
    credentialId: string,
    encrypted: EncryptedCredential,
    actorUserId: string
  ): void {
    const now = Date.now();
    this.db.transaction(() => {
      const changed = this.db.prepare(
        `UPDATE integration_credentials SET ciphertext=?,iv=?,auth_tag=?,key_version=?,updated_at_ms=?
         WHERE credential_id=?`
      ).run(
        encrypted.ciphertext,
        encrypted.iv,
        encrypted.authTag,
        encrypted.keyVersion,
        now,
        credentialId
      );
      if (changed.changes !== 1) throw new Error('integration_credential_not_found');
      this.recordAudit(actorUserId, 'integration.token_rotated', credentialId, 'success', {}, now);
    })();
  }

  revoke(userId: string, connectionId: string): { credentialId: string | null } | null {
    const allowed = this.db.prepare(
      `SELECT c.connection_id FROM integration_connections c
       LEFT JOIN household_memberships hm
         ON hm.household_id=c.household_id AND hm.user_id=? AND hm.status='active'
       WHERE c.connection_id=? AND (
         c.owner_user_id=? OR
         (c.connection_kind='household_shared' AND hm.role_key='owner')
       )`
    ).get(userId, connectionId, userId);
    if (!allowed) return null;
    const row = this.db.prepare(
      'SELECT credential_reference FROM integration_connections WHERE connection_id=?'
    ).get(connectionId) as { credential_reference: string | null } | undefined;
    const now = Date.now();
    this.db.transaction(() => {
      this.db.prepare(
        `UPDATE integration_connections SET status='revoked',credential_reference=NULL,
          revoked_at_ms=?,updated_at_ms=? WHERE connection_id=?`
      ).run(now, now, connectionId);
      if (row?.credential_reference) {
        this.db.prepare('DELETE FROM integration_credentials WHERE credential_id=?').run(row.credential_reference);
      }
      this.db.prepare(
        `UPDATE resource_grants SET revoked_at_ms=?
         WHERE resource_type='integration_connection' AND resource_id=? AND revoked_at_ms IS NULL`
      ).run(now, connectionId);
      this.recordAudit(userId, 'integration.revoked', connectionId, 'success', {}, now);
    })();
    return { credentialId: row?.credential_reference ?? null };
  }

  canRemotelyRevokeGoogle(connectionId: string): boolean {
    const row = this.db.prepare(
      `SELECT 1 FROM integration_connections target
       WHERE target.connection_id=? AND target.provider IN ('google-calendar','gmail')
         AND NOT EXISTS (
           SELECT 1 FROM integration_connections other
           WHERE other.owner_user_id=target.owner_user_id
             AND other.connection_id<>target.connection_id
             AND other.provider IN ('google-calendar','gmail')
             AND other.status='active'
         )`
    ).get(connectionId);
    return Boolean(row);
  }

  private recordAudit(
    actorId: string,
    action: string,
    targetId: string,
    outcome: 'success' | 'denied' | 'failed',
    metadata: Record<string, unknown>,
    now: number
  ): void {
    this.db.prepare(
      `INSERT INTO audit_events(
        event_id,actor_kind,actor_id,action,target_type,target_id,outcome,metadata_json,created_at_ms
      ) VALUES (?,'user',?,?,'integration_connection',?,?,?,?)`
    ).run(randomUUID(), actorId, action, targetId, outcome, JSON.stringify(metadata), now);
  }
}
