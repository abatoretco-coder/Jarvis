import { describe, expect, test } from '@jest/globals';
import Fastify from 'fastify';

import { AdminControlPlaneRepository } from '../src/admin/AdminControlPlaneRepository';
import { createConversationDb, SqliteThreadRepository } from '../src/conversation/repositories/SqliteRepositories';
import { loadEnv } from '../src/env';
import { IdentityRepository } from '../src/identity/IdentityRepository';
import { IdentityService } from '../src/identity/IdentityService';
import type { AccessTokenVerifier, VerifiedOidcClaims } from '../src/identity/OidcTokenVerifier';
import { registerApiKeyHook } from '../src/routes/apiKeyHook';
import { registerIdentityRoutes } from '../src/routes/identity';

class StubVerifier implements AccessTokenVerifier {
  constructor(public claims: VerifiedOidcClaims) {}
  async verify(): Promise<VerifiedOidcClaims> { return this.claims; }
}

function claims(subject: string, email: string, sid = subject): VerifiedOidcClaims {
  return {
    issuer: 'https://issuer.example.test/realms/jarvis',
    subject,
    email,
    emailVerified: true,
    providerSessionId: `issuer\u001f${sid}`,
    expiresAtMs: Date.now() + 300_000,
  };
}

function setup(bootstrapSubject?: string) {
  const db = createConversationDb(':memory:');
  const repository = new IdentityRepository(db);
  const verifier = new StubVerifier(claims('new-user', 'new@example.test'));
  const identity = new IdentityService(repository, verifier, bootstrapSubject);
  const env = loadEnv({
    REQUIRE_API_KEY: 'true',
    API_KEY: 'service-key',
    OIDC_ENABLED: 'true',
    OIDC_ISSUER_URL: 'https://issuer.example.test/realms/jarvis',
    OIDC_AUDIENCE: 'jarvis-api',
  });
  const app = Fastify();
  const threads = new SqliteThreadRepository(db);
  registerApiKeyHook(app, env, identity);
  registerIdentityRoutes(app, identity, new AdminControlPlaneRepository(db));
  app.get('/v1/business', async () => ({ ok: true }));
  app.post('/v1/test-threads/:threadId', async (request) => {
    const { threadId } = request.params as { threadId: string };
    return threads.getOrCreate(threadId);
  });
  app.get('/v1/test-threads/:threadId', async (request) => {
    const { threadId } = request.params as { threadId: string };
    return { item: await threads.findById(threadId) };
  });
  return { app, db, repository, verifier };
}

