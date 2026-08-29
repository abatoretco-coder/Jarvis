import { describe, expect, test } from '@jest/globals';

import type { AgoraCandidate } from '../src/culture/contracts';
import { matchSavedCultureCandidate } from '../src/culture/CultureFavoriteMatcher';
import type { CultureSavedEntity } from '../src/culture/CultureProfileRepository';

function candidate(input: {
  occurrenceId: string;
  externalId: string;
  venueId: string;
  venueName: string;
  startsAt?: string;
}): AgoraCandidate {
  return {
    item: {
      id: `item-${input.occurrenceId}`, type: 'theatre', title: 'Hamlet', summary: null,
      categories: ['classique'], contributors: [], attributes: {},
    },
    occurrence: {
      id: input.occurrenceId, startsAt: input.startsAt ?? '2026-09-06T19:00:00.000Z', endsAt: null,
      status: 'scheduled', price: null, isFree: null, bookingUrl: null, attributes: {},
    },
    venue: { id: input.venueId, name: input.venueName, latitude: 48.86, longitude: 2.34, distanceKm: 2 },
    source: {
      provider: 'openagenda', externalId: input.externalId, sourceUrl: null,
      fetchedAt: '2026-08-29T08:00:00.000Z', sourceModifiedAt: null,
      freshness: 'fresh', sourceType: 'open_data',
    },
    rankReasons: [],
  };
}

function favorite(): CultureSavedEntity {
  return {
    profileId: 'profile', entityType: 'agora.occurrence', entityId: 'old-occurrence',
    sourceRefs: [{ provider: 'openagenda', externalId: 'stable-source' }],
    title: 'Hamlet', categories: ['classique'],
    venue: { id: 'venue-a', name: 'Théâtre A', latitude: 48.86, longitude: 2.34 },
    occurrenceDate: '2026-09-06T19:00:00.000Z', metadata: { type: 'theatre' }, savedAtMs: 1,
  };
}

describe('matchSavedCultureCandidate', () => {
  test('prefers the exact saved occurrence id', () => {
    const exact = candidate({
      occurrenceId: 'old-occurrence', externalId: 'changed-source', venueId: 'venue-b', venueName: 'Théâtre B',
    });
    expect(matchSavedCultureCandidate(favorite(), [exact])).toMatchObject({ basis: 'id', candidate: exact });
  });

  test('recovers a changed Agora id through exact provenance', () => {
    const match = matchSavedCultureCandidate(favorite(), [candidate({
      occurrenceId: 'new-occurrence', externalId: 'stable-source', venueId: 'venue-a', venueName: 'Théâtre A',
    })]);
    expect(match).toMatchObject({ basis: 'provenance', candidate: { occurrence: { id: 'new-occurrence' } } });
  });

  test('does not recover the same title at another venue', () => {
    expect(matchSavedCultureCandidate(favorite(), [candidate({
      occurrenceId: 'other', externalId: 'other-source', venueId: 'venue-b', venueName: 'Théâtre B',
    })])).toBeNull();
  });

  test('recovers with matching title, venue and compatible source', () => {
    const match = matchSavedCultureCandidate(favorite(), [candidate({
      occurrenceId: 'compatible', externalId: 'new-source', venueId: 'venue-a', venueName: 'Théâtre A',
    })]);
    expect(match).toMatchObject({ basis: 'confidence', candidate: { occurrence: { id: 'compatible' } } });
  });

  test('does not choose arbitrarily between equally plausible candidates', () => {
    expect(matchSavedCultureCandidate(favorite(), [
      candidate({ occurrenceId: 'choice-a', externalId: 'new-a', venueId: 'venue-a', venueName: 'Théâtre A' }),
      candidate({ occurrenceId: 'choice-b', externalId: 'new-b', venueId: 'venue-a', venueName: 'Théâtre A' }),
    ])).toBeNull();
  });
});
