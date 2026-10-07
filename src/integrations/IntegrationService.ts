import { createHash, randomBytes, randomUUID } from 'node:crypto';

import type { Env } from '../env';
import type { UserPrincipal } from '../identity/IdentityService';
import { CredentialVault } from './credentialVault';
import { type ConnectionKind, IntegrationRepository } from './IntegrationRepository';
import { findIntegrationProvider, type IntegrationProvider } from './providerRegistry';

const OAUTH_TRANSACTION_TTL_MS = 10 * 60_000;

function base64UrlSha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('base64url');
}

type ProviderClient = { clientId: string; clientSecret: string; authorizeUrl: string; tokenUrl: string };

export class IntegrationService {
  private readonly vault: CredentialVault | null;

  constructor(readonly repository: IntegrationRepository, private readonly env: Env) {
    this.vault = env.OAUTH_TOKEN_ENCRYPTION_KEY
      ? new CredentialVault(env.OAUTH_TOKEN_ENCRYPTION_KEY, env.OAUTH_TOKEN_KEY_VERSION)
      : null;
  }

  private providerClient(provider: IntegrationProvider): ProviderClient | null {
    if (!this.vault) return null;
    if (provider.oauthFamily === 'google') {
      return this.env.GOOGLE_CLIENT_ID && this.env.GOOGLE_CLIENT_SECRET ? {
        clientId: this.env.GOOGLE_CLIENT_ID, clientSecret: this.env.GOOGLE_CLIENT_SECRET,
        authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth', tokenUrl: 'https://oauth2.googleapis.com/token',
      } : null;
    }
    if (provider.oauthFamily === 'microsoft') {
      const tenant = encodeURIComponent(this.env.MICROSOFT_TENANT_ID);
      return this.env.MICROSOFT_CLIENT_ID && this.env.MICROSOFT_CLIENT_SECRET ? {
        clientId: this.env.MICROSOFT_CLIENT_ID, clientSecret: this.env.MICROSOFT_CLIENT_SECRET,
        authorizeUrl: `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/authorize`,
        tokenUrl: `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`,
      } : null;
    }
    return this.env.SPOTIFY_WEBAPI_CLIENT_ID && this.env.SPOTIFY_WEBAPI_CLIENT_SECRET ? {
      clientId: this.env.SPOTIFY_WEBAPI_CLIENT_ID, clientSecret: this.env.SPOTIFY_WEBAPI_CLIENT_SECRET,
      authorizeUrl: 'https://accounts.spotify.com/authorize', tokenUrl: 'https://accounts.spotify.com/api/token',
    } : null;
  }

  providerStates() {
    return ['google-calendar', 'gmail', 'microsoft-todo', 'spotify'].map((key) => {
      const provider = findIntegrationProvider(key)!;
      return { key: provider.key, label: provider.label, scopes: provider.scopes,
        configured: Boolean(this.providerClient(provider)), aiDisclosure: provider.aiDisclosure ?? null };
    });
  }

  private redirectUri(): string {
    return this.env.INTEGRATION_OAUTH_REDIRECT_URI ?? 'http://127.0.0.1:8090/v1/integrations/oauth/callback';
  }

  private authorizationUrl(provider: IntegrationProvider, client: ProviderClient, state: string, verifier: string, redirectUri: string): string {
    const params = new URLSearchParams({ client_id: client.clientId, redirect_uri: redirectUri, response_type: 'code',
      scope: provider.scopes.join(' '), state, code_challenge: base64UrlSha256(verifier), code_challenge_method: 'S256' });
    if (provider.oauthFamily === 'google') {
      params.set('access_type', 'offline'); params.set('prompt', 'consent'); params.set('include_granted_scopes', 'true');
    } else if (provider.oauthFamily === 'microsoft') params.set('response_mode', 'query');
    return `${client.authorizeUrl}?${params.toString()}`;
  }

  beginAuthorization(input: { principal: UserPrincipal; providerKey: string; kind: ConnectionKind; displayName?: string; householdId?: string }) {
    if (input.principal.status !== 'active') throw new Error('identity_account_unavailable');
    const provider = findIntegrationProvider(input.providerKey);
    if (!provider) throw new Error('integration_provider_unknown');
    if (!input.principal.permissions.includes(provider.permission)) throw new Error('identity_permission_denied');
    const client = this.providerClient(provider);
    if (!client) throw new Error('integration_provider_unavailable');
    const redirectUri = this.redirectUri();
    const state = randomBytes(32).toString('base64url');
    const verifier = randomBytes(64).toString('base64url');
    const connectionId = this.repository.beginOAuth({ ownerUserId: input.principal.userId, provider: provider.key,
      kind: input.kind, displayName: input.displayName, householdId: input.householdId, scopes: provider.scopes,
      state, codeVerifier: verifier, redirectUri, expiresAtMs: Date.now() + OAUTH_TRANSACTION_TTL_MS });
    return { connectionId, authorizationUrl: this.authorizationUrl(provider, client, state, verifier, redirectUri),
      expiresInSeconds: OAUTH_TRANSACTION_TTL_MS / 1000 };
  }

