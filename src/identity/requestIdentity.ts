import { AsyncLocalStorage } from 'node:async_hooks';

import type { FastifyRequest } from 'fastify';

import type { PermissionKey } from './IdentityRepository';
import type { UserPrincipal } from './IdentityService';

export type ServicePrincipal = {
  kind: 'service';
  serviceId: string;
  permissions: PermissionKey[];
  delegatedUserId?: string;
};
export type RequestPrincipal = UserPrincipal | ServicePrincipal;

const principals = new WeakMap<FastifyRequest, RequestPrincipal>();
type RequestIdentityContext = { principal?: RequestPrincipal; integrationConnectionId?: string };
const requestIdentityContext = new AsyncLocalStorage<RequestIdentityContext>();

export function runWithRequestIdentityContext<T>(callback: () => T): T {
  return requestIdentityContext.run({}, callback);
}

export function setRequestPrincipal(request: FastifyRequest, principal: RequestPrincipal): void {
  principals.set(request, principal);
  const context = requestIdentityContext.getStore();
  if (context) context.principal = principal;
}

export function getRequestPrincipal(request: FastifyRequest): RequestPrincipal | undefined {
  return principals.get(request);
}

/**
 * Returns the authenticated human owner, or the user explicitly delegated to a
 * trusted service, for connected-provider credential lookup. Conversation data
 * ownership remains isolated by `getCurrentDataOwnerScope` below.
 */
export function getCurrentOwnerUserId(): string | null {
  const principal = requestIdentityContext.getStore()?.principal;
  if (principal?.kind === 'user') return principal.userId;
  if (principal?.kind === 'service') return principal.delegatedUserId ?? null;
  return null;
}

export function setCurrentIntegrationConnectionId(connectionId: string | undefined): void {
  const context = requestIdentityContext.getStore();
  if (context) context.integrationConnectionId = connectionId;
}

export function getCurrentIntegrationConnectionId(): string | undefined {
  return requestIdentityContext.getStore()?.integrationConnectionId;
}

export type DataOwnerScope =
  { kind: 'user'; userId: string } | { kind: 'service'; serviceId: string } | { kind: 'legacy' };

export function getCurrentDataOwnerScope(): DataOwnerScope {
  const principal = requestIdentityContext.getStore()?.principal;
  if (principal?.kind === 'user') return { kind: 'user', userId: principal.userId };
  if (principal?.kind === 'service' && principal.serviceId) {
    return { kind: 'service', serviceId: principal.serviceId };
  }
  return { kind: 'legacy' };
}

/**
 * Authorizes a capability at the point where it is executed. An absent
 * principal means authentication is explicitly disabled for a local test or
 * development deployment. Every service credential is scoped.
 */
export function hasRequestPermission(request: FastifyRequest, permission: PermissionKey): boolean {
  const principal = principals.get(request);
  if (!principal) return true;
  if (principal.kind === 'service') return principal.permissions?.includes(permission) === true;
  return principal.status === 'active' && principal.permissions.includes(permission);
}

export function requireUserPrincipal(request: FastifyRequest): UserPrincipal {
  const principal = principals.get(request);
  if (!principal || principal.kind !== 'user') throw new Error('identity_user_principal_required');
  return principal;
}
