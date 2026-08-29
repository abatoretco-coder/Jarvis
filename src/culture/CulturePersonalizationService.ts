import type { AgoraCandidate } from './contracts';
import {
  type CultureFeedback,
  type CulturePreferenceProfile,
  CultureProfileRepository,
} from './CultureProfileRepository';

export type CultureRecommendationMode =
  | 'discover'
  | 'recommend_for_profile'
  | 'recommend_similar'
  | 'recommend_exploration';

export type PersonalizedCultureCandidate = {
  candidate: AgoraCandidate;
  personalizationScore: number;
  personalizationReasons: string[];
  exploration: boolean;
};

type CandidateFacts = {
  type: string;
  categories: string[];
  venueId: string;
  weekday: string;
  daypart: string;
  price: number | null;
  isFree: boolean;
  distanceKm: number;
  indoorOutdoor: string | null;
};

const EXPLICIT_SIGNALS = new Set(['explicit_like', 'explicit_dislike']);
const IMPLICIT_HALF_LIFE_MS = 60 * 86_400_000;

function normalized(value: string): string {
  return value.trim().toLowerCase();
}

function candidateFacts(candidate: AgoraCandidate): CandidateFacts {
  const startsAt = new Date(candidate.occurrence.startsAt);
  const hour = Number(new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Paris', hour: '2-digit', hour12: false,
  }).format(startsAt));
  const weekday = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Europe/Paris', weekday: 'short',
  }).format(startsAt).toLowerCase();
  const indoorOutdoor = typeof candidate.item.attributes.indoorOutdoor === 'string'
    ? normalized(candidate.item.attributes.indoorOutdoor)
    : candidate.item.categories.map(normalized).includes('plein air') ? 'outdoor' : null;
  return {
    type: normalized(candidate.item.type),
    categories: candidate.item.categories.map(normalized),
    venueId: normalized(candidate.venue.id),
    weekday,
    daypart: hour < 12 ? 'morning' : hour < 18 ? 'afternoon' : hour < 22 ? 'evening' : 'night',
    price: candidate.occurrence.price?.min ?? candidate.occurrence.price?.max ?? null,
    isFree: candidate.occurrence.isFree === true,
    distanceKm: candidate.venue.distanceKm,
    indoorOutdoor,
  };
}

function feedbackDecay(feedback: CultureFeedback, nowMs: number): number {
  if (EXPLICIT_SIGNALS.has(feedback.signal)) return 1;
  const age = Math.max(0, nowMs - feedback.createdAtMs);
  return Math.pow(0.5, age / IMPLICIT_HALF_LIFE_MS);
}

function metadataString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? normalized(value) : null;
}

function metadataStrings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string').map(normalized)
    : [];
}

function hasProfileSignal(profile: CulturePreferenceProfile, feedback: CultureFeedback[]): boolean {
  return feedback.length > 0
    || profile.explicitExclusions.length > 0
    || [profile.typeWeights, profile.tagWeights, profile.venueWeights, profile.daypartWeights, profile.weekdayWeights]
      .some((weights) => Object.keys(weights).length > 0)
    || [profile.priceAffinity, profile.distanceAffinity, profile.freeAffinity, profile.indoorOutdoorAffinity]
      .some((weight) => weight !== 0);
}

function addReason(reasons: string[], reason: string): void {
  if (!reasons.includes(reason)) reasons.push(reason);
}

