import { createHash } from 'node:crypto';

import type { AgoraCandidate } from './contracts';
import { CulturePersonalizationService, type PersonalizedCultureCandidate } from './CulturePersonalizationService';
import { CultureProfileRepository } from './CultureProfileRepository';

export type CultureProactiveEvaluation = {
  shouldNotify: boolean;
  reason: string;
  candidates: Array<PersonalizedCultureCandidate & {
    fingerprint: string;
    entityType: 'agora.occurrence';
    entityId: string;
  }>;
};

function fingerprint(candidate: AgoraCandidate): string {
  return createHash('sha256')
    .update(`${candidate.item.id}\n${candidate.occurrence.id}\n${candidate.occurrence.startsAt}`)
    .digest('hex');
}

export class CultureProactiveRecommendationService {
  constructor(
    private readonly profiles: CultureProfileRepository,
    private readonly personalization: CulturePersonalizationService,
  ) {}

  evaluate(input: {
    profileId: string;
    candidates: AgoraCandidate[];
    runtimeEnabled: boolean;
    responseStale: boolean;
    threshold: number;
    cooldownMs: number;
    nowMs?: number;
  }): CultureProactiveEvaluation {
    const nowMs = input.nowMs ?? Date.now();
    if (!input.runtimeEnabled) return { shouldNotify: false, reason: 'runtime_disabled', candidates: [] };
    const profile = this.profiles.getProfile(input.profileId);
    if (!profile.proactiveEnabled) return { shouldNotify: false, reason: 'profile_opt_out', candidates: [] };
    if (input.responseStale) return { shouldNotify: false, reason: 'stale_facts', candidates: [] };
    const lastNotificationAt = this.profiles.lastNotificationAt(input.profileId);
    if (lastNotificationAt !== null && nowMs - lastNotificationAt < input.cooldownMs) {
      return { shouldNotify: false, reason: 'cooldown', candidates: [] };
    }

    const fresh = input.candidates.filter((candidate) => candidate.source.freshness === 'fresh');
    const ranked = this.personalization.rank({
      profileId: input.profileId,
      candidates: fresh,
      limit: 5,
      mode: 'recommend_for_profile',
      nowMs,
    });
    const eligible = ranked.filter((entry) => (
      entry.personalizationScore >= input.threshold
      && !entry.personalizationReasons.includes('explicit_dislike')
      && entry.personalizationReasons.some((reason) => (
        reason.startsWith('matches_preference:') || reason === 'preferred_price' || reason === 'preferred_distance'
      ))
      && !this.profiles.wasNotified(input.profileId, fingerprint(entry.candidate))
    ));
    if (!eligible.length) return { shouldNotify: false, reason: 'no_new_candidate_above_threshold', candidates: [] };

    const candidates = eligible.slice(0, 3).map((entry) => ({
      ...entry,
      fingerprint: fingerprint(entry.candidate),
      entityType: 'agora.occurrence' as const,
      entityId: entry.candidate.occurrence.id,
    }));
    const topReasons = candidates[0]!.personalizationReasons.filter((reason) => reason !== 'agora_base').slice(0, 3);
    return {
      shouldNotify: true,
      reason: `new_high_affinity_candidate:${topReasons.join('|') || 'personal_score'}`,
      candidates,
    };
  }
}
