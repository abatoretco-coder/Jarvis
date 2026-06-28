import { describe, expect, it } from '@jest/globals';

import { getParisIsoDate } from '../src/time/parisTime';

describe('Paris time helpers', () => {
  it('uses the Paris calendar date after UTC midnight offsets', () => {
    expect(getParisIsoDate(new Date('2026-03-28T23:30:00.000Z'))).toBe('2026-03-29');
  });

  it('keeps previous UTC day when Paris is still same local date', () => {
    expect(getParisIsoDate(new Date('2026-10-25T22:30:00.000Z'))).toBe('2026-10-25');
  });
});
