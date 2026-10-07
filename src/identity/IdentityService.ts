import {
  type AuthorizedUser,
  IdentityRepository,
  type PermissionKey,
} from './IdentityRepository';
import type { AccessTokenVerifier } from './OidcTokenVerifier';

export type UserPrincipal = AuthorizedUser & {
  kind: 'user';
  sessionId: string;
};

export class IdentityService {
  constructor(
    readonly repository: IdentityRepository,
    private readonly verifier: AccessTokenVerifier,
    private readonly bootstrapOwnerSubject?: string,
  ) {}

  async authenticate(token: string, now = Date.now()): Promise<UserPrincipal> {
    const claims = await this.verifier.verify(token);
    let user = this.repository.provisionOidcIdentity({
      issuer: claims.issuer,
      subject: claims.subject,
      email: claims.email,
      emailVerified: claims.emailVerified,
      displayName: claims.displayName,
    }, now);
    if (user.status === 'pending' && claims.subject === this.bootstrapOwnerSubject) {
      user = this.repository.bootstrapOwner(user.userId, now);
    }
    const session = this.repository.touchSession({
      userId: user.userId,
      providerSessionId: claims.providerSessionId,
      expiresAtMs: claims.expiresAtMs,
    }, now);
    if (session.status !== 'active') throw new Error('identity_session_revoked');

    const authorized = this.repository.findAuthorizedUser(user.userId);
    if (!authorized) throw new Error('identity_user_not_found');
    if (claims.subject === this.bootstrapOwnerSubject && authorized.roles.includes('owner')) {
      this.repository.ensureOwnerHousehold(authorized.userId, now);
      this.repository.claimLegacyConversationData(authorized.userId, now);
    }
    return { ...authorized, kind: 'user', sessionId: session.sessionId };
  }

  assertActive(principal: UserPrincipal): void {
    if (principal.status !== 'active') throw new Error(`identity_account_${principal.status}`);
  }

  assertPermission(principal: UserPrincipal, permission: PermissionKey): void {
    this.assertActive(principal);
    if (!principal.permissions.includes(permission)) throw new Error('identity_permission_denied');
  }
}
