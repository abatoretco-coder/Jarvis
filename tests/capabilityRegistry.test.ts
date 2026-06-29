import { describe, expect, it } from '@jest/globals';

import { findCapabilityByRouteKey, requiresCapabilityConfirmation } from '../src/capabilities/capabilityRegistry';

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
});
