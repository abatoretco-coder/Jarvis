import { describe, expect, test } from '@jest/globals';
import type { FastifyRequest } from 'fastify';

import { resolveRequestCultureProfileId } from '../src/culture/CultureProfileIdentity';
import { setRequestPrincipal } from '../src/identity/requestIdentity';

describe('request culture profile identity', () => {
  test('derives human and service profiles from authenticated principals', () => {
    const human = {} as FastifyRequest;
    setRequestPrincipal(human, {
      kind: 'user', userId: 'human-id', email: 'human@example.test', displayName: 'Human', status: 'active',
      roles: ['resident'], permissions: ['chat'], sessionId: 'session',
    });
    expect(resolveRequestCultureProfileId(human, 'spoofed-profile', 'default')).toBe('user:human-id');

    const service = {} as FastifyRequest;
    setRequestPrincipal(service, { kind: 'service', serviceId: 'home-assistant', permissions: ['chat'] });
    expect(resolveRequestCultureProfileId(service, 'user:human-id', 'default')).toBe('service:home-assistant');
  });

  test('preserves the trusted local profile only when authentication is disabled', () => {
    expect(resolveRequestCultureProfileId({} as FastifyRequest, 'local-profile', 'default')).toBe('local-profile');
  });
});
