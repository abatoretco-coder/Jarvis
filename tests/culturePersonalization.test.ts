import { describe, expect, test } from '@jest/globals';

import { createConversationDb } from '../src/conversation/repositories/SqliteRepositories';
import type { AgoraCandidate } from '../src/culture/contracts';
import { CulturePersonalizationService } from '../src/culture/CulturePersonalizationService';
import { CultureProactiveRecommendationService } from '../src/culture/CultureProactiveRecommendationService';
import { CultureProfileRepository } from '../src/culture/CultureProfileRepository';

const source = {
  provider: 'openagenda', externalId: 'source', sourceUrl: null, fetchedAt: '2026-08-29T08:00:00.000Z',
  sourceModifiedAt: null, freshness: 'fresh' as const, sourceType: 'open_data' as const,
};

function candidate(
  id: string,
  type: AgoraCandidate['item']['type'],
  categories: string[],
  options: { distanceKm?: number; price?: number; free?: boolean } = {},
): AgoraCandidate {
  return {
    item: { id: `item-${id}`, type, title: id, summary: id, categories, contributors: [], attributes: {} },
    occurrence: {
      id: `occ-${id}`, startsAt: '2026-08-30T18:00:00.000Z', endsAt: null, status: 'scheduled',
      price: options.price === undefined ? null : { min: options.price, max: options.price + 10, currency: 'EUR' },
      isFree: options.free ?? false, bookingUrl: null, attributes: {},
    },
    venue: { id: `venue-${id}`, name: `Lieu ${id}`, distanceKm: options.distanceKm ?? 5 },
    source,
    rankReasons: ['date_match'],
  };
}

describe('CulturePersonalizationService', () => {
  test('preserves Agora order at cold start', () => {
    const db = createConversationDb(':memory:');
    const profiles = new CultureProfileRepository(db);
    const service = new CulturePersonalizationService(profiles, 0.25);
    const result = service.rank({
      profileId: 'cold',
      candidates: [candidate('Theatre', 'theatre', ['classique']), candidate('Jazz', 'concert', ['jazz'])],
      limit: 2,
    });
    expect(result.map((entry) => entry.candidate.item.title)).toEqual(['Theatre', 'Jazz']);
    expect(result[0]?.personalizationReasons).toContain('cold_start');
    db.close();
  });

  test('uses explicit preferences, preserves exploration and lets explicit type constraints dominate', () => {
    const db = createConversationDb(':memory:');
    const profiles = new CultureProfileRepository(db);
    profiles.updatePreferences('profile', {
      typeWeights: { concert: 5, theatre: -8 },
      tagWeights: { jazz: 5 },
      addExclusions: ['type:theatre'],
    });
    const service = new CulturePersonalizationService(profiles, 0.25);
    const all = [
      candidate('Theatre', 'theatre', ['classique']),
      candidate('Jazz A', 'concert', ['jazz']),
      candidate('Jazz B', 'concert', ['jazz']),
      candidate('Photo', 'exhibition', ['photo']),
    ];
    const personalized = service.rank({ profileId: 'profile', candidates: all, limit: 4 });
    expect(personalized[0]?.candidate.item.title).toBe('Jazz A');
    expect(personalized.some((entry) => entry.personalizationReasons.includes('exploration_pick'))).toBe(true);
    const explicitTheatre = service.rank({
      profileId: 'profile', candidates: [all[0]!], limit: 1, explicitTypes: ['theatre'],
    });
    expect(explicitTheatre).toHaveLength(1);
    expect(explicitTheatre[0]?.personalizationReasons).not.toContain('explicit_dislike');
    profiles.updatePreferences('profile', { addExclusions: ['tag:jazz'] });
    const explicitJazz = service.rank({
      profileId: 'profile', candidates: [all[1]!], limit: 1, explicitCategories: ['jazz'],
    });
    expect(explicitJazz[0]?.personalizationReasons).not.toContain('explicit_dislike');
    db.close();
  });

  test('decays implicit signals while retaining explicit profile weights', () => {
    const db = createConversationDb(':memory:');
    const profiles = new CultureProfileRepository(db);
    profiles.updatePreferences('profile', { tagWeights: { jazz: 4 } });
    profiles.recordFeedback({
      profileId: 'profile', entityType: 'agora.item', entityId: 'item-photo', signal: 'selection', strength: 10,
      createdAtMs: Date.parse('2025-01-01T00:00:00.000Z'), metadata: { categories: ['photo'], type: 'exhibition' },
    });
    const service = new CulturePersonalizationService(profiles, 0);
    const result = service.rank({
      profileId: 'profile',
      candidates: [candidate('Photo', 'exhibition', ['photo']), candidate('Jazz', 'concert', ['jazz'])],
      limit: 2,
      nowMs: Date.parse('2026-08-29T00:00:00.000Z'),
    });
    expect(result[0]?.candidate.item.title).toBe('Jazz');
    db.close();
  });
});

