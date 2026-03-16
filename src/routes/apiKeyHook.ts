import type { FastifyInstance } from 'fastify';

import type { Env } from '../env';

function isProtectedV1Route(url?: string): boolean {
  if (!url) return false;
  return url === '/v1' || url.startsWith('/v1/');
}

function isIngestRoute(url?: string): boolean {
  if (!url) return false;
  return url === '/v1/ingest' || url.startsWith('/v1/ingest?');
}

function normalizeHeaderValue(value: string | string[] | undefined): string | undefined {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  if (Array.isArray(value) && value.length > 0) {
    const first = value[0]?.trim();
    return first && first.length > 0 ? first : undefined;
  }
  return undefined;
}

function parseAuthorizationBearer(authorizationHeader: string | undefined): string | undefined {
  if (!authorizationHeader) return undefined;
  const match = authorizationHeader.match(/^Bearer\s+(.+)$/i);
  if (!match) return undefined;
  const token = match[1]?.trim();
  return token && token.length > 0 ? token : undefined;
}

function allowedApiKeys(env: Env): Set<string> {
  const values = [
    env.API_KEY,
    ...(env.API_KEYS
      ? env.API_KEYS
          .split(',')
          .map((item) => item.trim())
          .filter((item) => item.length > 0)
      : []),
  ].filter((item): item is string => Boolean(item && item.trim().length > 0));

  return new Set(values);
}

function normalizeIp(value: string | undefined): string {
  if (!value) return '';
  const trimmed = value.trim();
  if (trimmed.startsWith('::ffff:')) return trimmed.replace('::ffff:', '');
  if (trimmed === '::1') return '127.0.0.1';
  return trimmed;
}

function readClientIp(req: { ip: string; headers: Record<string, string | string[] | undefined> }): string {
  const xff = normalizeHeaderValue(req.headers['x-forwarded-for']);
  if (xff) {
    const first = xff.split(',')[0]?.trim();
    if (first) return normalizeIp(first);
  }
  return normalizeIp(req.ip);
}

function allowedIngressIps(env: Env): Set<string> {
  if (!env.INGEST_ALLOWLIST_IPS) return new Set();
  return new Set(
    env.INGEST_ALLOWLIST_IPS
      .split(',')
      .map((item) => normalizeIp(item))
      .filter((item) => item.length > 0)
  );
}

export function registerApiKeyHook(app: FastifyInstance, env: Env): void {
  app.addHook('preHandler', async (req, reply) => {
    if (isIngestRoute(req.url)) {
      const allowlist = allowedIngressIps(env);
      if (allowlist.size > 0) {
        const clientIp = readClientIp(req as unknown as { ip: string; headers: Record<string, string | string[] | undefined> });
        if (!allowlist.has(clientIp)) {
          return reply.code(403).send({
            error: 'forbidden_ip',
            message: 'Client IP is not in INGEST_ALLOWLIST_IPS',
          });
        }
      }
    }

    if (!env.REQUIRE_API_KEY) return;
    if (!isProtectedV1Route(req.url)) return;

    const allowed = allowedApiKeys(env);
    const providedApiKey = normalizeHeaderValue(req.headers['x-api-key']);
    const providedBearer = parseAuthorizationBearer(normalizeHeaderValue(req.headers.authorization));

    const isAuthorized = Boolean(
      (providedApiKey && allowed.has(providedApiKey))
      || (providedBearer && allowed.has(providedBearer))
    );

    if (!isAuthorized) {
      return reply.code(401).send({ error: 'unauthorized', message: 'Missing or invalid X-API-Key' });
    }
  });
}
