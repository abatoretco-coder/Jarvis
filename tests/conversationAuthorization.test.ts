import { describe, expect, test } from '@jest/globals';
import type { FastifyRequest } from 'fastify';

import { permissionForCapabilityAgent, permissionForRouteKey } from '../src/identity/conversationAuthorization';
import { hasRequestPermission, setRequestPrincipal } from '../src/identity/requestIdentity';

describe('conversation capability authorization', () => {
  test.each([
    ['calendar.list_events', 'calendar'],
    ['mail.list_unread', 'mail'],
    ['todo.list', 'todo'],
    ['spotify.pause', 'music'],
    ['executor.turn_on', 'home'],
    ['nas.health', 'nas.operations'],
    ['search.web', 'chat'],
    ['culture.discover', 'chat'],
  ] as const)('maps route %s to %s', (routeKey, permission) => {
    expect(permissionForRouteKey(routeKey)).toBe(permission);
  });

  test.each([
    ['calendar', 'calendar'],
    ['mail', 'mail'],
    ['todo', 'todo'],
    ['spotify', 'music'],
    ['executors', 'home'],
    ['nas', 'nas.operations'],
    ['search.news', 'chat'],
  ] as const)('maps capability agent %s to %s', (agent, permission) => {
    expect(permissionForCapabilityAgent(agent)).toBe(permission);
  });

  test('allows only declared permissions for scoped service principals', () => {
    const request = {} as FastifyRequest;
    setRequestPrincipal(request, { kind: 'service', serviceId: 'music-client', permissions: ['music'] });
    expect(hasRequestPermission(request, 'music')).toBe(true);
    expect(hasRequestPermission(request, 'mail')).toBe(false);
    expect(hasRequestPermission(request, 'home')).toBe(false);
  });

  test('keeps auth-disabled and legacy unscoped deployments compatible', () => {
    const unauthenticatedRequest = {} as FastifyRequest;
    expect(hasRequestPermission(unauthenticatedRequest, 'admin')).toBe(true);

    const legacyRequest = {} as FastifyRequest;
    setRequestPrincipal(legacyRequest, { kind: 'service', serviceId: 'legacy' });
    expect(hasRequestPermission(legacyRequest, 'admin')).toBe(true);
  });

  test('requires an active user and the selected permission', () => {
    const active = {} as FastifyRequest;
    setRequestPrincipal(active, {
      kind: 'user', userId: 'user-1', email: 'user@example.test', displayName: 'User',
      status: 'active', roles: ['resident'], permissions: ['chat', 'calendar'], sessionId: 'session-1',
    });
    expect(hasRequestPermission(active, 'calendar')).toBe(true);
    expect(hasRequestPermission(active, 'admin')).toBe(false);

    const suspended = {} as FastifyRequest;
    setRequestPrincipal(suspended, {
      kind: 'user', userId: 'user-2', email: 'suspended@example.test', displayName: 'Suspended',
      status: 'suspended', roles: ['resident'], permissions: ['calendar'], sessionId: 'session-2',
    });
    expect(hasRequestPermission(suspended, 'calendar')).toBe(false);
  });
});
