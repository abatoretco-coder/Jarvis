import { execFileSync } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';

export type LiveOwnerTokens = { access_token: string; refresh_token: string };

const keycloakUrl = process.env.E2E_LIVE_KEYCLOAK_URL ?? 'http://127.0.0.1:8180';
const identityContainer = process.env.E2E_LIVE_IDENTITY_CONTAINER ?? 'jarvis-pc-identity-1';

export function liveBaseUrl(): string {
  return (process.env.E2E_LIVE_BASE_URL ?? 'https://jarvis-abato.duckdns.org')
    .replace(/\/app\/?$/u, '')
    .replace(/\/$/u, '');
}

export function liveOwnerEmail(): string {
  return process.env.E2E_LIVE_OWNER_EMAIL ?? 'abatoretco@gmail.com';
}

function dockerEnv(name: string): string {
  return execFileSync('docker', ['exec', identityContainer, 'printenv', name], {
    encoding: 'utf8',
    windowsHide: true,
  }).trim();
}

function base64Url(value: Buffer): string {
  return value.toString('base64url');
}

async function jsonResponse<T>(response: Response): Promise<T> {
  const body = await response.text();
  if (!response.ok) throw new Error(`http_${response.status}:${body.slice(0, 500)}`);
  return JSON.parse(body) as T;
}

async function form<T>(url: string, body: Record<string, string>): Promise<T> {
  return jsonResponse<T>(
    await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(body),
    })
  );
}

export async function liveOwnerTokens(): Promise<LiveOwnerTokens> {
  const admin = await form<{ access_token: string }>(
    `${keycloakUrl}/realms/master/protocol/openid-connect/token`,
    {
      client_id: 'admin-cli',
      grant_type: 'password',
      username: dockerEnv('KC_BOOTSTRAP_ADMIN_USERNAME'),
      password: dockerEnv('KC_BOOTSTRAP_ADMIN_PASSWORD'),
    }
  );
  const ownerResponse = await fetch(
    `${keycloakUrl}/admin/realms/jarvis/users?username=${encodeURIComponent(liveOwnerEmail())}&exact=true`,
    { headers: { authorization: `Bearer ${admin.access_token}` } }
  );
  const owners = await jsonResponse<Array<{ id: string }>>(ownerResponse);
  if (owners.length !== 1) throw new Error('owner_keycloak_user_not_found');

  const impersonation = await fetch(
    `${keycloakUrl}/admin/realms/jarvis/users/${encodeURIComponent(owners[0].id)}/impersonation`,
    { method: 'POST', headers: { authorization: `Bearer ${admin.access_token}` } }
  );
  if (!impersonation.ok) throw new Error(`owner_impersonation_failed:${impersonation.status}`);
  const cookieHeaders = (
    impersonation.headers as Headers & { getSetCookie?: () => string[] }
  ).getSetCookie?.() ?? [impersonation.headers.get('set-cookie') ?? ''];
  const cookie = cookieHeaders
    .map((value) => value.split(';', 1)[0])
    .filter(Boolean)
    .join('; ');
  if (!cookie) throw new Error('owner_impersonation_cookie_missing');

  const verifier = base64Url(randomBytes(48));
  const challenge = base64Url(createHash('sha256').update(verifier).digest());
  const redirectUri = `${liveBaseUrl()}/app/`;
  const state = randomUUID();
  const authorization = new URL(`${keycloakUrl}/realms/jarvis/protocol/openid-connect/auth`);
  authorization.search = new URLSearchParams({
    client_id: 'jarvis-web',
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'openid profile email offline_access',
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  }).toString();
  const callbackResponse = await fetch(authorization, {
    headers: { cookie },
    redirect: 'manual',
  });
  const location = callbackResponse.headers.get('location');
  if (callbackResponse.status !== 302 || !location) {
    throw new Error('owner_impersonation_authorization_failed');
  }
  const callback = new URL(location);
  if (callback.searchParams.get('state') !== state || !callback.searchParams.get('code')) {
    throw new Error('owner_impersonation_callback_invalid');
  }
  return form<LiveOwnerTokens>(`${keycloakUrl}/realms/jarvis/protocol/openid-connect/token`, {
    client_id: 'jarvis-web',
    grant_type: 'authorization_code',
    code: callback.searchParams.get('code')!,
    redirect_uri: redirectUri,
    code_verifier: verifier,
  });
}

export async function logoutLiveOwner(tokens: LiveOwnerTokens): Promise<void> {
  await form(`${keycloakUrl}/realms/jarvis/protocol/openid-connect/logout`, {
    client_id: 'jarvis-web',
    refresh_token: tokens.refresh_token,
  });
}
