import type { RequestPrincipal } from '../../identity/requestIdentity';

/** Keeps the initial Live rollout restricted to authenticated owners. */
export function canUseLivePilot(
  principal: RequestPrincipal | undefined,
  ownerOnly: boolean
): boolean {
  if (!ownerOnly) return true;
  return principal?.kind === 'user' && principal.roles.includes('owner');
}
