import { randomBytes } from 'node:crypto';

import { FastifyInstance } from 'fastify';

import { setStoredRefreshToken } from '../auth/oauthRefreshTokenStore';
import { AppDeps } from '../server';

const OAUTH_STATE_TTL_MS = 10 * 60_000;
const MAX_PENDING_OAUTH_STATES = 64;

/**
 * OAuth routes for credential acquisition (oneshot flow).
 *
 * GET  /v1/oauth/google/authorize     → Returns authorization URL
 * GET  /v1/oauth/google/callback      → Exchanges code for refresh token
 *
 * Usage:
 *   1. Call GET /v1/oauth/google/authorize
 *   2. User opens the returned URL and authorizes
 *   3. Google shows a code
 *   4. User calls GET /v1/oauth/google/callback?code=...
 *   5. Jarvis stores the refresh token and returns success
 */

export function registerOAuthRoutes(app: FastifyInstance, deps: AppDeps): void {
  const redirectUri = deps.env.OAUTH_REDIRECT_URI?.trim() || 'http://127.0.0.1:8090/v1/oauth/google/callback';
  const pendingStates = new Map<string, number>();

  const issueState = (): string => {
    const now = Date.now();
    for (const [state, expiresAt] of pendingStates) {
      if (expiresAt <= now) pendingStates.delete(state);
    }
    while (pendingStates.size >= MAX_PENDING_OAUTH_STATES) {
      const oldest = pendingStates.keys().next().value as string | undefined;
      if (!oldest) break;
      pendingStates.delete(oldest);
    }
    const state = randomBytes(32).toString('base64url');
    pendingStates.set(state, now + OAUTH_STATE_TTL_MS);
    return state;
  };

  const consumeState = (state: string): boolean => {
    const expiresAt = pendingStates.get(state);
    pendingStates.delete(state);
    return typeof expiresAt === 'number' && expiresAt > Date.now();
  };

  /**
   * GET /v1/oauth/google/authorize
   * Returns the Google authorization URL for oneshot Gmail setup.
   */
  app.get<{ Querystring: Record<string, unknown> }>('/v1/oauth/google/authorize', async (req, reply) => {
    const env = deps.env;
    if (!env.GOOGLE_CLIENT_ID) {
      return reply.code(503).send({
        error: 'google_oauth_not_configured',
        message: 'GOOGLE_CLIENT_ID not set',
      });
    }

    const state = issueState();
    const params = new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: 'https://mail.google.com/',
      access_type: 'offline',
      prompt: 'consent',
      state,
    });

    const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
    return reply.send({
      authorization_url: authUrl,
      state_expires_in_seconds: OAUTH_STATE_TTL_MS / 1000,
    });
  });

  /**
   * GET /v1/oauth/google/callback?code=...
   * Exchanges the authorization code for a refresh token and stores it.
   */
  app.get<{ Querystring: { code?: string; state?: string } }>('/v1/oauth/google/callback', async (req, reply) => {
    const env = deps.env;
    const code = req.query.code?.trim();
    const state = req.query.state?.trim();

    if (!code || !state) {
      return reply.code(400).send({
        error: 'missing_oauth_parameters',
        message: 'code and state query parameters are required',
      });
    }

    if (!consumeState(state)) {
      return reply.code(403).send({
        error: 'invalid_oauth_state',
        message: 'OAuth state is invalid or expired',
      });
    }

    if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
      return reply.code(503).send({
        error: 'google_oauth_not_configured',
        message: 'GOOGLE_CLIENT_ID or GOOGLE_CLIENT_SECRET not set',
      });
    }

    try {
      // Exchange code for tokens
      const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: env.GOOGLE_CLIENT_ID,
          client_secret: env.GOOGLE_CLIENT_SECRET,
          code,
          grant_type: 'authorization_code',
          redirect_uri: redirectUri,
        }),
        signal: AbortSignal.timeout(8_000),
      });

      if (!tokenResponse.ok) {
        await tokenResponse.text().catch(() => '');
        app.log.warn({ status: tokenResponse.status }, 'google_oauth_code_exchange_failed');
        return reply.code(401).send({
          error: 'code_exchange_failed',
          message: 'Google rejected the authorization code',
        });
      }

      const tokenData = (await tokenResponse.json()) as Record<string, unknown>;
      const refreshToken = tokenData.refresh_token as string | undefined;
      const accessToken = tokenData.access_token as string | undefined;

      if (!refreshToken) {
        return reply.code(401).send({
          error: 'no_refresh_token',
          message: 'Google did not return a refresh_token (check scope and prompt=consent)',
        });
      }

      // Store the refresh token
      const storeKey = `mail:gmail:${env.GOOGLE_CLIENT_ID}`;
      await setStoredRefreshToken(
        env.OAUTH_REFRESH_TOKEN_STORE_PATH,
        storeKey,
        refreshToken,
      );

      // Also try to verify the token works
      if (accessToken) {
        try {
          const verifyResp = await fetch('https://www.googleapis.com/oauth2/v1/userinfo', {
            headers: { authorization: `Bearer ${accessToken}` },
            signal: AbortSignal.timeout(3_000),
          });

          if (verifyResp.ok) {
            const userInfo = (await verifyResp.json()) as Record<string, unknown>;
            const email = userInfo.email as string | undefined;
            return reply.send({
              success: true,
              message: 'Gmail authorization successful!',
              email,
              refresh_token_stored: true,
            });
          }
        } catch {
          // Verification failed but token was stored, so just return success anyway
        }
      }

      return reply.send({
        success: true,
        message: 'Gmail authorization successful! Refresh token has been stored.',
        refresh_token_stored: true,
      });
    } catch (error) {
      app.log.warn({ error }, 'google_oauth_callback_failed');
      return reply.code(500).send({
        error: 'token_exchange_error',
        message: 'OAuth token exchange failed',
      });
    }
  });
}
