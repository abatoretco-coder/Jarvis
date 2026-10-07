import { describe, expect, test } from '@jest/globals';

import { createConversationDb } from '../src/conversation/repositories/SqliteRepositories';
import { IdentityRepository } from '../src/identity/IdentityRepository';

describe('identity repository', () => {
  test('provisions a verified OIDC identity once as pending', () => {
    const db = createConversationDb(':memory:');
    const repository = new IdentityRepository(db);
    const first = repository.provisionOidcIdentity(
      {
        issuer: 'https://id.example',
        subject: 'abc',
        email: ' Person@Example.test ',
        emailVerified: true,
      },
      10
    );
    const second = repository.provisionOidcIdentity(
      {
        issuer: 'https://id.example',
        subject: 'abc',
        email: 'ignored@example.test',
        emailVerified: true,
      },
      20
    );
    expect(first).toMatchObject({ email: 'person@example.test', status: 'pending' });
    expect(second.userId).toBe(first.userId);
    expect(db.prepare('SELECT COUNT(*) count FROM users').get()).toEqual({ count: 1 });
    db.close();
  });

  test('rejects unverified email and invalid privilege transitions', () => {
    const db = createConversationDb(':memory:');
    const repository = new IdentityRepository(db);
    expect(() =>
      repository.provisionOidcIdentity({
        issuer: 'i',
        subject: 's',
        email: 'a@example.test',
        emailVerified: false,
      })
    ).toThrow('identity_email_not_verified');
    const user = repository.provisionOidcIdentity({
      issuer: 'https://i.test',
      subject: 's',
      email: 'a@example.test',
      emailVerified: true,
    });
    expect(() => repository.changeStatus(user.userId, 'pending', 'suspended')).toThrow(
      'identity_invalid_status_transition'
    );
    db.close();
  });

  test('revokes active sessions atomically when a user is suspended', () => {
    const db = createConversationDb(':memory:');
    const repository = new IdentityRepository(db);
    const user = repository.provisionOidcIdentity(
      { issuer: 'https://i.test', subject: 's', email: 'a@example.test', emailVerified: true },
      1
    );
    expect(repository.changeStatus(user.userId, 'pending', 'active', 2)).toBe(true);
    db.prepare(
      `INSERT INTO auth_sessions(session_id,user_id,status,created_at_ms,expires_at_ms,last_seen_at_ms)
      VALUES ('session',?,'active',2,100,2)`
    ).run(user.userId);
    expect(repository.changeStatus(user.userId, 'active', 'suspended', 3)).toBe(true);
    expect(db.prepare('SELECT status,revoked_at_ms FROM auth_sessions').get()).toEqual({
      status: 'revoked',
      revoked_at_ms: 3,
    });
    db.close();
  });

  test('seeds least-privilege role permissions and protects the last owner', () => {
    const db = createConversationDb(':memory:');
    const repository = new IdentityRepository(db);
    const owner = repository.provisionOidcIdentity(
      {
        issuer: 'https://i.test',
        subject: 'owner',
        email: 'owner@example.test',
        emailVerified: true,
      },
      1
    );
    repository.bootstrapOwner(owner.userId, 2);
    expect(repository.findAuthorizedUser(owner.userId)).toMatchObject({
      status: 'active',
      roles: ['owner'],
      permissions: expect.arrayContaining(['admin', 'nas.operations']),
    });
    expect(() => repository.replaceRoles(owner.userId, ['guest'], 3)).toThrow(
      'identity_last_owner'
    );
    expect(() => repository.changeStatusSafely(owner.userId, 'active', 'suspended', 3)).toThrow(
      'identity_last_owner'
    );
    db.close();
  });

  test('rolls back account revocation when it would orphan a household', () => {
    const db = createConversationDb(':memory:');
    const repository = new IdentityRepository(db);
    const first = repository.provisionOidcIdentity(
      {
        issuer: 'https://i.test',
        subject: 'owner-1',
        email: 'owner-1@example.test',
        emailVerified: true,
      },
      1
    );
    repository.bootstrapOwner(first.userId, 2);
    const second = repository.provisionOidcIdentity(
      {
        issuer: 'https://i.test',
        subject: 'owner-2',
        email: 'owner-2@example.test',
        emailVerified: true,
      },
      3
    );
    repository.approveUser(second.userId, 'owner', 4);
    repository.ensureOwnerHousehold(second.userId, 5);

    expect(() => repository.changeStatus(second.userId, 'active', 'revoked', 6)).toThrow(
      'identity_last_household_owner'
    );
    expect(repository.findAuthorizedUser(second.userId)?.status).toBe('active');
    expect(
      db.prepare('SELECT status FROM household_memberships WHERE user_id=?').get(second.userId)
    ).toEqual({ status: 'active' });
    db.close();
  });

  test('keeps a locally revoked provider session revoked', () => {
    const db = createConversationDb(':memory:');
    const repository = new IdentityRepository(db);
    const user = repository.provisionOidcIdentity(
      { issuer: 'https://i.test', subject: 's', email: 'a@example.test', emailVerified: true },
      1
    );
    repository.bootstrapOwner(user.userId, 2);
    const session = repository.touchSession(
      { userId: user.userId, providerSessionId: 'issuer/sid', expiresAtMs: 100 },
      3
    );
    expect(repository.revokeSession(user.userId, session.sessionId, 4)).toBe(true);
    expect(
      repository.touchSession(
        { userId: user.userId, providerSessionId: 'issuer/sid', expiresAtMs: 200 },
        5
      ).status
    ).toBe('revoked');
    db.close();
  });

  test('bootstraps the default household and claims legacy conversation data idempotently', () => {
    const db = createConversationDb(':memory:');
    db.exec(`
      INSERT INTO conversation_threads(thread_id,created_at_ms,updated_at_ms)
      VALUES ('legacy-thread',1,1);
      INSERT INTO pending_mutations(
        proposal_id,thread_id,agent,action,effect,preview,payload_json,status,expires_at_ms,created_at_ms
      ) VALUES ('legacy-proposal','legacy-thread','todo','add','write','Ajouter','{}','pending',9999,1);
      INSERT INTO conversation_result_sets(
        id,thread_id,source_agent,source_action,created_at_ms,expires_at_ms,active
      ) VALUES ('legacy-results','legacy-thread','search','query',1,9999,1);
    `);
    const repository = new IdentityRepository(db);
    const owner = repository.provisionOidcIdentity(
      {
        issuer: 'https://i.test',
        subject: 'owner',
        email: 'owner@example.test',
        emailVerified: true,
      },
      2
    );
    repository.bootstrapOwner(owner.userId, 3);
    expect(repository.claimLegacyConversationData(owner.userId, 4, 1)).toBe(1);

    expect(db.prepare('SELECT owner_user_id owner FROM conversation_threads').get()).toEqual({
      owner: owner.userId,
    });
    expect(db.prepare('SELECT owner_user_id owner FROM pending_mutations').get()).toEqual({
      owner: owner.userId,
    });
    expect(db.prepare('SELECT owner_user_id owner FROM conversation_result_sets').get()).toEqual({
      owner: owner.userId,
    });
    expect(db.prepare('SELECT user_id,role_key,status FROM household_memberships').get()).toEqual({
      user_id: owner.userId,
      role_key: 'owner',
      status: 'active',
    });
    expect(
      db
        .prepare(
          "SELECT action,metadata_json FROM audit_events WHERE action='conversation_ownership_backfill_batch'"
        )
        .get()
    ).toEqual({
      action: 'conversation_ownership_backfill_batch',
      metadata_json: JSON.stringify({ claimedThreads: 1, batchSize: 1 }),
    });
    expect(repository.claimLegacyConversationData(owner.userId, 5, 1)).toBe(0);
    db.close();
  });
});
