import type { FastifyInstance } from 'fastify';

import type { Env } from '../env';
import { isAuthorizedApiKey } from './apiKeyAuth';

function isProtectedV1Route(url?: string): boolean {
  if (!url) return false;
  return url === '/v1' || url.startsWith('/v1/');
}

function isOAuthRoute(url?: string): boolean {
  if (!url) return false;
  return url === '/v1/oauth/google/callback' || url.startsWith('/v1/oauth/google/callback?');
}

function isIngestRoute(url?: string): boolean {
  if (!url) return false;
  return url === '/v1/ingest' || url.startsWith('/v1/ingest?');
}

function normalizeIp(value: string | undefined): string {
  if (!value) return '';
  const trimmed = value.trim();
  if (trimmed.startsWith('::ffff:')) return trimmed.replace('::ffff:', '');
  if (trimmed === '::1') return '127.0.0.1';
  return trimmed;
}

function readClientIp(req: { ip: string }): string {
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
        const clientIp = readClientIp(req);
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
    if (env.OAUTH_SETUP_ENABLED && req.url.startsWith('/v1/oauth/')) return;
    // OAuth endpoints are public (used for oneshot credential setup)
    if (isOAuthRoute(req.url)) return;

    if (!isAuthorizedApiKey(req, env)) {
      return reply.code(401).send({ error: 'unauthorized', message: 'Missing or invalid X-API-Key' });
    }
  });
}
