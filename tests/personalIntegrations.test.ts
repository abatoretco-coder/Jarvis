import { afterEach, describe, expect, it, jest } from '@jest/globals';

import { createConversationDb } from '../src/conversation/repositories/SqliteRepositories';
import type { Env } from '../src/env';
import type { UserPrincipal } from '../src/identity/IdentityService';
import { CredentialVault } from '../src/integrations/credentialVault';
import { IntegrationRepository } from '../src/integrations/IntegrationRepository';
import { IntegrationService } from '../src/integrations/IntegrationService';

const key = Buffer.alloc(32, 7).toString('base64');
const originalFetch = global.fetch;

function env(): Env {
  return {
    GOOGLE_CLIENT_ID: 'google-client',
    GOOGLE_CLIENT_SECRET: 'google-secret',
    OAUTH_TOKEN_ENCRYPTION_KEY: key,
    OAUTH_TOKEN_KEY_VERSION: 1,
    INTEGRATION_OAUTH_REDIRECT_URI: 'https://jarvis.example.test/v1/integrations/oauth/google/callback',
    MICROSOFT_TENANT_ID: 'common',
    MICROSOFT_CLIENT_ID: 'microsoft-client',
    MICROSOFT_CLIENT_SECRET: 'microsoft-secret',
    SPOTIFY_WEBAPI_CLIENT_ID: 'spotify-client',
    SPOTIFY_WEBAPI_CLIENT_SECRET: 'spotify-secret',
  } as Env;
}

function principal(userId: string, email: string): UserPrincipal {
  return {
    kind: 'user',
    userId,
    email,
    displayName: email,
    status: 'active',
    roles: ['resident'],
    permissions: ['calendar'],
    sessionId: `session-${userId}`,
  };
}

function fullPrincipal(userId: string, email: string): UserPrincipal {
  return { ...principal(userId, email), permissions: ['calendar', 'mail', 'todo', 'music'] };
}

function insertUser(db: ReturnType<typeof createConversationDb>, userId: string, email: string): void {
  db.prepare(
    `INSERT INTO users(user_id,email_normalized,display_name,status,created_at_ms,updated_at_ms)
     VALUES (?,?,?,'active',1,1)`
  ).run(userId, email, email);
  db.prepare(
    "INSERT INTO user_roles(user_id,role_key,granted_at_ms) VALUES (?,'resident',1)"
  ).run(userId);
}

afterEach(() => {
  global.fetch = originalFetch;
  jest.restoreAllMocks();
});

