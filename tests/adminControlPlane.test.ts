import { describe, expect, test } from '@jest/globals';
import Fastify from 'fastify';

import {
  AdminControlPlaneRepository,
  parseAuditCursor,
} from '../src/admin/AdminControlPlaneRepository';
import { createConversationDb } from '../src/conversation/repositories/SqliteRepositories';
import { loadEnv } from '../src/env';
import { IdentityRepository } from '../src/identity/IdentityRepository';
import { IdentityService } from '../src/identity/IdentityService';
import type { AccessTokenVerifier, VerifiedOidcClaims } from '../src/identity/OidcTokenVerifier';
import { registerAdminRoutes } from '../src/routes/admin';
import { registerApiKeyHook } from '../src/routes/apiKeyHook';
import { registerIdentityRoutes } from '../src/routes/identity';
import type { AppDeps } from '../src/server';

class StubVerifier implements AccessTokenVerifier {
  constructor(public claims: VerifiedOidcClaims) {}
  async verify(): Promise<VerifiedOidcClaims> {
    return this.claims;
  }
}

function claims(subject: string, email: string): VerifiedOidcClaims {
  return {
    issuer: 'https://issuer.example.test/realms/jarvis',
    subject,
    email,
    emailVerified: true,
    providerSessionId: `issuer\u001f${subject}`,
    expiresAtMs: Date.now() + 300_000,
  };
}

function setup(ha?: AppDeps['ha']) {
  const db = createConversationDb(':memory:');
  const identityRepository = new IdentityRepository(db);
  const verifier = new StubVerifier(claims('owner', 'owner@example.test'));
  const identity = new IdentityService(identityRepository, verifier, 'owner');
  const admin = new AdminControlPlaneRepository(db);
  const env = loadEnv({
    REQUIRE_API_KEY: 'true',
    API_KEY: 'legacy-service-key',
    OIDC_ENABLED: 'true',
    OIDC_ISSUER_URL: 'https://issuer.example.test/realms/jarvis',
    OIDC_AUDIENCE: 'jarvis-api',
    OPENAI_API_KEY: 'test-openai-key',
  });
  const deps = {
    env,
    ha,
    spotifyWebApi: { isConfigured: () => false },
    nasStatus: { isConfigured: () => false },
  } as unknown as AppDeps;
  const app = Fastify();
  registerApiKeyHook(app, env, identity, admin);
  registerIdentityRoutes(app, identity, admin);
  registerAdminRoutes(app, deps, admin);
  return { app, db, identityRepository, verifier };
}

async function ensureOwner(app: ReturnType<typeof Fastify>) {
  const response = await app.inject({
    method: 'GET',
    url: '/v1/auth/me',
    headers: { authorization: 'Bearer owner-token' },
  });
  expect(response.statusCode).toBe(200);
  return response.json() as { userId: string };
}

