import { FastifyInstance } from 'fastify';
import { AppDeps } from '../server';
import { setStoredRefreshToken } from '../auth/oauthRefreshTokenStore';

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

    const params = new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,
      redirect_uri: 'urn:ietf:wg:oauth:2.0:oob',
      response_type: 'code',
      scope: 'https://mail.google.com/',
      access_type: 'offline',
      prompt: 'consent',
    });

    const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
    return reply.send({
      authorization_url: authUrl,
      instructions: 'Open the URL above, authorize, then copy the displayed code and call /v1/oauth/google/callback?code=<code>',
    });
  });

  /**
   * GET /v1/oauth/google/callback?code=...
   * Exchanges the authorization code for a refresh token and stores it.
   */
  app.get<{ Querystring: { code?: string } }>('/v1/oauth/google/callback', async (req, reply) => {
    const env = deps.env;
    const code = req.query.code?.trim();

    if (!code) {
      return reply.code(400).send({
        error: 'missing_code',
        message: 'code query parameter is required',
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
          redirect_uri: 'urn:ietf:wg:oauth:2.0:oob',
        }),
        signal: AbortSignal.timeout(8_000),
      });

      if (!tokenResponse.ok) {
        const errorText = await tokenResponse.text().catch(() => 'Unknown error');
        return reply.code(401).send({
          error: 'code_exchange_failed',
          message: `Google returned ${tokenResponse.status}: ${errorText.slice(0, 200)}`,
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
      const msg = error instanceof Error ? error.message : String(error);
      return reply.code(500).send({
        error: 'token_exchange_error',
        message: msg,
      });
    }
  });
}
