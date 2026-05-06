/*
 * OAuth helper for Jarvis mail/todo integrations.
 *
 * Commands:
 *   tsx scripts/oauth-helper.ts microsoft:url
 *   tsx scripts/oauth-helper.ts microsoft:exchange --code=<AUTH_CODE>
 *   tsx scripts/oauth-helper.ts google:url
 *   tsx scripts/oauth-helper.ts google:exchange --code=<AUTH_CODE>
 *
 * Options (override env):
 *   --client-id=...
 *   --client-secret=...
 *   --tenant=common
 *   --redirect-uri=http://localhost:53682/callback
 *   --scope="scope1 scope2"
 */

type ArgMap = Record<string, string>;

function parseArgs(argv: string[]): { command: string; args: ArgMap } {
  const [, , command = '', ...rest] = argv;
  const args: ArgMap = {};
  for (const raw of rest) {
    const item = raw.trim();
    if (!item.startsWith('--')) continue;
    const [k, ...parts] = item.slice(2).split('=');
    args[k] = parts.join('=').trim();
  }
  return { command, args };
}

function readOpt(args: ArgMap, key: string, fallback?: string): string | undefined {
  const v = args[key]?.trim();
  if (v) return v;
  return fallback?.trim() || undefined;
}

function requireOpt(value: string | undefined, name: string): string {
  if (!value) {
    throw new Error(`missing_required_option:${name}`);
  }
  return value;
}

function printUsage(): void {
  console.log([
    'Usage:',
    '  tsx scripts/oauth-helper.ts microsoft:url [--client-id=...] [--tenant=common] [--redirect-uri=...] [--scope="..."]',
    '  tsx scripts/oauth-helper.ts microsoft:exchange --code=... [--client-id=...] [--client-secret=...] [--tenant=common] [--redirect-uri=...]',
    '  tsx scripts/oauth-helper.ts google:url [--client-id=...] [--redirect-uri=...] [--scope="..."]',
    '  tsx scripts/oauth-helper.ts google:exchange --code=... [--client-id=...] [--client-secret=...] [--redirect-uri=...]',
  ].join('\n'));
}

async function postForm(url: string, body: URLSearchParams): Promise<Record<string, unknown>> {
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });
  const text = await resp.text();
  let data: Record<string, unknown> = {};
  try {
    data = JSON.parse(text) as Record<string, unknown>;
  } catch {
    data = { raw: text };
  }
  if (!resp.ok) {
    throw new Error(`oauth_http_${resp.status}:${JSON.stringify(data)}`);
  }
  return data;
}

function toStringValue(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

function printTokenResult(provider: 'microsoft' | 'google', payload: Record<string, unknown>): void {
  const refreshToken = toStringValue(payload.refresh_token);
  const accessToken = toStringValue(payload.access_token);
  const expiresIn = payload.expires_in;

  console.log(`provider=${provider}`);
  if (refreshToken) console.log(`refresh_token=${refreshToken}`);
  if (accessToken) console.log(`access_token=${accessToken}`);
  if (typeof expiresIn === 'number' || typeof expiresIn === 'string') {
    console.log(`expires_in=${String(expiresIn)}`);
  }
  if (!refreshToken) {
    console.log('warning=no_refresh_token_returned');
    console.log('hint=for_google_use_access_type=offline_and_prompt=consent');
  }
}

function buildMicrosoftAuthUrl(args: ArgMap): string {
  const clientId = requireOpt(readOpt(args, 'client-id', process.env.MICROSOFT_CLIENT_ID), 'client-id');
  const tenant = readOpt(args, 'tenant', process.env.MICROSOFT_TENANT_ID) ?? 'common';
  const redirectUri = requireOpt(readOpt(args, 'redirect-uri', process.env.OAUTH_REDIRECT_URI), 'redirect-uri');
  const scope = readOpt(args, 'scope') ?? 'Tasks.ReadWrite Mail.ReadWrite Mail.Send offline_access';

  const params = new URLSearchParams({
    client_id: clientId,
    response_type: 'code',
    redirect_uri: redirectUri,
    response_mode: 'query',
    scope,
  });
  return `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/authorize?${params.toString()}`;
}

async function exchangeMicrosoftCode(args: ArgMap): Promise<void> {
  const code = requireOpt(readOpt(args, 'code'), 'code');
  const clientId = requireOpt(readOpt(args, 'client-id', process.env.MICROSOFT_CLIENT_ID), 'client-id');
  const clientSecret = requireOpt(readOpt(args, 'client-secret', process.env.MICROSOFT_CLIENT_SECRET), 'client-secret');
  const tenant = readOpt(args, 'tenant', process.env.MICROSOFT_TENANT_ID) ?? 'common';
  const redirectUri = requireOpt(readOpt(args, 'redirect-uri', process.env.OAUTH_REDIRECT_URI), 'redirect-uri');

  const payload = await postForm(
    `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`,
    new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
      scope: 'Tasks.ReadWrite Mail.ReadWrite Mail.Send offline_access',
    }),
  );
  printTokenResult('microsoft', payload);
}

function buildGoogleAuthUrl(args: ArgMap): string {
  const clientId = requireOpt(readOpt(args, 'client-id', process.env.GOOGLE_CLIENT_ID), 'client-id');
  const redirectUri = requireOpt(readOpt(args, 'redirect-uri', process.env.OAUTH_REDIRECT_URI), 'redirect-uri');
  const scope = readOpt(args, 'scope') ?? 'https://mail.google.com/';

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope,
    access_type: 'offline',
    prompt: 'consent',
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

async function exchangeGoogleCode(args: ArgMap): Promise<void> {
  const code = requireOpt(readOpt(args, 'code'), 'code');
  const clientId = requireOpt(readOpt(args, 'client-id', process.env.GOOGLE_CLIENT_ID), 'client-id');
  const clientSecret = requireOpt(readOpt(args, 'client-secret', process.env.GOOGLE_CLIENT_SECRET), 'client-secret');
  const redirectUri = requireOpt(readOpt(args, 'redirect-uri', process.env.OAUTH_REDIRECT_URI), 'redirect-uri');

  const payload = await postForm(
    'https://oauth2.googleapis.com/token',
    new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    }),
  );
  printTokenResult('google', payload);
}

async function main(): Promise<void> {
  const { command, args } = parseArgs(process.argv);

  if (!command || command === 'help' || command === '--help' || command === '-h') {
    printUsage();
    return;
  }

  if (command === 'microsoft:url') {
    console.log(buildMicrosoftAuthUrl(args));
    return;
  }
  if (command === 'microsoft:exchange') {
    await exchangeMicrosoftCode(args);
    return;
  }
  if (command === 'google:url') {
    console.log(buildGoogleAuthUrl(args));
    return;
  }
  if (command === 'google:exchange') {
    await exchangeGoogleCode(args);
    return;
  }

  throw new Error(`unknown_command:${command}`);
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(msg);
  process.exitCode = 1;
});