  beginReauthorization(input: { principal: UserPrincipal; connectionId: string }) {
    if (input.principal.status !== 'active') throw new Error('identity_account_unavailable');
    const visible = this.repository.listForUser(input.principal.userId).find((item) => item.connectionId === input.connectionId);
    if (!visible) throw new Error('integration_not_found');
    const provider = findIntegrationProvider(visible.provider);
    if (!provider || !input.principal.permissions.includes(provider.permission)) throw new Error('identity_permission_denied');
    const client = this.providerClient(provider);
    if (!client) throw new Error('integration_provider_unavailable');
    const redirectUri = this.redirectUri();
    const state = randomBytes(32).toString('base64url');
    const verifier = randomBytes(64).toString('base64url');
    this.repository.beginReauthorization({ actorUserId: input.principal.userId, connectionId: input.connectionId,
      state, codeVerifier: verifier, redirectUri,
      expiresAtMs: Date.now() + OAUTH_TRANSACTION_TTL_MS });
    return { connectionId: input.connectionId,
      authorizationUrl: this.authorizationUrl(provider, client, state, verifier, redirectUri),
      expiresInSeconds: OAUTH_TRANSACTION_TTL_MS / 1000 };
  }

  async completeAuthorization(input: { state: string; code?: string; providerError?: string }): Promise<{ connectionId: string }> {
    const transaction = this.repository.consumeOAuthTransaction(input.state);
    if (!transaction) throw new Error('integration_oauth_state_invalid');
    const provider = findIntegrationProvider(transaction.provider);
    if (!provider || !this.repository.userHasPermission(transaction.ownerUserId, provider.permission)) {
      this.repository.markError(transaction.connectionId, 'authorization_invalidated');
      throw new Error('integration_authorization_invalidated');
    }
    if (input.providerError) {
      this.repository.markError(transaction.connectionId, 'consent_denied');
      throw new Error('integration_consent_denied');
    }
    const client = this.providerClient(provider);
    if (!input.code || !client || !this.vault) {
      this.repository.markError(transaction.connectionId, 'oauth_configuration_error');
      throw new Error('integration_provider_unavailable');
    }
    const tokenResponse = await fetch(client.tokenUrl, { method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: client.clientId, client_secret: client.clientSecret, code: input.code,
        code_verifier: transaction.codeVerifier, grant_type: 'authorization_code', redirect_uri: transaction.redirectUri }),
      signal: AbortSignal.timeout(8_000) });
    if (!tokenResponse.ok) {
      await tokenResponse.text().catch(() => '');
      this.repository.markError(transaction.connectionId, 'code_exchange_failed');
      throw new Error('integration_code_exchange_failed');
    }
    const tokens = await tokenResponse.json() as { access_token?: string; refresh_token?: string; scope?: string };
    if (!tokens.refresh_token) {
      this.repository.markError(transaction.connectionId, 'refresh_token_missing');
      throw new Error('integration_refresh_token_missing');
    }
    let providerSubject: string | undefined;
    let providerEmail: string | undefined;
    if (tokens.access_token) {
      const profileUrl = provider.oauthFamily === 'google' ? 'https://openidconnect.googleapis.com/v1/userinfo'
        : provider.oauthFamily === 'microsoft' ? 'https://graph.microsoft.com/v1.0/me?$select=id,mail,userPrincipalName'
          : 'https://api.spotify.com/v1/me';
      const response = await fetch(profileUrl, { headers: { authorization: `Bearer ${tokens.access_token}` }, signal: AbortSignal.timeout(5_000) });
      if (response.ok) {
        const profile = await response.json() as { sub?: string; id?: string; email?: string; mail?: string; userPrincipalName?: string };
        providerSubject = profile.sub ?? profile.id;
        providerEmail = profile.email ?? profile.mail ?? profile.userPrincipalName;
      }
    }
    const credentialId = randomUUID();
    this.repository.activate({ connectionId: transaction.connectionId, credentialId,
      encrypted: this.vault.encrypt(tokens.refresh_token, credentialId), providerSubject, providerEmail,
      scopes: tokens.scope?.split(' ').filter(Boolean) ?? provider.scopes });
    return { connectionId: transaction.connectionId };
  }

  resolveRefreshToken(userId: string, provider: string, connectionId?: string): string | null {
    if (!this.vault) return null;
    const selected = this.repository.getCredentialForUser({ userId, provider, connectionId });
    return selected ? this.vault.decrypt(selected.encrypted, selected.credentialId) : null;
  }

  rotateRefreshToken(userId: string, provider: string, token: string, connectionId?: string): void {
    if (!this.vault || !token.trim()) return;
    const selected = this.repository.getCredentialForUser({ userId, provider, connectionId });
    if (!selected) throw new Error('integration_credential_not_found');
    this.repository.updateCredential(selected.credentialId, this.vault.encrypt(token, selected.credentialId), userId);
  }

  async revoke(principal: UserPrincipal, connectionId: string): Promise<boolean> {
    if (principal.status !== 'active') throw new Error('identity_account_unavailable');
    const connection = this.repository.listForUser(principal.userId).find((item) => item.connectionId === connectionId);
    if (!connection) return false;
    const token = this.resolveRefreshToken(principal.userId, connection.provider, connectionId);
    const revoked = this.repository.revoke(principal.userId, connectionId);
    if (!revoked) return false;
    if (token && ['google-calendar', 'gmail'].includes(connection.provider)
      && this.repository.canRemotelyRevokeGoogle(connectionId)) {
      await fetch('https://oauth2.googleapis.com/revoke', { method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token }),
        signal: AbortSignal.timeout(5_000) }).catch(() => undefined);
    }
    return true;
  }
}
