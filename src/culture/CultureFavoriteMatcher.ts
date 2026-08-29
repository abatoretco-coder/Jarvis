import type { AgoraCandidate } from './contracts';
import type { CultureSavedEntity } from './CultureProfileRepository';

export type CultureFavoriteMatch = {
  candidate: AgoraCandidate;
  basis: 'id' | 'provenance' | 'confidence';
  score: number;
};

function normalized(value: string): string {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/gu, '').trim().toLowerCase().replace(/\s+/gu, ' ');
}

function sourceKeys(candidate: AgoraCandidate): Set<string> {
  return new Set([candidate.source, ...(candidate.sources ?? [])]
    .map((source) => `${normalized(source.provider)}:${source.externalId.trim()}`));
}

function savedCandidate(entity: CultureSavedEntity): AgoraCandidate | null {
  const value = entity.metadata.candidate;
  return value && typeof value === 'object' ? value as AgoraCandidate : null;
}

function numberField(value: Record<string, unknown> | null, key: string): number | null {
  const field = value?.[key];
  return typeof field === 'number' && Number.isFinite(field) ? field : null;
}

function textField(value: Record<string, unknown> | null, key: string): string | null {
  const field = value?.[key];
  return typeof field === 'string' && field.trim() ? field : null;
}

function distanceKm(left: { latitude: number; longitude: number }, right: { latitude: number; longitude: number }): number {
  const toRadians = (value: number) => value * Math.PI / 180;
  const latitudeDelta = toRadians(right.latitude - left.latitude);
  const longitudeDelta = toRadians(right.longitude - left.longitude);
  const a = Math.sin(latitudeDelta / 2) ** 2
    + Math.cos(toRadians(left.latitude)) * Math.cos(toRadians(right.latitude))
    * Math.sin(longitudeDelta / 2) ** 2;
  return 6_371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function confidence(entity: CultureSavedEntity, candidate: AgoraCandidate): { score: number; venueMatch: boolean } {
  const previous = savedCandidate(entity);
  const savedType = previous?.item.type
    ?? (typeof entity.metadata.type === 'string' ? entity.metadata.type : null);
  const savedVenue = entity.venue;
  let score = 0;
  if (normalized(entity.title) === normalized(candidate.item.title)) score += 35;
  if (savedType && normalized(savedType) === normalized(candidate.item.type)) score += 15;
  const savedCategories = new Set(entity.categories.map(normalized));
  const categoryMatches = candidate.item.categories.map(normalized).filter((category) => savedCategories.has(category)).length;
  score += Math.min(10, categoryMatches * 5);

  const savedVenueId = textField(savedVenue, 'id') ?? previous?.venue.id ?? null;
  const savedVenueName = textField(savedVenue, 'name') ?? previous?.venue.name ?? null;
  const idMatches = Boolean(savedVenueId && normalized(savedVenueId) === normalized(candidate.venue.id));
  const nameMatches = Boolean(savedVenueName && normalized(savedVenueName) === normalized(candidate.venue.name));
  let geoMatches = false;
  const savedLatitude = numberField(savedVenue, 'latitude') ?? previous?.venue.latitude ?? null;
  const savedLongitude = numberField(savedVenue, 'longitude') ?? previous?.venue.longitude ?? null;
  if (savedLatitude !== null && savedLongitude !== null
      && candidate.venue.latitude !== undefined && candidate.venue.longitude !== undefined) {
    const separation = distanceKm(
      { latitude: savedLatitude, longitude: savedLongitude },
      { latitude: candidate.venue.latitude, longitude: candidate.venue.longitude },
    );
    if (separation <= 0.25) {
      score += 25;
      geoMatches = true;
    } else if (separation <= 1) {
      score += 15;
      geoMatches = true;
    }
  }
  if (idMatches) score += 30;
  else if (nameMatches) score += 25;

  const savedProviders = new Set(entity.sourceRefs.map((ref) => normalized(ref.provider)));
  if ([candidate.source, ...(candidate.sources ?? [])].some((source) => savedProviders.has(normalized(source.provider)))) {
    score += 10;
  }
  if (entity.occurrenceDate) {
    const delta = Math.abs(Date.parse(entity.occurrenceDate) - Date.parse(candidate.occurrence.startsAt));
    if (Number.isFinite(delta) && delta <= 6 * 3_600_000) score += 15;
    else if (Number.isFinite(delta) && delta <= 24 * 3_600_000) score += 8;
  }
  const hasNamedVenue = Boolean(savedVenueId || savedVenueName);
  return { score, venueMatch: idMatches || nameMatches || (!hasNamedVenue && geoMatches) };
}

function uniqueBest(
  entries: Array<{ candidate: AgoraCandidate; score: number }>,
  minimumScore: number,
): { candidate: AgoraCandidate; score: number } | null {
  const ranked = [...entries].sort((left, right) => right.score - left.score
    || left.candidate.occurrence.id.localeCompare(right.candidate.occurrence.id));
  const first = ranked[0];
  if (!first || first.score < minimumScore) return null;
  const second = ranked[1];
  return second && first.score - second.score < 10 ? null : first;
}

export function matchSavedCultureCandidate(
  entity: CultureSavedEntity,
  candidates: AgoraCandidate[],
): CultureFavoriteMatch | null {
  const exact = candidates.find((candidate) => (
    entity.entityType === 'agora.item' ? candidate.item.id === entity.entityId
      : entity.entityType === 'agora.venue' ? candidate.venue.id === entity.entityId
        : candidate.occurrence.id === entity.entityId
  ));
  if (exact) return { candidate: exact, basis: 'id', score: Number.POSITIVE_INFINITY };

  const expectedSources = new Set(entity.sourceRefs.map((ref) => `${normalized(ref.provider)}:${ref.externalId.trim()}`));
  const provenanceMatches = candidates.filter((candidate) => (
    [...sourceKeys(candidate)].some((key) => expectedSources.has(key))
  ));
  if (provenanceMatches.length === 1) {
    return { candidate: provenanceMatches[0]!, basis: 'provenance', score: Number.POSITIVE_INFINITY };
  }
  if (provenanceMatches.length > 1) {
    const best = uniqueBest(provenanceMatches.map((candidate) => ({
      candidate,
      score: confidence(entity, candidate).score,
    })), 50);
    return best ? { ...best, basis: 'provenance' } : null;
  }

  const scored = candidates.map((candidate) => ({ candidate, ...confidence(entity, candidate) }))
    .filter((entry) => normalized(entity.title) === normalized(entry.candidate.item.title) && entry.venueMatch);
  const best = uniqueBest(scored, 70);
  return best ? { candidate: best.candidate, basis: 'confidence', score: best.score } : null;
}