describe('admin control plane', () => {
  test('requires a human administrator even when a legacy service key is valid', async () => {
    const { app, db } = setup();
    const response = await app.inject({
      method: 'GET',
      url: '/v1/admin/services',
      headers: { 'x-api-key': 'legacy-service-key' },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ error: 'human_admin_required' });
    expect(
      db
        .prepare(
          "SELECT actor_kind actorKind,outcome FROM audit_events WHERE action='admin.access'"
        )
        .get()
    ).toEqual({ actorKind: 'service', outcome: 'denied' });
    await app.close();
    db.close();
  });

  test('applies allowed and denied authorization to every read-only admin surface', async () => {
    const { app, db, identityRepository, verifier } = setup();
    const owner = await ensureOwner(app);
    verifier.claims = claims('resident', 'resident@example.test');
    const resident = identityRepository.provisionOidcIdentity({
      issuer: verifier.claims.issuer,
      subject: verifier.claims.subject,
      email: verifier.claims.email,
      emailVerified: true,
    });
    identityRepository.approveUser(resident.userId, 'resident');
    const paths = [
      '/v1/admin/users',
      `/v1/admin/users/${owner.userId}`,
      '/v1/admin/permissions',
      '/v1/admin/households',
      `/v1/admin/households/home:${owner.userId}/members`,
      '/v1/admin/grants',
      '/v1/admin/integrations',
      '/v1/admin/audit',
      '/v1/admin/services',
      '/v1/admin/ai',
      '/v1/admin/home/inventory',
      '/v1/admin/operations',
    ];
    verifier.claims = claims('owner', 'owner@example.test');
    for (const path of paths) {
      const allowed = await app.inject({
        method: 'GET',
        url: path,
        headers: { authorization: 'Bearer owner-token' },
      });
      expect([200, 503]).toContain(allowed.statusCode);
    }
    verifier.claims = claims('resident', 'resident@example.test');
    for (const path of paths) {
      const denied = await app.inject({
        method: 'GET',
        url: path,
        headers: { authorization: 'Bearer resident-token' },
      });
      expect(denied.statusCode).toBe(403);
    }
    expect(
      db
        .prepare(
          `SELECT COUNT(*) count FROM audit_events
      WHERE action='admin.access' AND actor_id=? AND outcome='denied'`
        )
        .get(resident.userId)
    ).toEqual({ count: paths.length });
    await app.close();
    db.close();
  });

  test('approves a user atomically, requires idempotency and safely replays the result', async () => {
    const { app, db, identityRepository, verifier } = setup();
    await ensureOwner(app);
    verifier.claims = claims('resident', 'resident@example.test');
    const pending = await app.inject({
      method: 'GET',
      url: '/v1/auth/me',
      headers: { authorization: 'Bearer resident-token' },
    });
    const userId = pending.json().userId as string;
    verifier.claims = claims('owner', 'owner@example.test');

    const missingKey = await app.inject({
      method: 'POST',
      url: `/v1/admin/users/${userId}/approve`,
      headers: { authorization: 'Bearer owner-token' },
      body: { role: 'resident' },
    });
    expect(missingKey.statusCode).toBe(400);

    const request = {
      method: 'POST' as const,
      url: `/v1/admin/users/${userId}/approve`,
      headers: { authorization: 'Bearer owner-token', 'idempotency-key': 'approve-resident-001' },
      body: { role: 'resident' },
    };
    const approved = await app.inject(request);
    const replay = await app.inject(request);
    expect(approved.statusCode).toBe(200);
    expect(replay.statusCode).toBe(200);
    expect(replay.headers['idempotent-replay']).toBe('true');
    expect(identityRepository.findAuthorizedUser(userId)?.status).toBe('active');
    expect(
      db
        .prepare(
          "SELECT COUNT(*) count FROM audit_events WHERE action='user.approve' AND outcome='success'"
        )
        .get()
    ).toEqual({ count: 1 });

    const conflict = await app.inject({ ...request, body: { role: 'guest' } });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toEqual({ error: 'idempotency_conflict' });
    await app.close();
    db.close();
  });

  test('requires owner confirmation for privileged roles and records denials', async () => {
    const { app, db, verifier } = setup();
    await ensureOwner(app);
    verifier.claims = claims('pending-admin', 'pending-admin@example.test');
    const pending = await app.inject({
      method: 'GET',
      url: '/v1/auth/me',
      headers: { authorization: 'Bearer pending-admin-token' },
    });
    verifier.claims = claims('owner', 'owner@example.test');
    const denied = await app.inject({
      method: 'POST',
      url: `/v1/admin/users/${pending.json().userId as string}/approve`,
      headers: { authorization: 'Bearer owner-token', 'idempotency-key': 'approve-admin-001' },
      body: { role: 'owner' },
    });
    expect(denied.statusCode).toBe(403);
    expect(denied.json()).toEqual({ error: 'owner_confirmation_required' });
    expect(
      db
        .prepare(
          "SELECT COUNT(*) count FROM audit_events WHERE action='user.approve' AND outcome='denied'"
        )
        .get()
    ).toEqual({ count: 1 });
    await app.close();
    db.close();
  });

  test('supports the complete user and household administration lifecycle', async () => {
    const { app, db, verifier } = setup();
    const owner = await ensureOwner(app);
    verifier.claims = claims('guest', 'guest@example.test');
    const pending = await app.inject({
      method: 'GET',
      url: '/v1/auth/me',
      headers: { authorization: 'Bearer guest-token' },
    });
    const userId = pending.json().userId as string;
    verifier.claims = claims('owner', 'owner@example.test');
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/v1/admin/users/${userId}/approve`,
          headers: { authorization: 'Bearer owner-token', 'idempotency-key': 'lifecycle-approve' },
          body: { role: 'resident' },
        })
      ).statusCode
    ).toBe(200);
    expect(
      (
        await app.inject({
          method: 'PUT',
          url: `/v1/admin/users/${userId}/roles`,
          headers: { authorization: 'Bearer owner-token', 'idempotency-key': 'lifecycle-roles-1' },
          body: { roles: ['guest'] },
        })
      ).statusCode
    ).toBe(200);
    expect(
      (
        await app.inject({
          method: 'PATCH',
          url: `/v1/admin/users/${userId}/status`,
          headers: { authorization: 'Bearer owner-token', 'idempotency-key': 'lifecycle-suspend' },
          body: { expected: 'active', next: 'suspended' },
        })
      ).statusCode
    ).toBe(200);
    expect(
      (
        await app.inject({
          method: 'PATCH',
          url: `/v1/admin/users/${userId}/status`,
          headers: {
            authorization: 'Bearer owner-token',
            'idempotency-key': 'lifecycle-reactivate',
          },
          body: { expected: 'suspended', next: 'active' },
        })
      ).statusCode
    ).toBe(200);
    const membership = await app.inject({
      method: 'PUT',
      url: `/v1/admin/households/home:${owner.userId}/members/${userId}`,
      headers: { authorization: 'Bearer owner-token', 'idempotency-key': 'lifecycle-membership' },
      body: { role: 'resident', status: 'active' },
    });
    expect(membership.statusCode).toBe(200);
    expect(membership.json()).toMatchObject({ userId, role: 'resident', status: 'active' });
    const detail = await app.inject({
      method: 'GET',
      url: `/v1/admin/users/${userId}`,
      headers: { authorization: 'Bearer owner-token' },
    });
    expect(detail.json()).toMatchObject({
      userId,
      status: 'active',
      activeSessionCount: expect.any(Number),
    });
    expect(detail.json().memberships).toHaveLength(1);
    const orphanOwner = await app.inject({
      method: 'PUT',
      url: `/v1/admin/households/home:${owner.userId}/members/${owner.userId}`,
      headers: {
        authorization: 'Bearer owner-token',
        'idempotency-key': 'lifecycle-owner-demotion',
      },
      body: { role: 'resident', status: 'active', confirmation: 'confirm_privileged_change' },
    });
    expect(orphanOwner.statusCode).toBe(409);
    expect(orphanOwner.json()).toEqual({ error: 'last_household_owner' });

    const grant = await app.inject({
      method: 'POST',
      url: '/v1/admin/grants',
      headers: { authorization: 'Bearer owner-token', 'idempotency-key': 'lifecycle-user-grant' },
      body: {
        resourceType: 'device',
        resourceId: 'light.office',
        granteeUserId: userId,
        permissions: ['control'],
      },
    });
    expect(grant.statusCode).toBe(201);
    db.prepare(
      `INSERT INTO integration_connections(
      connection_id,owner_user_id,provider,scopes_json,status,credential_reference,created_at_ms,updated_at_ms
    ) VALUES ('lifecycle-integration',?,'google','[]','active','vault://lifecycle-secret',1,1)`
    ).run(userId);
    const revoked = await app.inject({
      method: 'PATCH',
      url: `/v1/admin/users/${userId}/status`,
      headers: { authorization: 'Bearer owner-token', 'idempotency-key': 'lifecycle-revoke' },
      body: { expected: 'active', next: 'revoked', confirmation: 'confirm_privileged_change' },
    });
    expect(revoked.statusCode).toBe(200);
    expect(
      db.prepare('SELECT status FROM household_memberships WHERE user_id=?').get(userId)
    ).toEqual({ status: 'revoked' });
    expect(
      db
        .prepare('SELECT revoked_at_ms revokedAtMs FROM resource_grants WHERE grant_id=?')
        .get(grant.json().grantId)
    ).toEqual({ revokedAtMs: expect.any(Number) });
    expect(
      db
        .prepare(
          `SELECT status,credential_reference credential FROM integration_connections
      WHERE connection_id='lifecycle-integration'`
        )
        .get()
    ).toEqual({ status: 'revoked', credential: null });
    expect(db.prepare('SELECT status FROM auth_sessions WHERE user_id=?').get(userId)).toEqual({
      status: 'revoked',
    });
    await app.close();
    db.close();
  });

  test('refuses a pending account without assigning a role', async () => {
    const { app, db, verifier } = setup();
    await ensureOwner(app);
    verifier.claims = claims('refused', 'refused@example.test');
    const pending = await app.inject({
      method: 'GET',
      url: '/v1/auth/me',
      headers: { authorization: 'Bearer refused-token' },
    });
    const userId = pending.json().userId as string;
    verifier.claims = claims('owner', 'owner@example.test');
    const refused = await app.inject({
      method: 'PATCH',
      url: `/v1/admin/users/${userId}/status`,
      headers: { authorization: 'Bearer owner-token', 'idempotency-key': 'refuse-pending-user' },
      body: { expected: 'pending', next: 'rejected' },
    });
    expect(refused.statusCode).toBe(200);
    expect(refused.json()).toMatchObject({ userId, status: 'rejected', roles: [] });
    await app.close();
    db.close();
  });

  test('validates identifiers, objects and opaque audit cursors', async () => {
    const { app, db } = setup();
    await ensureOwner(app);
    expect(
      (
        await app.inject({
          method: 'GET',
          url: '/v1/admin/users/not-a-uuid',
          headers: { authorization: 'Bearer owner-token' },
        })
      ).statusCode
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: 'GET',
          url: '/v1/admin/audit?cursor=not-a-cursor',
          headers: { authorization: 'Bearer owner-token' },
        })
      ).statusCode
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/v1/admin/grants',
          headers: { authorization: 'Bearer owner-token', 'idempotency-key': 'invalid-grant-001' },
          body: { resourceType: 'shell', resourceId: '../etc/passwd', permissions: ['execute'] },
        })
      ).statusCode
    ).toBe(400);
    const owner = (
      await app.inject({
        method: 'GET',
        url: '/v1/auth/me',
        headers: { authorization: 'Bearer owner-token' },
      })
    ).json() as { userId: string };
    const invalidPermission = await app.inject({
      method: 'POST',
      url: '/v1/admin/grants',
      headers: { authorization: 'Bearer owner-token', 'idempotency-key': 'invalid-grant-002' },
      body: {
        resourceType: 'device',
        resourceId: 'light.office',
        granteeUserId: owner.userId,
        permissions: ['stream'],
      },
    });
    expect(invalidPermission.statusCode).toBe(400);
    expect(invalidPermission.json()).toEqual({ error: 'grant_permissions_invalid' });
    const invalidExpiry = await app.inject({
      method: 'POST',
      url: '/v1/admin/grants',
      headers: { authorization: 'Bearer owner-token', 'idempotency-key': 'invalid-grant-003' },
      body: {
        resourceType: 'device',
        resourceId: 'light.office',
        granteeUserId: owner.userId,
        permissions: ['control'],
        expiresAtMs: 1,
      },
    });
    expect(invalidExpiry.statusCode).toBe(400);
    expect(invalidExpiry.json()).toEqual({ error: 'grant_expiry_invalid' });
    await app.close();
    db.close();
  });

  test('manages grants and rejects sensitive grants without explicit owner confirmation', async () => {
    const { app, db, identityRepository, verifier } = setup();
    const owner = await ensureOwner(app);
    verifier.claims = claims('resident', 'resident@example.test');
    const resident = identityRepository.provisionOidcIdentity({
      issuer: verifier.claims.issuer,
      subject: verifier.claims.subject,
      email: verifier.claims.email,
      emailVerified: true,
    });
    identityRepository.approveUser(resident.userId, 'resident');
    verifier.claims = claims('owner', 'owner@example.test');

    const denied = await app.inject({
      method: 'POST',
      url: '/v1/admin/grants',
      headers: { authorization: 'Bearer owner-token', 'idempotency-key': 'camera-grant-001' },
      body: {
        resourceType: 'camera',
        resourceId: 'camera.entry',
        granteeUserId: resident.userId,
        permissions: ['stream'],
      },
    });
    expect(denied.statusCode).toBe(403);

    const created = await app.inject({
      method: 'POST',
      url: '/v1/admin/grants',
      headers: { authorization: 'Bearer owner-token', 'idempotency-key': 'camera-grant-002' },
      body: {
        resourceType: 'camera',
        resourceId: 'camera.entry',
        granteeUserId: resident.userId,
        permissions: ['stream'],
        confirmation: 'confirm_sensitive_grant',
      },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({
      resourceType: 'camera',
      permissions: ['stream'],
      createdByUserId: owner.userId,
    });
    expect(created.body).not.toContain('test-openai-key');
    const grantId = created.json().grantId as string;
    const revokeDenied = await app.inject({
      method: 'DELETE',
      url: `/v1/admin/grants/${grantId}`,
      headers: { authorization: 'Bearer owner-token', 'idempotency-key': 'camera-revoke-001' },
      body: {},
    });
    expect(revokeDenied.statusCode).toBe(403);
    const revokeConfirmed = await app.inject({
      method: 'DELETE',
      url: `/v1/admin/grants/${grantId}`,
      headers: { authorization: 'Bearer owner-token', 'idempotency-key': 'camera-revoke-002' },
      body: { confirmation: 'confirm_sensitive_grant' },
    });
    expect(revokeConfirmed.statusCode).toBe(200);
    expect(revokeConfirmed.json().revokedAtMs).toEqual(expect.any(Number));
    await app.close();
    db.close();
  });

  test('never returns integration credential references and revokes them atomically', async () => {
    const { app, db } = setup();
    const owner = await ensureOwner(app);
    db.prepare(
      `INSERT INTO integration_connections(
      connection_id,owner_user_id,provider,scopes_json,status,credential_reference,last_error_code,created_at_ms,updated_at_ms
    ) VALUES ('google-owner',?,'google','["calendar.read"]','active','vault://top-secret','token=also-secret',1,1)`
    ).run(owner.userId);

    const listed = await app.inject({
      method: 'GET',
      url: '/v1/admin/integrations',
      headers: { authorization: 'Bearer owner-token' },
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.body).not.toContain('credential');
    expect(listed.body).not.toContain('top-secret');
    expect(listed.body).not.toContain('also-secret');
    expect(listed.json().integrations[0].lastErrorCode).toBe('integration_error');

    const revoked = await app.inject({
      method: 'POST',
      url: '/v1/admin/integrations/google-owner/revoke',
      headers: { authorization: 'Bearer owner-token', 'idempotency-key': 'revoke-google-001' },
      body: { confirmation: 'confirm_integration_revoke' },
    });
    expect(revoked.statusCode).toBe(200);
    expect(revoked.json()).toMatchObject({ connectionId: 'google-owner', status: 'revoked' });
    expect(
      db
        .prepare(
          "SELECT credential_reference credential FROM integration_connections WHERE connection_id='google-owner'"
        )
        .get()
    ).toEqual({ credential: null });
    await app.close();
    db.close();
  });

  test('returns a sanitized Home Assistant inventory with applicable grant references', async () => {
    const ha = {
      probeHealth: async () => 'ok',
      getStates: async () => [
        {
          entity_id: 'light.living_room',
          state: 'super-secret-state',
          attributes: {
            friendly_name: 'Salon',
            area_id: 'living-room',
            access_token: 'must-not-leak',
          },
        },
      ],
    } as unknown as NonNullable<AppDeps['ha']>;
    const { app, db, identityRepository, verifier } = setup(ha);
    await ensureOwner(app);
    verifier.claims = claims('resident', 'resident@example.test');
    const resident = identityRepository.provisionOidcIdentity({
      issuer: verifier.claims.issuer,
      subject: verifier.claims.subject,
      email: verifier.claims.email,
      emailVerified: true,
    });
    identityRepository.approveUser(resident.userId, 'resident');
    verifier.claims = claims('owner', 'owner@example.test');
    const grant = await app.inject({
      method: 'POST',
      url: '/v1/admin/grants',
      headers: { authorization: 'Bearer owner-token', 'idempotency-key': 'inventory-grant-001' },
      body: {
        resourceType: 'device',
        resourceId: 'light.living_room',
        granteeUserId: resident.userId,
        permissions: ['control'],
      },
    });
    const inventory = await app.inject({
      method: 'GET',
      url: '/v1/admin/home/inventory',
      headers: { authorization: 'Bearer owner-token' },
    });
    expect(inventory.statusCode).toBe(200);
    expect(inventory.json().entities[0]).toMatchObject({
      entityId: 'light.living_room',
      areaId: 'living-room',
      mapped: false,
      grantIds: [grant.json().grantId],
    });
    expect(inventory.body).not.toContain('access_token');
    expect(inventory.body).not.toContain('must-not-leak');
    expect(inventory.body).not.toContain('super-secret-state');
    await app.close();
    db.close();
  });

  test('exposes non-secret operational views and paginated audit metadata', async () => {
    const { app, db } = setup();
    const owner = await ensureOwner(app);
    db.prepare(
      `INSERT INTO audit_events(
      event_id,actor_kind,actor_id,action,target_type,outcome,metadata_json,created_at_ms
    ) VALUES ('legacy-sensitive-event','user',?,'legacy.test','test','success',?,1)`
    ).run(
      owner.userId,
      JSON.stringify({
        access_token: 'audit-token-secret',
        nested: { credentialReference: 'vault://audit-secret' },
        safe: 'kept',
      })
    );
    const services = await app.inject({
      method: 'GET',
      url: '/v1/admin/services',
      headers: { authorization: 'Bearer owner-token' },
    });
    const ai = await app.inject({
      method: 'GET',
      url: '/v1/admin/ai',
      headers: { authorization: 'Bearer owner-token' },
    });
    const operations = await app.inject({
      method: 'GET',
      url: '/v1/admin/operations',
      headers: { authorization: 'Bearer owner-token' },
    });
    const audit = await app.inject({
      method: 'GET',
      url: '/v1/admin/audit?limit=1',
      headers: { authorization: 'Bearer owner-token' },
    });
    expect(services.statusCode).toBe(200);
    expect(ai.statusCode).toBe(200);
    expect(operations.statusCode).toBe(200);
    expect(audit.statusCode).toBe(200);
    expect(`${services.body}${ai.body}${operations.body}`).not.toContain('test-openai-key');
    expect(ai.json()).toMatchObject({ provider: 'openai', configured: true });
    expect(audit.body).not.toContain('audit-token-secret');
    expect(audit.body).not.toContain('vault://audit-secret');
    expect(audit.json().events[0].metadata).toMatchObject({
      access_token: '[redacted]',
      nested: { credentialReference: '[redacted]' },
      safe: 'kept',
    });
    await app.close();
    db.close();
  });

  test('paginates audit events without skipping entries sharing a timestamp', () => {
    const db = createConversationDb(':memory:');
    const identities = new IdentityRepository(db);
    const owner = identities.provisionOidcIdentity(
      {
        issuer: 'https://issuer.example.test/realms/jarvis',
        subject: 'owner',
        email: 'owner@example.test',
        emailVerified: true,
      },
      1
    );
    identities.bootstrapOwner(owner.userId, 2);
    const admin = new AdminControlPlaneRepository(db);
    for (const action of ['first', 'second', 'third']) {
      admin.recordAudit(
        { actorUserId: owner.userId, action, targetType: 'test', outcome: 'success' },
        100
      );
    }
    const firstPage = admin.listAudit({ limit: 1 });
    expect(firstPage.events).toHaveLength(1);
    expect(firstPage.nextCursor).toBeDefined();
    const cursor = parseAuditCursor(firstPage.nextCursor as string);
    expect(cursor).not.toBeNull();
    const secondPage = admin.listAudit({ limit: 2, cursor: cursor ?? undefined });
    expect(secondPage.events).toHaveLength(2);
    expect(
      new Set([...firstPage.events, ...secondPage.events].map((event) => event.eventId)).size
    ).toBe(3);
    db.close();
  });

  test('filters audit events by actor, target domain and bounded period', () => {
    const db = createConversationDb(':memory:');
    const identities = new IdentityRepository(db);
    const owner = identities.provisionOidcIdentity(
      {
        issuer: 'https://issuer.example.test/realms/jarvis',
        subject: 'owner',
        email: 'owner@example.test',
        emailVerified: true,
      },
      1
    );
    identities.bootstrapOwner(owner.userId, 2);
    const admin = new AdminControlPlaneRepository(db);
    admin.recordAudit(
      {
        actorUserId: owner.userId,
        action: 'user.approve',
        targetType: 'user',
        targetId: 'early',
        outcome: 'success',
      },
      100
    );
    admin.recordAudit(
      {
        actorUserId: owner.userId,
        action: 'grant.create',
        targetType: 'device',
        targetId: 'light.salon',
        outcome: 'success',
      },
      200
    );
    admin.recordActorAudit(
      {
        actorKind: 'service',
        actorId: 'worker',
        action: 'grant.create',
        targetType: 'device',
        targetId: 'light.chambre',
        outcome: 'denied',
      },
      250
    );
    const result = admin.listAudit({
      limit: 20,
      actorId: owner.userId,
      targetType: 'device',
      afterMs: 150,
      beforeMs: 240,
    });
    expect(result.events).toHaveLength(1);
    expect(result.events[0]).toMatchObject({
      actorId: owner.userId,
      targetType: 'device',
      targetId: 'light.salon',
      createdAtMs: 200,
    });
    db.close();
  });

  test('expires idempotency records after the bounded retention window', () => {
    const db = createConversationDb(':memory:');
    const identities = new IdentityRepository(db);
    const owner = identities.provisionOidcIdentity(
      {
        issuer: 'https://issuer.example.test/realms/jarvis',
        subject: 'owner',
        email: 'owner@example.test',
        emailVerified: true,
      },
      1
    );
    identities.bootstrapOwner(owner.userId, 2);
    const admin = new AdminControlPlaneRepository(db);
    const context = {
      actorUserId: owner.userId,
      idempotencyKey: 'bounded-key-001',
      action: 'test.mutate',
      targetType: 'test',
    };
    let executions = 0;
    const mutate = () => ({ execution: ++executions });
    expect(admin.executeMutation(context, 'same-fingerprint', mutate, {}, 100).value).toEqual({
      execution: 1,
    });
    expect(admin.executeMutation(context, 'same-fingerprint', mutate, {}, 200).replayed).toBe(true);
    expect(
      admin.executeMutation(context, 'same-fingerprint', mutate, {}, 86_400_101).value
    ).toEqual({ execution: 2 });
    db.close();
  });
});
