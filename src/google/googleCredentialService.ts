import { getStoredRefreshToken, setStoredRefreshToken } from '../auth/oauthRefreshTokenStore';

export const GOOGLE_OAUTH_SCOPES = [
  'https://mail.google.com/',
  'https://www.googleapis.com/auth/calendar',
] as const;

export const GOOGLE_REFRESH_TOKEN_STORE_KEY_PREFIX = 'google:primary';

export type GoogleCredentialEnv = {
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  GOOGLE_REFRESH_TOKEN?: string;
  OAUTH_REFRESH_TOKEN_STORE_PATH?: string;
};

export type GoogleCredentials = {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  source: 'store' | 'env';
};

export function googleRefreshTokenStoreKey(clientId: string): string {
  return `${GOOGLE_REFRESH_TOKEN_STORE_KEY_PREFIX}:${clientId}`;
}

export async function resolveGoogleCredentials(env: GoogleCredentialEnv): Promise<GoogleCredentials | null> {
  const clientId = env.GOOGLE_CLIENT_ID?.trim();
  const clientSecret = env.GOOGLE_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) return null;

  const storeKey = googleRefreshTokenStoreKey(clientId);
  const stored = await getStoredRefreshToken(env.OAUTH_REFRESH_TOKEN_STORE_PATH, storeKey);
  if (stored) return { clientId, clientSecret, refreshToken: stored, source: 'store' };

  const envToken = env.GOOGLE_REFRESH_TOKEN?.trim();
  if (envToken) return { clientId, clientSecret, refreshToken: envToken, source: 'env' };
  return null;
}

export async function storeGoogleRefreshToken(env: GoogleCredentialEnv, refreshToken: string): Promise<void> {
  const clientId = env.GOOGLE_CLIENT_ID?.trim();
  if (!clientId) return;
  await setStoredRefreshToken(env.OAUTH_REFRESH_TOKEN_STORE_PATH, googleRefreshTokenStoreKey(clientId), refreshToken);
}
