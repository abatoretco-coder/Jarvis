import { describe, expect, it } from '@jest/globals';

import {
  CAPABILITY_REGISTRY,
  findCapabilityByRouteKey,
  requiresCapabilityConfirmation,
} from '../src/capabilities/capabilityRegistry';
import { SEMANTIC_ROUTES } from '../src/routing/semanticRouteCatalog';

describe('capability registry', () => {
  it('marks calendar create as confirmable write', () => {
    const capability = findCapabilityByRouteKey('calendar.create_event');
    expect(capability?.agent).toBe('calendar');
    expect(capability?.effect).toBe('write');
    expect(capability ? requiresCapabilityConfirmation(capability) : false).toBe(true);
  });

  it('marks calendar delete/update/remove as confirmable mutations', () => {
    const expected = [
      ['calendar.delete_event', 'destructive'],
      ['calendar.update_event', 'write'],
      ['calendar.remove_from_event', 'write'],
    ] as const;

    for (const [routeKey, effect] of expected) {
      const capability = findCapabilityByRouteKey(routeKey);
      expect(capability?.agent).toBe('calendar');
      expect(capability?.effect).toBe(effect);
      expect(capability ? requiresCapabilityConfirmation(capability) : false).toBe(true);
    }
  });

  it('keeps Spotify route keys available without confirmation', () => {
    const capability = findCapabilityByRouteKey('spotify.pause');
    expect(capability?.agent).toBe('spotify');
    expect(capability?.responseDomain).toBe('spotify');
    expect(capability?.requiresConfirmation).toBe(false);
  });

  it('projects every semantic route exactly once into the canonical registry', () => {
    for (const route of SEMANTIC_ROUTES) {
      expect(
        CAPABILITY_REGISTRY.filter((capability) => capability.routeKey === route.key)
      ).toHaveLength(1);
    }
  });

  it('includes mail reads that previously existed only in the semantic catalog', () => {
    expect(findCapabilityByRouteKey('mail.list_inbox')).toMatchObject({
      agent: 'mail',
      action: 'list_inbox',
      effect: 'read',
      requiresConfirmation: false,
    });
  });
});
