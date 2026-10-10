import { createRemoteJWKSet, jwtVerify } from 'jose';

export type VerifiedOidcClaims = {
  issuer: string;
  subject: string;
  email: string;
  emailVerified: boolean;
  displayName?: string;
  providerSessionId: string;
  clientId?: string;
  expiresAtMs: number;
};

export interface AccessTokenVerifier {
  verify(token: string): Promise<VerifiedOidcClaims>;
}

export type OidcVerifierConfig = {
  issuer: string;
  audience: string;
  jwksUrl: string;
  algorithms: string[];
  clockToleranceSeconds: number;
  maxTokenBytes: number;
};

export class OidcTokenVerifier implements AccessTokenVerifier {
  private readonly jwks: ReturnType<typeof createRemoteJWKSet>;

  constructor(private readonly config: OidcVerifierConfig) {
    this.jwks = createRemoteJWKSet(new URL(config.jwksUrl), {
      timeoutDuration: 5_000,
      cooldownDuration: 30_000,
      cacheMaxAge: 10 * 60_000,
    });
  }

  async verify(token: string): Promise<VerifiedOidcClaims> {
    if (!token || Buffer.byteLength(token, 'utf8') > this.config.maxTokenBytes) {
      throw new Error('oidc_invalid_token');
    }
    try {
      const { payload } = await jwtVerify(token, this.jwks, {
        issuer: this.config.issuer,
        audience: this.config.audience,
        algorithms: this.config.algorithms,
        clockTolerance: this.config.clockToleranceSeconds,
        requiredClaims: ['exp', 'iat', 'sub', 'email', 'email_verified', 'sid'],
      });
      if (
        typeof payload.sub !== 'string'
        || typeof payload.email !== 'string'
        || payload.email_verified !== true
        || typeof payload.sid !== 'string'
        || typeof payload.exp !== 'number'
      ) {
        throw new Error('oidc_required_claim_invalid');
      }
      const displayName = typeof payload.name === 'string' ? payload.name : undefined;
      const clientId = typeof payload.azp === 'string' && payload.azp.length <= 128
        ? payload.azp
        : undefined;
      return {
        issuer: this.config.issuer,
        subject: payload.sub,
        email: payload.email,
        emailVerified: true,
        displayName,
        providerSessionId: `${this.config.issuer}\u001f${payload.sid}`,
        clientId,
        expiresAtMs: payload.exp * 1_000,
      };
    } catch {
      throw new Error('oidc_invalid_token');
    }
  }
}
