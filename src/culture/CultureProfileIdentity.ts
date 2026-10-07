import type { FastifyRequest } from 'fastify';
import { z } from 'zod';

import { getRequestPrincipal } from '../identity/requestIdentity';

export const trustedCultureUserIdSchema = z.string().trim().min(1).max(128).refine((value) => (
  [...value].every((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code >= 32 && code !== 127;
  })
), 'control characters are not allowed');

/**
 * Resolves the local Culture profile asserted by a trusted client.
 * This is an identity boundary, not user authentication.
 */
export function resolveTrustedCultureProfileId(
  userId: string | undefined,
  defaultProfileId: string,
): string {
  return trustedCultureUserIdSchema.parse(userId?.trim() || defaultProfileId.trim());
}

export function resolveRequestCultureProfileId(
  request: FastifyRequest,
  trustedServiceUserId: string | undefined,
  defaultProfileId: string,
): string {
  const principal = getRequestPrincipal(request);
  if (principal?.kind === 'user') return `user:${principal.userId}`;
  if (principal?.kind === 'service') return `service:${principal.serviceId ?? 'legacy'}`;
  return resolveTrustedCultureProfileId(trustedServiceUserId, defaultProfileId);
}