function scoreCandidate(input: {
  candidate: AgoraCandidate;
  index: number;
  profile: CulturePreferenceProfile;
  feedback: CultureFeedback[];
  explicitTypes: Set<string>;
  explicitCategories: Set<string>;
  nowMs: number;
  seenCategories: Set<string>;
}): PersonalizedCultureCandidate {
  const { candidate, profile } = input;
  const facts = candidateFacts(candidate);
  const reasons = ['agora_base'];
  let score = 100 - input.index * 1.5;

  const typeWeight = profile.typeWeights[facts.type] ?? 0;
  score += typeWeight * 3;
  if (typeWeight > 0) addReason(reasons, `matches_preference:${facts.type}`);

  for (const category of facts.categories) {
    const weight = profile.tagWeights[category] ?? 0;
    score += weight * 2;
    if (weight > 0) addReason(reasons, `matches_preference:${category}`);
  }

  const venueWeight = profile.venueWeights[facts.venueId] ?? 0;
  score += venueWeight;
  if (venueWeight > 0) addReason(reasons, 'matches_preference:venue');

  score += (profile.daypartWeights[facts.daypart] ?? 0) * 1.2;
  score += (profile.weekdayWeights[facts.weekday] ?? 0) * 0.8;
  if (facts.isFree && profile.freeAffinity > 0) {
    score += profile.freeAffinity * 2;
    addReason(reasons, 'preferred_price');
  } else if (facts.price !== null && profile.priceAffinity > 0) {
    score += profile.priceAffinity * Math.max(0, 1 - facts.price / 60);
    addReason(reasons, 'preferred_price');
  }
  if (profile.distanceAffinity > 0) {
    score += profile.distanceAffinity * Math.max(0, 1 - facts.distanceKm / 30);
    addReason(reasons, 'preferred_distance');
  }
  const preferredMaxPrice = input.feedback.find((entry) => (
    typeof entry.metadata.preferredMaxPrice === 'number'
  ))?.metadata.preferredMaxPrice;
  if (typeof preferredMaxPrice === 'number' && facts.price !== null) {
    if (facts.price <= preferredMaxPrice) {
      score += 5;
      addReason(reasons, 'preferred_price');
    } else {
      score -= Math.min(8, (facts.price - preferredMaxPrice) / 5);
    }
  }
  if (facts.indoorOutdoor) {
    const direction = facts.indoorOutdoor === 'outdoor' ? 1 : -1;
    score += profile.indoorOutdoorAffinity * direction;
  }

  const excludedType = profile.explicitExclusions.includes(`type:${facts.type}`);
  const excludedCategory = facts.categories.find((category) => profile.explicitExclusions.includes(`tag:${category}`));
  if (
    (excludedType && !input.explicitTypes.has(facts.type))
    || (excludedCategory && !input.explicitCategories.has(excludedCategory))
  ) {
    score -= 40;
    addReason(reasons, 'explicit_dislike');
  }

  let repeated = false;
  for (const feedback of input.feedback) {
    const decay = feedbackDecay(feedback, input.nowMs);
    const feedbackType = metadataString(feedback.metadata.type);
    const feedbackVenue = metadataString(feedback.metadata.venueId);
    const feedbackCategories = metadataStrings(feedback.metadata.categories);
    const feedbackDaypart = metadataString(feedback.metadata.daypart);
    const feedbackDistance = typeof feedback.metadata.distanceKm === 'number' ? feedback.metadata.distanceKm : null;
    const feedbackFree = typeof feedback.metadata.isFree === 'boolean' ? feedback.metadata.isFree : null;
    const exact = feedback.entityId === candidate.item.id || feedback.entityId === candidate.occurrence.id;
    let similarity = exact ? 1 : 0;
    if (feedbackType === facts.type) similarity += 0.2;
    if (feedbackVenue === facts.venueId) similarity += 0.1;
    if (feedbackDaypart === facts.daypart) similarity += 0.08;
    if (feedbackDistance !== null && Math.abs(feedbackDistance - facts.distanceKm) <= 3) similarity += 0.05;
    if (feedbackFree !== null && feedbackFree === facts.isFree) similarity += 0.05;
    const categoryMatches = feedbackCategories.filter((category) => facts.categories.includes(category)).length;
    similarity += Math.min(0.4, categoryMatches * 0.15);
    if (similarity === 0) continue;
    const direction = feedback.signal === 'explicit_dislike' || feedback.signal === 'dismiss' ? -1 : 1;
    score += feedback.strength * decay * similarity * direction;
    if (exact && input.nowMs - feedback.createdAtMs < 30 * 86_400_000) repeated = true;
  }
  if (repeated) {
    score -= 4;
    addReason(reasons, 'recently_repeated');
  }

  const newCategory = facts.categories.some((category) => !input.seenCategories.has(category));
  if (newCategory) {
    score += 1.5;
    addReason(reasons, 'new_category');
  }

  return {
    candidate,
    personalizationScore: Math.round(score * 100) / 100,
    personalizationReasons: reasons,
    exploration: newCategory,
  };
}