describe('CultureProactiveRecommendationService', () => {
  test('notifies once for a fresh high-affinity candidate, then suppresses the duplicate', () => {
    const db = createConversationDb(':memory:');
    const profiles = new CultureProfileRepository(db);
    profiles.updatePreferences('profile', { tagWeights: { jazz: 8 } });
    profiles.setProactiveEnabled('profile', true);
    const personalization = new CulturePersonalizationService(profiles, 0);
    const service = new CultureProactiveRecommendationService(profiles, personalization);
    const input = {
      profileId: 'profile', candidates: [candidate('Jazz', 'concert', ['jazz'])], runtimeEnabled: true,
      responseStale: false, threshold: 92, cooldownMs: 0, nowMs: Date.parse('2026-08-29T12:00:00.000Z'),
    };
    expect(service.evaluate(input)).toMatchObject({ shouldNotify: true });
    expect(service.evaluate({ ...input, nowMs: input.nowMs + 1 })).toMatchObject({
      shouldNotify: false, reason: 'no_new_candidate_above_threshold',
    });
    db.close();
  });

  test('rejects stale facts and remains opt-in', () => {
    const db = createConversationDb(':memory:');
    const profiles = new CultureProfileRepository(db);
    const service = new CultureProactiveRecommendationService(
      profiles,
      new CulturePersonalizationService(profiles),
    );
    const candidates = [candidate('Jazz', 'concert', ['jazz'])];
    expect(service.evaluate({
      profileId: 'profile', candidates, runtimeEnabled: true, responseStale: false,
      threshold: 0, cooldownMs: 0,
    })).toMatchObject({ shouldNotify: false, reason: 'profile_opt_out' });
    profiles.setProactiveEnabled('profile', true);
    expect(service.evaluate({
      profileId: 'profile', candidates, runtimeEnabled: true, responseStale: true,
      threshold: 0, cooldownMs: 0,
    })).toMatchObject({ shouldNotify: false, reason: 'stale_facts' });
    profiles.recordNotification({
      profileId: 'profile', entityType: 'agora.occurrence', entityId: 'older',
      fingerprint: 'older-fingerprint', reason: 'test', notifiedAtMs: 1_000,
    });
    expect(service.evaluate({
      profileId: 'profile', candidates, runtimeEnabled: true, responseStale: false,
      threshold: 0, cooldownMs: 10_000, nowMs: 5_000,
    })).toMatchObject({ shouldNotify: false, reason: 'cooldown' });
    db.close();
  });

  test('never notifies for an explicitly excluded candidate', () => {
    const db = createConversationDb(':memory:');
    const profiles = new CultureProfileRepository(db);
    profiles.updatePreferences('profile', { typeWeights: { theatre: 8 }, addExclusions: ['type:theatre'] });
    profiles.setProactiveEnabled('profile', true);
    const service = new CultureProactiveRecommendationService(
      profiles,
      new CulturePersonalizationService(profiles, 0),
    );
    expect(service.evaluate({
      profileId: 'profile', candidates: [candidate('Theatre', 'theatre', ['classique'])],
      runtimeEnabled: true, responseStale: false, threshold: 0, cooldownMs: 0,
    })).toMatchObject({ shouldNotify: false, reason: 'no_new_candidate_above_threshold' });
    db.close();
  });
});