describe('identity routes and authorization hook', () => {
  test('provisions an authenticated user as pending and denies business data', async () => {
    const { app, db } = setup();
    const me = await app.inject({ method: 'GET', url: '/v1/auth/me', headers: { authorization: 'Bearer token' } });
    expect(me.statusCode).toBe(200);
    expect(me.json()).toMatchObject({ status: 'pending', roles: [], permissions: [] });
    const business = await app.inject({ method: 'GET', url: '/v1/business', headers: { authorization: 'Bearer token' } });
    expect(business.statusCode).toBe(403);
    expect(business.json()).toEqual({ error: 'account_pending' });
    await app.close();
    db.close();
  });

  test('bootstraps the configured owner and blocks a resident from admin routes', async () => {
    const { app, db, repository, verifier } = setup('owner-subject');
    verifier.claims = claims('owner-subject', 'owner@example.test', 'owner-session');
    const owner = await app.inject({ method: 'GET', url: '/v1/admin/users', headers: { authorization: 'Bearer owner-token' } });
    expect(owner.statusCode).toBe(200);

    verifier.claims = claims('resident-subject', 'resident@example.test', 'resident-session');
    const pending = await app.inject({ method: 'GET', url: '/v1/auth/me', headers: { authorization: 'Bearer resident-token' } });
    const residentId = pending.json().userId as string;
    repository.approveUser(residentId, 'resident');
    const business = await app.inject({ method: 'GET', url: '/v1/business', headers: { authorization: 'Bearer resident-token' } });
    expect(business.statusCode).toBe(200);
    const admin = await app.inject({ method: 'GET', url: '/v1/admin/users', headers: { authorization: 'Bearer resident-token' } });
    expect(admin.statusCode).toBe(403);
    expect(admin.json()).toEqual({ error: 'forbidden' });
    await app.close();
    db.close();
  });

  test('revokes the current session without storing or returning the token', async () => {
    const { app, db, verifier } = setup('owner-subject');
    verifier.claims = claims('owner-subject', 'owner@example.test', 'owner-session');
    const logout = await app.inject({ method: 'POST', url: '/v1/auth/logout', headers: { authorization: 'Bearer token-value' } });
    expect(logout.statusCode).toBe(204);
    const retry = await app.inject({ method: 'GET', url: '/v1/auth/me', headers: { authorization: 'Bearer token-value' } });
    expect(retry.statusCode).toBe(401);
    expect(retry.body).not.toContain('token-value');
    await app.close();
    db.close();
  });

  test('propagates the authenticated owner into repository isolation for the full request', async () => {
    const { app, db, repository, verifier } = setup('owner-subject');
    verifier.claims = claims('owner-subject', 'owner@example.test', 'owner-session');
    expect((await app.inject({
      method: 'POST', url: '/v1/test-threads/owner-private', headers: { authorization: 'Bearer owner-token' },
    })).statusCode).toBe(200);

    verifier.claims = claims('resident-subject', 'resident@example.test', 'resident-session');
    const pending = await app.inject({ method: 'GET', url: '/v1/auth/me', headers: { authorization: 'Bearer resident-token' } });
    repository.approveUser(pending.json().userId as string, 'resident');
    const guessed = await app.inject({
      method: 'GET', url: '/v1/test-threads/owner-private', headers: { authorization: 'Bearer resident-token' },
    });
    expect(guessed.statusCode).toBe(200);
    expect(guessed.json()).toEqual({ item: null });
    expect((await app.inject({
      method: 'POST', url: '/v1/test-threads/resident-private', headers: { authorization: 'Bearer resident-token' },
    })).statusCode).toBe(200);

    verifier.claims = claims('owner-subject', 'owner@example.test', 'owner-session');
    const reverseGuess = await app.inject({
      method: 'GET', url: '/v1/test-threads/resident-private', headers: { authorization: 'Bearer owner-token' },
    });
    expect(reverseGuess.json()).toEqual({ item: null });
    await app.close();
    db.close();
  });

  test('repairs household and backfills legacy data for an owner already active before phase 3', async () => {
    const { app, db, repository, verifier } = setup('owner-subject');
    const owner = repository.provisionOidcIdentity({
      issuer: 'https://issuer.example.test/realms/jarvis',
      subject: 'owner-subject',
      email: 'owner@example.test',
      emailVerified: true,
    }, 1);
    repository.bootstrapOwner(owner.userId, 2);
    db.prepare('DELETE FROM households WHERE created_by_user_id=?').run(owner.userId);
    db.prepare(`INSERT INTO conversation_threads(thread_id,created_at_ms,updated_at_ms)
      VALUES ('pre-phase3-thread',1,1)`).run();
    verifier.claims = claims('owner-subject', 'owner@example.test', 'owner-session');

    const response = await app.inject({
      method: 'GET', url: '/v1/auth/me', headers: { authorization: 'Bearer owner-token' },
    });

    expect(response.statusCode).toBe(200);
    expect(db.prepare("SELECT owner_user_id owner FROM conversation_threads WHERE thread_id='pre-phase3-thread'").get())
      .toEqual({ owner: owner.userId });
    expect(db.prepare('SELECT user_id FROM household_memberships WHERE user_id=?').get(owner.userId))
      .toEqual({ user_id: owner.userId });
    expect(db.prepare("SELECT COUNT(*) count FROM audit_events WHERE action='conversation_ownership_backfill_batch'").get())
      .toEqual({ count: 1 });
    await app.close();
    db.close();
  });
});