function diversify(
  ranked: PersonalizedCultureCandidate[],
  limit: number,
  explorationRatio: number,
  mode: CultureRecommendationMode,
): PersonalizedCultureCandidate[] {
  if (mode === 'recommend_exploration') {
    return [...ranked]
      .sort((left, right) => Number(right.exploration) - Number(left.exploration)
        || right.personalizationScore - left.personalizationScore)
      .slice(0, limit)
      .map((entry) => ({
        ...entry,
        personalizationReasons: [...new Set([...entry.personalizationReasons, 'exploration_pick'])],
      }));
  }
  const explorationCount = Math.min(Math.round(limit * explorationRatio), Math.max(0, limit - 1));
  if (explorationCount === 0) return ranked.slice(0, limit);
  const affinity = ranked.filter((entry) => !entry.exploration);
  const exploration = ranked.filter((entry) => entry.exploration);
  if (!exploration.length) return ranked.slice(0, limit);
  const selected = affinity.slice(0, limit - explorationCount);
  for (const entry of exploration) {
    if (selected.some((candidate) => candidate.candidate.occurrence.id === entry.candidate.occurrence.id)) continue;
    selected.push({
      ...entry,
      personalizationReasons: [...new Set([...entry.personalizationReasons, 'exploration_pick'])],
    });
    if (selected.length >= limit) break;
  }
  for (const entry of ranked) {
    if (selected.length >= limit) break;
    if (!selected.some((candidate) => candidate.candidate.occurrence.id === entry.candidate.occurrence.id)) selected.push(entry);
  }
  return selected;
}

export class CulturePersonalizationService {
  constructor(
    private readonly profiles: CultureProfileRepository,
    private readonly explorationRatio = 0.25,
  ) {}

  rank(input: {
    profileId: string;
    candidates: AgoraCandidate[];
    limit: number;
    mode?: CultureRecommendationMode;
    explicitTypes?: string[];
    explicitCategories?: string[];
    nowMs?: number;
  }): PersonalizedCultureCandidate[] {
    const profile = this.profiles.getProfile(input.profileId);
    const feedback = this.profiles.listFeedback(input.profileId);
    const limit = Math.max(1, Math.min(20, input.limit));
    if (!hasProfileSignal(profile, feedback)) {
      return input.candidates.slice(0, limit).map((candidate, index) => ({
        candidate,
        personalizationScore: 100 - index * 1.5,
        personalizationReasons: ['agora_base', 'cold_start'],
        exploration: false,
      }));
    }
    const nowMs = input.nowMs ?? Date.now();
    const seenCategories = new Set(feedback.flatMap((entry) => metadataStrings(entry.metadata.categories)));
    const ranked = input.candidates.map((candidate, index) => scoreCandidate({
      candidate,
      index,
      profile,
      feedback,
      explicitTypes: new Set((input.explicitTypes ?? []).map(normalized)),
      explicitCategories: new Set((input.explicitCategories ?? []).map(normalized)),
      nowMs,
      seenCategories,
    })).sort((left, right) => right.personalizationScore - left.personalizationScore
      || left.candidate.occurrence.id.localeCompare(right.candidate.occurrence.id));
    return diversify(ranked, limit, this.explorationRatio, input.mode ?? 'recommend_for_profile');
  }
}
