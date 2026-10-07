import { createServer, type Server } from 'node:http';

import { afterAll, beforeAll, describe, expect, test } from '@jest/globals';
import { exportJWK, generateKeyPair, type KeyLike,SignJWT } from 'jose';

import { OidcTokenVerifier } from '../src/identity/OidcTokenVerifier';

describe('OIDC token verifier', () => {
  let server: Server;
  let privateKey: KeyLike;
  let issuer: string;
  let verifier: OidcTokenVerifier;

  beforeAll(async () => {
    const keys = await generateKeyPair('RS256');
    privateKey = keys.privateKey;
    const publicJwk = await exportJWK(keys.publicKey);
    server = createServer((_request, response) => {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ keys: [{ ...publicJwk, kid: 'test', use: 'sig', alg: 'RS256' }] }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('test_server_address');
    issuer = 'https://issuer.example.test/realms/jarvis';
    verifier = new OidcTokenVerifier({
      issuer,
      audience: 'jarvis-api',
      jwksUrl: `http://127.0.0.1:${address.port}/certs`,
      algorithms: ['RS256'],
      clockToleranceSeconds: 0,
      maxTokenBytes: 8192,
    });
  });

  afterAll(async () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));

  async function token(overrides: Record<string, unknown> = {}) {
    const now = Math.floor(Date.now() / 1000);
    return new SignJWT({ email: 'person@example.test', email_verified: true, sid: 'device-session', ...overrides })
      .setProtectedHeader({ alg: 'RS256', kid: 'test' })
      .setIssuer(issuer)
      .setAudience('jarvis-api')
      .setSubject('subject-1')
      .setIssuedAt(now)
      .setExpirationTime(now + 300)
      .sign(privateKey);
  }

  test('verifies signature and required identity claims', async () => {
    await expect(verifier.verify(await token())).resolves.toMatchObject({
      issuer,
      subject: 'subject-1',
      email: 'person@example.test',
      providerSessionId: `${issuer}\u001fdevice-session`,
    });
  });

  test('rejects wrong audience, issuer and expired tokens', async () => {
    const now = Math.floor(Date.now() / 1000);
    const wrongAudience = await new SignJWT({ email: 'person@example.test', email_verified: true, sid: 'sid' })
      .setProtectedHeader({ alg: 'RS256', kid: 'test' }).setIssuer(issuer).setAudience('other')
      .setSubject('subject-1').setIssuedAt(now).setExpirationTime(now + 300).sign(privateKey);
    const wrongIssuer = await new SignJWT({ email: 'person@example.test', email_verified: true, sid: 'sid' })
      .setProtectedHeader({ alg: 'RS256', kid: 'test' }).setIssuer('https://other.example.test').setAudience('jarvis-api')
      .setSubject('subject-1').setIssuedAt(now).setExpirationTime(now + 300).sign(privateKey);
    const expired = await new SignJWT({ email: 'person@example.test', email_verified: true, sid: 'sid' })
      .setProtectedHeader({ alg: 'RS256', kid: 'test' }).setIssuer(issuer).setAudience('jarvis-api')
      .setSubject('subject-1').setIssuedAt(now - 600).setExpirationTime(now - 300).sign(privateKey);
    await expect(verifier.verify(wrongAudience)).rejects.toThrow('oidc_invalid_token');
    await expect(verifier.verify(wrongIssuer)).rejects.toThrow('oidc_invalid_token');
    await expect(verifier.verify(expired)).rejects.toThrow('oidc_invalid_token');
  });
});
