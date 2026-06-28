import { timingSafeEqual } from 'node:crypto';

import type { FastifyRequest } from 'fastify';

import type { Env } from '../env';

export function normalizeHeaderValue(value: string | string[] | undefined): string | undefined {
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

export function parseAuthorizationBearer(authorizationHeader: string | undefined): string | undefined {
  if (!authorizationHeader) return undefined;
  const match = authorizationHeader.match(/^Bearer\s+(.+)$/i);
  if (!match) return undefined;
  const token = match[1]?.trim();
  return token && token.length > 0 ? token : undefined;
}

function allowedApiKeys(env: Env): string[] {
  return [
    env.API_KEY,
    ...(env.API_KEYS
      ? env.API_KEYS
          .split(',')
          .map((item) => item.trim())
          .filter((item) => item.length > 0)
      : []),
  ].filter((item): item is string => Boolean(item && item.trim().length > 0));
}

function safeTokenEquals(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

export function isAuthorizedApiKey(req: FastifyRequest, env: Env): boolean {
  const providedApiKey = normalizeHeaderValue(req.headers['x-api-key']);
  const providedBearer = parseAuthorizationBearer(normalizeHeaderValue(req.headers.authorization));
  const provided = [providedApiKey, providedBearer].filter((item): item is string => Boolean(item));
  if (provided.length === 0) return false;

  return allowedApiKeys(env).some((allowed) => provided.some((token) => safeTokenEquals(allowed, token)));
}