describe('personal integration isolation', () => {
  it('encrypts credentials with authenticated metadata and rejects tampering', () => {
    const vault = new CredentialVault(key);
    const encrypted = vault.encrypt('refresh-secret', 'credential-a');
    expect(encrypted.ciphertext).not.toContain('refresh-secret');
    expect(vault.decrypt(encrypted, 'credential-a')).toBe('refresh-secret');
    expect(() => vault.decrypt({ ...encrypted, authTag: Buffer.alloc(16).toString('base64') }, 'credential-a'))
      .toThrow('integration_credential_decryption_failed');
    expect(() => vault.decrypt(encrypted, 'credential-b'))
      .toThrow('integration_credential_decryption_failed');
  });

  it('binds PKCE callbacks to their initiating users without cross-account token access', async () => {
    const db = createConversationDb(':memory:');
    insertUser(db, 'user-a', 'a@example.test');
    insertUser(db, 'user-b', 'b@example.test');
    const repository = new IntegrationRepository(db);
    const service = new IntegrationService(repository, env());

    const first = service.beginAuthorization({
      principal: principal('user-a', 'a@example.test'),
      providerKey: 'google-calendar',
      kind: 'personal',
    });
    const second = service.beginAuthorization({
      principal: principal('user-b', 'b@example.test'),
      providerKey: 'google-calendar',
      kind: 'personal',
    });
    const firstUrl = new URL(first.authorizationUrl);
    const secondUrl = new URL(second.authorizationUrl);
    expect(firstUrl.searchParams.get('code_challenge_method')).toBe('S256');
    expect(firstUrl.searchParams.get('state')).not.toBe(secondUrl.searchParams.get('state'));
    expect(firstUrl.searchParams.get('scope')).toContain('calendar');

    let tokenExchangeCount = 0;
    global.fetch = jest.fn(async (input) => {
      const url = String(input);
      if (url.includes('/token')) {
        tokenExchangeCount += 1;
        return new Response(JSON.stringify({
          access_token: `access-${tokenExchangeCount}`,
          refresh_token: `refresh-${tokenExchangeCount}`,
          scope: 'openid email https://www.googleapis.com/auth/calendar',
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify({ sub: 'provider-user', email: 'owner@example.test' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;

    await service.completeAuthorization({
      state: firstUrl.searchParams.get('state')!,
      code: 'code-a',
    });
    await service.completeAuthorization({
      state: secondUrl.searchParams.get('state')!,
      code: 'code-b',
    });

    expect(service.resolveRefreshToken('user-a', 'google-calendar')).toBe('refresh-1');
    expect(service.resolveRefreshToken('user-b', 'google-calendar')).toBe('refresh-2');
    expect(repository.listForUser('user-a')).toHaveLength(1);
    expect(repository.listForUser('user-b')).toHaveLength(1);
    expect(repository.listForUser('user-a')[0]?.connectionId).not.toBe(
      repository.listForUser('user-b')[0]?.connectionId
    );
    service.rotateRefreshToken('user-a', 'google-calendar', 'refresh-1-rotated');
    expect(service.resolveRefreshToken('user-a', 'google-calendar')).toBe('refresh-1-rotated');
    db.prepare("UPDATE users SET status='suspended' WHERE user_id='user-a'").run();
    expect(service.resolveRefreshToken('user-a', 'google-calendar')).toBeNull();
    expect(service.resolveRefreshToken('user-b', 'google-calendar')).toBe('refresh-2');
    expect(() => service.completeAuthorization({
      state: firstUrl.searchParams.get('state')!,
      code: 'replayed-code',
    })).rejects.toThrow('integration_oauth_state_invalid');
    db.close();
  });

  it('requires an explicit label and household administration for shared connections', () => {
    const db = createConversationDb(':memory:');
    insertUser(db, 'owner', 'owner@example.test');
    insertUser(db, 'resident', 'resident@example.test');
    db.exec(`
      INSERT INTO households(household_id,name,created_by_user_id,created_at_ms,updated_at_ms)
      VALUES ('home:owner','Maison','owner',1,1);
      INSERT INTO household_memberships(household_id,user_id,role_key,status,created_at_ms,updated_at_ms)
      VALUES ('home:owner','owner','owner','active',1,1),
             ('home:owner','resident','resident','active',1,1);
    `);
    const repository = new IntegrationRepository(db);
    const service = new IntegrationService(repository, env());
    expect(() => service.beginAuthorization({
      principal: principal('owner', 'owner@example.test'),
      providerKey: 'google-calendar',
      kind: 'household_shared',
      householdId: 'home:owner',
    })).toThrow('integration_shared_name_required');
    expect(() => service.beginAuthorization({
      principal: principal('resident', 'resident@example.test'),
      providerKey: 'google-calendar',
      kind: 'household_shared',
      householdId: 'home:owner',
      displayName: 'Agenda familial',
    })).toThrow('integration_household_admin_required');
    const shared = service.beginAuthorization({
      principal: principal('owner', 'owner@example.test'),
      providerKey: 'google-calendar',
      kind: 'household_shared',
      householdId: 'home:owner',
      displayName: 'Agenda familial',
    });
    const credentialId = 'shared-credential';
    const vault = new CredentialVault(key);
    repository.activate({
      connectionId: shared.connectionId,
      credentialId,
      encrypted: vault.encrypt('shared-refresh', credentialId),
      scopes: ['https://www.googleapis.com/auth/calendar'],
    });
    expect(repository.listForUser('resident').map((item) => item.displayName))
      .toContain('Agenda familial');
    expect(service.resolveRefreshToken('resident', 'google-calendar')).toBeNull();
    expect(service.resolveRefreshToken('resident', 'google-calendar', shared.connectionId))
      .toBe('shared-refresh');
    const renewedCredentialId = 'shared-credential-renewed';
    repository.activate({
      connectionId: shared.connectionId,
      credentialId: renewedCredentialId,
      encrypted: vault.encrypt('shared-refresh-renewed', renewedCredentialId),
      scopes: ['https://www.googleapis.com/auth/calendar'],
    });
    const grantCount = db.prepare(
      "SELECT COUNT(*) count FROM resource_grants WHERE resource_type='integration_connection' AND resource_id=? AND revoked_at_ms IS NULL"
    ).get(shared.connectionId) as { count: number };
    expect(grantCount.count).toBe(1);
    db.close();
  });

  it('builds PKCE authorization requests for every supported provider family', () => {
    const db = createConversationDb(':memory:');
    insertUser(db, 'owner', 'owner@example.test');
    const service = new IntegrationService(new IntegrationRepository(db), env());
    const expectedHosts = new Map([
      ['google-calendar', 'accounts.google.com'], ['gmail', 'accounts.google.com'],
      ['microsoft-todo', 'login.microsoftonline.com'], ['spotify', 'accounts.spotify.com'],
    ]);
    for (const [providerKey, host] of expectedHosts) {
      const result = service.beginAuthorization({
        principal: fullPrincipal('owner', 'owner@example.test'), providerKey, kind: 'personal',
      });
      const url = new URL(result.authorizationUrl);
      expect(url.host).toBe(host);
      expect(url.searchParams.get('code_challenge_method')).toBe('S256');
      expect(url.searchParams.get('state')).toBeTruthy();
    }
    expect(service.providerStates().every((provider) => provider.configured)).toBe(true);
    db.close();
  });

  it('keeps an active credential when renewed consent is denied', () => {
    const db = createConversationDb(':memory:');
    insertUser(db, 'owner', 'owner@example.test');
    const repository = new IntegrationRepository(db);
    const service = new IntegrationService(repository, env());
    const pending = service.beginAuthorization({
      principal: principal('owner', 'owner@example.test'), providerKey: 'google-calendar', kind: 'personal',
    });
    const credentialId = 'existing-credential';
    repository.activate({ connectionId: pending.connectionId, credentialId,
      encrypted: new CredentialVault(key).encrypt('still-valid', credentialId), scopes: ['calendar'] });
    const renewal = service.beginReauthorization({
      principal: principal('owner', 'owner@example.test'), connectionId: pending.connectionId,
    });
    const state = new URL(renewal.authorizationUrl).searchParams.get('state')!;
    expect(service.completeAuthorization({ state, providerError: 'access_denied' }))
      .rejects.toThrow('integration_consent_denied');
    expect(service.resolveRefreshToken('owner', 'google-calendar')).toBe('still-valid');
    expect(repository.listForUser('owner')[0]?.status).toBe('active');
    db.close();
  });
});
