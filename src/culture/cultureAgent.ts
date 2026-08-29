import { z } from 'zod';

import type { Env } from '../env';
import { completeOllamaChat } from '../ollamaChat';
import type {
  ConversationResultSet,
  ConversationResultSetRepository,
  ResolvedConversationResult,
} from '../resultSets/ConversationResultSetRepository';
import { getParisDateTimeUtc, getParisLocalDateParts, getParisStartOfDayUtc } from '../time/parisTime';
import { AgoraClient } from './AgoraClient';
import {
  type AgoraCandidate,
  agoraCandidateSchema,
  type AgoraItemResponse,
  type AgoraVenuesResponse,
  type CultureAction,
  cultureActionSchema,
  cultureSlotsSchema,
} from './contracts';
import { CulturePersonalizationService } from './CulturePersonalizationService';
import type { CultureProfileRepository } from './CultureProfileRepository';

const PARIS_FORMATTER = new Intl.DateTimeFormat('fr-FR', {
  timeZone: 'Europe/Paris',
  weekday: 'short',
  day: 'numeric',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
});

const PARIS_TIME_FORMATTER = new Intl.DateTimeFormat('fr-FR', {
  timeZone: 'Europe/Paris',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

const cultureResultContextSchema = z.object({
  profileId: z.string().min(1).max(128).optional(),
  latitude: z.number().min(-90).max(90).optional(),
  longitude: z.number().min(-180).max(180).optional(),
  radiusKm: z.number().positive().max(200).optional(),
  from: z.string().datetime({ offset: true }),
  to: z.string().datetime({ offset: true }),
  types: z.array(z.string()).max(10).optional(),
  categories: z.array(z.string()).max(20).optional(),
  tags: z.array(z.string()).max(20).optional(),
  query: z.string().max(200).optional(),
  venueId: z.string().max(128).optional(),
  version: z.string().max(32).optional(),
  format: z.string().max(32).optional(),
  maxPrice: z.number().nonnegative().optional(),
  currency: z.string().regex(/^[A-Za-z]{3}$/u).optional(),
  freeOnly: z.boolean().optional(),
  recommendationMode: z.enum([
    'discover',
    'recommend_for_profile',
    'recommend_similar',
    'recommend_exploration',
  ]).optional(),
}).superRefine((value, context) => {
  if ((value.latitude === undefined) !== (value.longitude === undefined)) {
    context.addIssue({ code: 'custom', path: ['latitude'], message: 'latitude and longitude must be provided together' });
  }
});

const candidateMetadataSchema = z.object({ candidate: agoraCandidateSchema });

function normalize(value: string): string {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/['’_-]+/gu, ' ').toLowerCase();
}

function parisWeekday(date: Date): number {
  const { year, month, day } = getParisLocalDateParts(date);
  return new Date(Date.UTC(year, month - 1, day, 12)).getUTCDay();
}

const WEEKDAYS: Array<{ day: number; pattern: RegExp }> = [
  { day: 1, pattern: /\blundi\b/u },
  { day: 2, pattern: /\bmardi\b/u },
  { day: 3, pattern: /\bmercredi\b/u },
  { day: 4, pattern: /\bjeudi\b/u },
  { day: 5, pattern: /\bvendredi\b/u },
  { day: 6, pattern: /\bsamedi\b/u },
  { day: 0, pattern: /\bdimanche\b/u },
];

export function resolveCultureWindow(text: string, now = new Date()): { from: string; to: string } {
  const value = normalize(text);
  const tomorrow = /\bdemain\b/u.test(value);
  let startOffset = tomorrow ? 1 : 0;
  let dayCount = 1;
  const explicitWeekday = WEEKDAYS.find(({ pattern }) => pattern.test(value));

  if (explicitWeekday) {
    startOffset = (explicitWeekday.day - parisWeekday(now) + 7) % 7;
  } else if (/\bce(?:tte)? week[ -]?end\b/u.test(value)) {
    const weekday = parisWeekday(now);
    startOffset = weekday === 0 ? 0 : (6 - weekday + 7) % 7;
    dayCount = weekday === 0 ? 1 : 2;
  } else if (/\bcette semaine\b/u.test(value)) {
    dayCount = 7;
  }

  const requestedHour = value.match(/\bvers\s+([01]?\d|2[0-3])\s*h(?:([0-5]\d))?\b/u);
  const windowAt = (offset: number): { from: string; to: string } => {
    if (requestedHour) {
      const hour = Number(requestedHour[1]);
      const minute = Number(requestedHour[2] ?? 0);
      const endHour = hour + 2;
      return {
        from: getParisDateTimeUtc(now, offset, Math.max(0, hour - 1), minute).toISOString(),
        to: getParisDateTimeUtc(now, offset + (endHour >= 24 ? 1 : 0), endHour % 24, minute).toISOString(),
      };
    }
    if (/\bsoir\b/u.test(value)) {
      return {
        from: getParisDateTimeUtc(now, offset, 18).toISOString(),
        to: getParisDateTimeUtc(now, offset + 1, 2).toISOString(),
      };
    }
    if (/\bapres midi\b/u.test(value)) {
      return {
        from: getParisDateTimeUtc(now, offset, 12).toISOString(),
        to: getParisDateTimeUtc(now, offset, 18).toISOString(),
      };
    }
    return {
      from: getParisStartOfDayUtc(now, offset).toISOString(),
      to: getParisStartOfDayUtc(now, offset + dayCount).toISOString(),
    };
  };

  let window = windowAt(startOffset);
  if (explicitWeekday && startOffset === 0 && Date.parse(window.to) <= now.getTime()) {
    startOffset += 7;
    window = windowAt(startOffset);
  }
  return window;
}

export function resolveEffectiveCultureWindow(
  requested: { from: string; to: string },
  now = new Date(),
): { from: string; to: string } | null {
  const requestedFromMs = new Date(requested.from).getTime();
  const requestedToMs = new Date(requested.to).getTime();
  const nowMs = now.getTime();
  if (requestedToMs <= nowMs) return null;
  return {
    from: new Date(Math.max(requestedFromMs, nowMs)).toISOString(),
    to: new Date(requestedToMs).toISOString(),
  };
}

function formatPrice(candidate: AgoraCandidate): string {
  if (candidate.occurrence.isFree === true) return 'gratuit';
  const price = candidate.occurrence.price;
  const amount = price?.min ?? price?.max;
  if (amount === null || amount === undefined) return 'prix non communiqué';
  return `${amount} ${price?.currency ?? ''}`.trim();
}

function freshnessWarnings(stale: boolean, partial: boolean): string[] {
  return [
    stale ? 'Les données servies par Agora sont anciennes mais encore dans leur fenêtre autorisée.' : '',
    partial ? 'Certaines sources Agora sont temporairement indisponibles ; la liste peut être incomplète.' : '',
  ].filter(Boolean);
}

function displayCandidates(candidates: AgoraCandidate[], stale: boolean, partial: boolean): string {
  const lines = candidates.length ? candidates.slice(0, 20).map((candidate, index) => {
    const version = typeof candidate.occurrence.attributes.version === 'string'
      ? ` · ${candidate.occurrence.attributes.version}`
      : '';
    return `${index + 1}. ${candidate.item.title} — ${candidate.venue.name}, ${PARIS_FORMATTER.format(new Date(candidate.occurrence.startsAt))}${version} · ${formatPrice(candidate)}`;
  }) : ['Je n’ai trouvé aucune séance ou sortie correspondant à ces critères dans les données Agora.'];
  return [...lines, ...freshnessWarnings(stale, partial)].join('\n');
}

function candidatesForPresentation(action: CultureAction, candidates: AgoraCandidate[], limit: number): AgoraCandidate[] {
  if (action === 'find_occurrences') return candidates.slice(0, limit);
  const seenItems = new Set<string>();
  const uniqueItems: AgoraCandidate[] = [];
  for (const candidate of candidates) {
    if (seenItems.has(candidate.item.id)) continue;
    seenItems.add(candidate.item.id);
    uniqueItems.push(candidate);
    if (uniqueItems.length >= limit) break;
  }
  return uniqueItems;
}

async function synthesize(candidates: unknown[], request: string, env: Env, limit: number): Promise<string> {
  const bounded = candidates.slice(0, Math.min(20, limit));
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), env.OPENAI_TIMEOUT_MS);
  try {
    return await completeOllamaChat({
      baseUrl: env.OLLAMA_BASE_URL,
      model: env.OLLAMA_MODEL?.trim() || 'qwen3:8b',
      temperature: 0.2,
      numPredict: 500,
      signal: controller.signal,
      messages: [
        {
          role: 'system',
          content: 'Tu es Jarvis. Utilise uniquement les candidats JSON fournis. N’invente jamais prix, disponibilité, horaire, synopsis, séance, cinéma ou qualité. Une information absente reste inconnue. Réponds brièvement en français et cite les numéros des candidats.',
        },
        { role: 'user', content: `Demande: ${request}\nCandidats structurés Agora (${bounded.length} maximum):\n${JSON.stringify(bounded)}` },
      ],
    });
  } finally {
    clearTimeout(timeout);
  }
}

function boundedItemDetail(response: AgoraItemResponse): Record<string, unknown> {
  const item = response.data;
  return {
    id: item.id,
    title: item.title,
    summary: item.summary,
    categories: item.categories,
    contributors: item.contributors,
    durationMinutes: item.durationMinutes,
    attributes: item.attributes,
    occurrences: item.occurrences.slice(0, 3),
  };
}

function formatItemDetail(response: AgoraItemResponse): string {
  const item = response.data;
  const summary = item.summary?.trim() || 'Description non communiquée.';
  const occurrences = item.occurrences.slice(0, 5).map((occurrence, index) => (
    `${index + 1}. ${occurrence.venue.name}, ${PARIS_FORMATTER.format(new Date(occurrence.startsAt))}`
  ));
  const detail = `${item.title} — ${summary}${occurrences.length ? `\n${occurrences.join('\n')}` : '\nAucune occurrence future connue.'}`;
  return [detail, ...freshnessWarnings(response.meta.stale, response.meta.partial)].join('\n');
}

function formatSelectedOccurrence(candidate: AgoraCandidate): string {
  const summary = candidate.item.summary?.trim() || 'Description non communiquée.';
  const version = typeof candidate.occurrence.attributes.version === 'string'
    ? ` · ${candidate.occurrence.attributes.version}`
    : '';
  return `${candidate.item.title} — ${summary}\n${candidate.venue.name}, ${PARIS_FORMATTER.format(new Date(candidate.occurrence.startsAt))}${version} · ${formatPrice(candidate)}`;
}

function queryFromResultContext(
  context: Record<string, unknown> | null,
  now = new Date(),
): Record<string, string | number | undefined> | null | undefined {
  const parsed = cultureResultContextSchema.safeParse(context);
  if (!parsed.success) return undefined;
  const window = resolveEffectiveCultureWindow({ from: parsed.data.from, to: parsed.data.to }, now);
  if (!window) return null;
  return {
    lat: parsed.data.latitude,
    lon: parsed.data.longitude,
    radiusKm: parsed.data.radiusKm,
    from: window.from,
    to: window.to,
  };
}

function refreshSelectedCandidate(candidate: AgoraCandidate, response: AgoraItemResponse): AgoraCandidate | null {
  const occurrence = response.data.occurrences.find((entry) => entry.id === candidate.occurrence.id);
  if (!occurrence) return null;
  return {
    ...candidate,
    item: {
      ...candidate.item,
      title: response.data.title,
      summary: response.data.summary,
      categories: response.data.categories,
      contributors: response.data.contributors,
      attributes: response.data.attributes,
    },
    occurrence,
    venue: {
      ...occurrence.venue,
      distanceKm: occurrence.venue.distanceKm ?? candidate.venue.distanceKm,
    },
    source: occurrence.source,
    sources: [occurrence.source],
  };
}

function contributorReferenceLabels(candidate: AgoraCandidate): string[] {
  return (candidate.item.contributors ?? []).flatMap((contributor) => {
    const words = contributor.trim().split(/\s+/u);
    const surname = words.length > 1 ? words.at(-1) : null;
    return surname ? [contributor, surname] : [contributor];
  });
}

function candidateReferenceLabels(candidate: AgoraCandidate, entityType: 'item' | 'occurrence'): string[] {
  const itemLabels = [candidate.item.title, ...contributorReferenceLabels(candidate)];
  if (entityType === 'item') return [...new Set(itemLabels)];
  const startsAt = new Date(candidate.occurrence.startsAt);
  const timeParts = PARIS_TIME_FORMATTER.formatToParts(startsAt);
  const hour = timeParts.find((part) => part.type === 'hour')?.value ?? '';
  const minute = timeParts.find((part) => part.type === 'minute')?.value ?? '';
  const timeLabels = minute === '00'
    ? [`${hour}h`, `${hour}h00`]
    : [`${hour}h${minute}`, `${hour} h ${minute}`];
  const version = typeof candidate.occurrence.attributes.version === 'string'
    ? candidate.occurrence.attributes.version
    : null;
  const format = typeof candidate.occurrence.attributes.format === 'string'
    ? candidate.occurrence.attributes.format
    : null;
  const versionLabels = version === 'VOSTFR' ? [version, 'VO'] : version ? [version] : [];
  return [...new Set([
    ...itemLabels,
    candidate.venue.name,
    ...timeLabels,
    ...versionLabels,
    ...(format ? [format] : []),
  ].filter(Boolean))];
}

function shiftParisLocalDay(value: string, days: number): string {
  const date = new Date(value);
  const parts = PARIS_TIME_FORMATTER.formatToParts(date);
  const hour = Number(parts.find((part) => part.type === 'hour')?.value ?? 0);
  const minute = Number(parts.find((part) => part.type === 'minute')?.value ?? 0);
  return getParisDateTimeUtc(date, days, hour, minute).toISOString();
}

function slotsFromResultContext(context: Record<string, unknown> | null): Record<string, unknown> | null {
  const parsed = cultureResultContextSchema.safeParse(context);
  if (!parsed.success) return null;
  return {
    latitude: parsed.data.latitude,
    longitude: parsed.data.longitude,
    radiusKm: parsed.data.radiusKm,
    from: parsed.data.from,
    to: parsed.data.to,
    types: parsed.data.types,
    categories: parsed.data.categories,
    tags: parsed.data.tags,
    query: parsed.data.query,
    venueId: parsed.data.venueId,
    version: parsed.data.version,
    format: parsed.data.format,
    maxPrice: parsed.data.maxPrice,
    currency: parsed.data.currency,
    freeOnly: parsed.data.freeOnly,
    recommendationMode: parsed.data.recommendationMode,
  };
}

export function inferCultureRefinement(input: {
  text: string;
  activeResultSet: ConversationResultSet | null;
  selectedResult?: ResolvedConversationResult | null;
}): { action: CultureAction; slots: Record<string, unknown> } | null {
  const active = input.activeResultSet;
  if (active?.sourceAgent !== 'culture') return null;
  const slots = slotsFromResultContext(active.context);
  if (!slots) return null;
  const value = normalize(input.text);
  const explicitResolvedSelector = input.selectedResult
    && /\b(?:celui|celle|le film|la seance|ce cinema)\b/u.test(value);
  if (explicitResolvedSelector) return null;
  const selectedOccurrenceHasRequestedFacts = input.selectedResult?.entityType === 'agora.occurrence'
    && /\bc est ou\b|\ba quelle heure\b|\bcombien (?:ca )?coute\b/u.test(value);
  if (selectedOccurrenceHasRequestedFacts) return null;
  let refined = false;

  const version = /\bvostfr\b/u.test(value) ? 'VOSTFR' : /\bvo\b/u.test(value) ? 'VO' : /\bvf\b/u.test(value) ? 'VF' : undefined;
  if (version) {
    slots.version = version;
    refined = true;
  }
  if (/\b(?:seulement\s+)?gratuit(?:e|es|s)?\b/u.test(value)) {
    slots.freeOnly = true;
    refined = true;
  }
  const maxPrice = value.match(/\b(?:moins de|max(?:imum)?|budget)\s+(?:de\s+)?(\d{1,4}(?:[.,]\d{1,2})?)\s*(?:€|euros?)/u);
  if (maxPrice) {
    slots.maxPrice = Number(maxPrice[1]?.replace(',', '.'));
    slots.currency = 'EUR';
    refined = true;
  }
  const radius = value.match(/\b(?:a|à)?\s*moins de\s+(\d{1,3}(?:[.,]\d+)?)\s*km\b/u);
  if (radius) {
    slots.radiusKm = Number(radius[1]?.replace(',', '.'));
    refined = true;
  }

  const selectedCandidate = candidateMetadataSchema.safeParse(input.selectedResult?.metadata);
  const focusNeedsOccurrences = /\bil passe ou\b|\ba quelle heure\b|\bet demain\b|\bapres\s+([01]?\d|2[0-3])\s*h/u.test(value);
  if (focusNeedsOccurrences && selectedCandidate.success) {
    slots.query = selectedCandidate.data.candidate.item.title;
    slots.types = [selectedCandidate.data.candidate.item.type];
    refined = true;
  }
  if (/\bmeme style\b/u.test(value) && selectedCandidate.success) {
    slots.types = [selectedCandidate.data.candidate.item.type];
    slots.tags = selectedCandidate.data.candidate.item.categories.slice(0, 5);
    delete slots.query;
    slots.recommendationMode = 'recommend_similar';
    refined = true;
  }
  if (/\bdemain\b/u.test(value)) {
    slots.from = shiftParisLocalDay(String(slots.from), 1);
    slots.to = shiftParisLocalDay(String(slots.to), 1);
    refined = true;
  }
  const afterHour = value.match(/\bapres\s+([01]?\d|2[0-3])\s*h/u);
  if (afterHour) {
    const contextDate = new Date(String(slots.from));
    slots.from = getParisDateTimeUtc(contextDate, 0, Number(afterHour[1])).toISOString();
    refined = true;
  }
  if (!refined) return null;
  const previousAction = cultureActionSchema.safeParse(active.sourceAction);
  return {
    action: focusNeedsOccurrences ? 'find_occurrences' : previousAction.success ? previousAction.data : 'discover',
    slots,
  };
}

function formatVenues(response: AgoraVenuesResponse): string {
  if (!response.data.length) return 'Je n’ai trouvé aucun lieu culturel correspondant dans ce rayon.';
  const lines = response.data.slice(0, 20).map((venue, index) => {
    const distance = venue.distanceKm === undefined ? '' : ` · ${venue.distanceKm.toFixed(1)} km`;
    return `${index + 1}. ${venue.name} — ${venue.city ?? 'ville non communiquée'}${distance}`;
  });
  return [...lines, ...freshnessWarnings(response.meta.stale, response.meta.partial)].join('\n');
}

function requestedLimit(text: string): number | undefined {
  const value = normalize(text);
  const words: Record<string, number> = { un: 1, deux: 2, trois: 3, quatre: 4, cinq: 5 };
  const match = value.match(/\b(?:les\s+)?(un|deux|trois|quatre|cinq|\d{1,2})\s+(?:meilleurs?|films?|choix|trucs?|sorties?|recommandations?)/u);
  if (!match) return undefined;
  const limit = words[match[1] ?? ''] ?? Number(match[1]);
  return Number.isInteger(limit) ? Math.min(20, Math.max(1, limit)) : undefined;
}

export function inferCultureRequest(text: string): { action: CultureAction; slots: Record<string, unknown> } | null {
  const value = normalize(text);
  if (/\b(?:mets|joue|lance|ecoute)\b.*\b(?:musique|jazz|rock|rap|playlist|spotify)\b/u.test(value)) return null;
  const implicitRecommendation = /\b(?:quelque chose|un truc|pourrait etre)\b.*\b(sympa|leger|interessant)\b/u.test(value)
    || /\bqu est ce qu on pourrait faire\b/u.test(value);
  const personalRecommendation = /\b(?:qu est ce que tu me conseilles|devrai(?:t|ent) me plaire|recommande moi|conseille moi|trouve moi .*qui (?:devrai(?:t|ent)|pourrai(?:t|ent)) me plaire)\b/u.test(value);
  const explorationRecommendation = /\b(?:quelque chose|un truc).*(?:different|nouveau)|\b(?:decouvrir|exploration)\b/u.test(value);
  const similarRecommendation = /\b(?:meme style|similaire|comme (?:celui|celle))\b/u.test(value);
  const implicitFreeOuting = /\b(?:quelque chose|un truc)\b.*\bgratuit(?:e|es|s)?\b/u.test(value);
  const qualitativeMovieRequest = /\bfilms?\b.*\b(sympa|leger|interessant|pas idiot)\b/u.test(value);
  const cultureTerms = /\b(films?|cinemas?|seances?|sorties?|concerts?|jazz|expos?|expositions?|theatre|spectacles?|humour|comedie|festivals?|activites?|que faire|qu est ce qu on (?:fait|peut faire|pourrait faire)|qu est ce qu il y a)\b/u;
  if (!cultureTerms.test(value) && !implicitRecommendation && !implicitFreeOuting && !personalRecommendation && !explorationRecommendation && !similarRecommendation) return null;
  const types = /\b(films?|cinemas?|seances?)\b/u.test(value) ? ['movie']
    : /\bconcerts?|jazz\b/u.test(value) ? ['concert']
      : /\bexpos?|expositions?\b/u.test(value) ? ['exhibition']
        : /\bhumour|comedie\b/u.test(value) ? ['comedy']
          : /\bfestivals?\b/u.test(value) ? ['festival']
            : /\btheatre|spectacles?\b/u.test(value) ? ['theatre']
              : undefined;
  const version = /\bvostfr\b/u.test(value) ? 'VOSTFR' : /\bvo\b/u.test(value) ? 'VO' : /\bvf\b/u.test(value) ? 'VF' : undefined;
  let action: CultureAction = implicitRecommendation || implicitFreeOuting || qualitativeMovieRequest || personalRecommendation || explorationRecommendation || similarRecommendation || /\b(compare|choisir|choisirais|prefere|recommand\w*|conseille|pitch\w*)\b/u.test(value)
    ? 'recommend_candidates'
    : 'discover';
  if (/\bcinemas?\b/u.test(value) && /\b(proche\w*|pres|autour|moins de|rayon)\b/u.test(value)) {
    action = 'find_venues';
  } else if (/\bseances?\b/u.test(value) || /\bou\s+(?:(?:est ce que\s+)?je\s+(?:peux|puis)|puis\s+je)?\s*voir\b/u.test(value)) {
    action = 'find_occurrences';
  }
  const titleMatch = value.match(/\b(?:seances?\s+(?:du film\s+|de\s+|pour\s+)?|ou\s+(?:(?:est ce que\s+)?je\s+(?:peux|puis)|puis\s+je)?\s*voir\s+)(.+?)(?=\s+(?:aujourd hui|demain|ce soir|demain soir|en vo|en vf|en vostfr|pres de|autour)|[?.!,]|$)/u);
  const query = titleMatch?.[1]?.trim();
  const venueQuery = value.match(/\bqu est ce qu il y a (?:au|a la|aux)\s+(.+?)(?=\s+(?:ce soir|demain|ce week|vendredi|samedi|dimanche)|[?.!,]|$)/u)?.[1]?.trim();
  const tags = ['jazz', 'photo', 'art contemporain', 'famille', 'danse', 'plein air'].filter((tag) => value.includes(tag));
  const freeOnly = /\bgratuit(?:e|es|s)?\b/u.test(value) || undefined;
  const priceMatch = value.match(/\b(?:moins de|budget\s+(?:de\s+)?)\s*(\d{1,4}(?:[.,]\d{1,2})?)\s*(?:€|euros?)/u);
  const maxPrice = priceMatch ? Number(priceMatch[1]?.replace(',', '.')) : undefined;
  const radiusMatch = value.match(/\bmoins de\s+(\d{1,3}(?:[.,]\d+)?)\s*km\b/u);
  const radiusKm = radiusMatch ? Number(radiusMatch[1]?.replace(',', '.')) : undefined;
  const limit = requestedLimit(value);
  return {
    action,
    slots: {
      types, version, freeOnly, ...(tags.length ? { tags } : {}),
      ...(query || venueQuery ? { query: query ?? venueQuery } : {}),
      ...(maxPrice !== undefined ? { maxPrice, currency: 'EUR' } : {}),
      ...(radiusKm !== undefined ? { radiusKm } : {}),
      ...(limit ? { limit } : {}),
      recommendationMode: explorationRecommendation
        ? 'recommend_exploration'
        : similarRecommendation
          ? 'recommend_similar'
          : personalRecommendation || action === 'recommend_candidates'
            ? 'recommend_for_profile'
            : 'discover',
    },
  };
}

export function inferCultureComparisonPositions(text: string): number[] | undefined {
  const value = normalize(text);
  const ordinals: Record<string, number> = {
    premier: 1, premiere: 1, deuxieme: 2, second: 2, seconde: 2, troisieme: 3, quatrieme: 4, cinquieme: 5,
  };
  const positions = Object.entries(ordinals)
    .filter(([word]) => new RegExp(`\\b${word}\\b`, 'u').test(value))
    .map(([, position]) => position)
    .filter((position, index, all) => all.indexOf(position) === index);
  return positions.length === 2 ? positions : undefined;
}

function resolveLocation(input: {
  slots: ReturnType<typeof cultureSlotsSchema.parse>;
  clientContext?: Record<string, unknown>;
  env: Env;
}): { lat: number; lon: number; radiusKm: number } | null {
  const location = input.clientContext?.location as Record<string, unknown> | undefined;
  const contextLat = typeof location?.latitude === 'number' ? location.latitude
    : typeof location?.lat === 'number' ? location.lat : undefined;
  const contextLon = typeof location?.longitude === 'number' ? location.longitude
    : typeof location?.lon === 'number' ? location.lon : undefined;
  const explicit = input.slots.latitude !== undefined && input.slots.longitude !== undefined
    ? { lat: input.slots.latitude, lon: input.slots.longitude }
    : null;
  const client = contextLat !== undefined && contextLon !== undefined ? { lat: contextLat, lon: contextLon } : null;
  const configured = input.env.CULTURE_HOME_LATITUDE !== undefined && input.env.CULTURE_HOME_LONGITUDE !== undefined
    ? { lat: input.env.CULTURE_HOME_LATITUDE, lon: input.env.CULTURE_HOME_LONGITUDE }
    : input.env.AGORA_HOME_LAT !== undefined && input.env.AGORA_HOME_LON !== undefined
      ? { lat: input.env.AGORA_HOME_LAT, lon: input.env.AGORA_HOME_LON }
      : null;
  const coordinates = explicit ?? client ?? configured;
  if (!coordinates) return null;
  return {
    ...coordinates,
    radiusKm: input.slots.radiusKm ?? input.env.CULTURE_DEFAULT_RADIUS_KM ?? input.env.AGORA_HOME_RADIUS_KM,
  };
}

export async function executeCulture(input: {
  action: CultureAction;
  slots: unknown;
  text: string;
  threadId: string;
  clientContext?: Record<string, unknown>;
  env: Env;
  resultSets: ConversationResultSetRepository;
  selectedResult?: ResolvedConversationResult | null;
  profiles?: CultureProfileRepository;
  profileId?: string;
  now?: Date;
}): Promise<{
  text: string;
  resultSetId?: string;
  candidates?: Array<{
    position: number;
    entityType: 'agora.item' | 'agora.occurrence';
    entityId: string;
    title: string;
    personalizationScore: number;
    personalizationReasons: string[];
  }>;
}> {
  if (!input.env.AGORA_BASE_URL || !input.env.AGORA_API_TOKEN) throw new Error('agora_not_configured');
  const slots = cultureSlotsSchema.parse(input.slots ?? {});
  const client = new AgoraClient({
    baseUrl: input.env.AGORA_BASE_URL,
    token: input.env.AGORA_API_TOKEN,
    timeoutMs: input.env.AGORA_TIMEOUT_MS,
  });
  const now = input.now ?? new Date();

  if (
    input.selectedResult
    && (input.action === 'compare_candidates' || input.action === 'recommend_candidates')
    && !slots.candidatePositions
  ) {
    const parsed = candidateMetadataSchema.safeParse(input.selectedResult.metadata);
    if (parsed.success) {
      const itemQuery = queryFromResultContext(input.selectedResult.resultSetContext, now);
      if (itemQuery === null) {
        return { text: 'La période de cette liste est terminée. Relance la recherche pour obtenir des sorties encore à venir.' };
      }
      const details = await client.getItem(parsed.data.candidate.item.id, itemQuery);
      const selected = input.selectedResult.entityType === 'agora.occurrence'
        ? refreshSelectedCandidate(parsed.data.candidate, details)
        : null;
      if (input.selectedResult.entityType === 'agora.occurrence' && !selected) {
        return { text: 'Cette séance n’apparaît plus parmi les séances à venir. Relance la recherche pour actualiser la liste.' };
      }
      const facts = selected ?? boundedItemDetail(details);
      const warnings = freshnessWarnings(details.meta.stale, details.meta.partial);
      try {
        return {
          text: [await synthesize([facts], input.text, input.env, 1), ...warnings].join('\n'),
          resultSetId: input.selectedResult.resultSetId,
        };
      } catch {
        const fallback = selected
          ? [formatSelectedOccurrence(selected), ...warnings].join('\n')
          : formatItemDetail(details);
        return {
          text: `${fallback}\nJe n’ai pas pu générer le pitch local.`,
          resultSetId: input.selectedResult.resultSetId,
        };
      }
    }
  }

  if (input.selectedResult?.entityType === 'agora.venue') {
    const response = await client.getVenue(input.selectedResult.entityId);
    const distance = response.data.distanceKm === undefined ? '' : ` · ${response.data.distanceKm.toFixed(1)} km`;
    return {
      text: [
        `${response.data.name} — ${response.data.city ?? 'ville non communiquée'}${distance}`,
        ...freshnessWarnings(response.meta.stale, response.meta.partial),
      ].join('\n'),
      resultSetId: input.selectedResult.resultSetId,
    };
  }

  if (input.action === 'get_item' && input.selectedResult?.entityType === 'agora.occurrence') {
    const parsed = candidateMetadataSchema.safeParse(input.selectedResult.metadata);
    if (parsed.success) {
      const itemQuery = queryFromResultContext(input.selectedResult.resultSetContext, now);
      if (itemQuery === null) {
        return { text: 'La période de cette liste est terminée. Relance la recherche pour obtenir des séances encore à venir.' };
      }
      const details = await client.getItem(parsed.data.candidate.item.id, itemQuery);
      const selected = refreshSelectedCandidate(parsed.data.candidate, details);
      if (!selected) return { text: 'Cette séance n’apparaît plus parmi les séances à venir. Relance la recherche pour actualiser la liste.' };
      return {
        text: [formatSelectedOccurrence(selected), ...freshnessWarnings(details.meta.stale, details.meta.partial)].join('\n'),
        resultSetId: input.selectedResult.resultSetId,
      };
    }
    return { text: 'Je ne peux plus retrouver précisément cette séance. Relance la recherche pour actualiser la liste.' };
  }

  if (input.action === 'get_item' && slots.itemId) {
    const context = input.selectedResult?.resultSetContext ?? null;
    const itemQuery = queryFromResultContext(context, now);
    if (itemQuery === null) {
      return { text: 'La période de cette liste est terminée. Relance la recherche pour obtenir des sorties encore à venir.' };
    }
    return { text: formatItemDetail(await client.getItem(slots.itemId, itemQuery)) };
  }

  if (slots.resultSetId && (input.action === 'compare_candidates' || input.action === 'recommend_candidates')) {
    const active = input.resultSets.findActive(input.threadId);
    if (active?.id === slots.resultSetId) {
      const limit = slots.limit ?? 10;
      const allowedPositions = slots.candidatePositions ? new Set(slots.candidatePositions) : null;
      const itemQuery = queryFromResultContext(active.context, now);
      if (itemQuery === null) {
        return { text: 'La période de cette liste est terminée. Relance la recherche avant de comparer les résultats.' };
      }
      const storedEntries = active.items
        .filter((item) => !allowedPositions || allowedPositions.has(item.position))
        .map((item) => ({ item, parsed: candidateMetadataSchema.safeParse(item.metadata) }))
        .filter((entry) => entry.parsed.success)
        .slice(0, limit);
      if (storedEntries.length) {
        const detailsByItem = new Map<string, Promise<AgoraItemResponse>>();
        const detailFor = (itemId: string) => {
          const existing = detailsByItem.get(itemId);
          if (existing) return existing;
          const pending = client.getItem(itemId, itemQuery);
          detailsByItem.set(itemId, pending);
          return pending;
        };
        const refreshed = await Promise.all(storedEntries.map(async ({ item, parsed }) => {
          if (!parsed.success) return null;
          const details = await detailFor(parsed.data.candidate.item.id);
          const facts = item.entityType === 'agora.occurrence'
            ? refreshSelectedCandidate(parsed.data.candidate, details)
            : boundedItemDetail(details);
          return { facts, meta: details.meta };
        }));
        const usable = refreshed.filter((entry) => entry?.facts);
        if (usable.length) {
          const warnings = freshnessWarnings(
            usable.some((entry) => entry?.meta.stale),
            usable.some((entry) => entry?.meta.partial),
          );
          return {
            text: [await synthesize(usable.map((entry) => entry?.facts), input.text, input.env, limit), ...warnings].join('\n'),
            resultSetId: active.id,
          };
        }
      }
      const ids = [...new Set(active.items
        .filter((item) => item.entityType === 'agora.item')
        .map((item) => item.entityId))].slice(0, limit);
      const details = (await Promise.all(ids.map((id) => client.getItem(id, itemQuery)))).map(boundedItemDetail);
      if (details.length) return { text: await synthesize(details, input.text, input.env, limit), resultSetId: active.id };
    }
  }

  const location = resolveLocation({ slots, clientContext: input.clientContext, env: input.env });
  if (!location) {
    return { text: 'J’ai besoin de ta position ou de coordonnées de domicile configurées pour chercher des sorties autour de toi.' };
  }
  if (input.action === 'find_venues') {
    const venues = await client.findVenues({
      lat: location.lat,
      lon: location.lon,
      radiusKm: location.radiusKm,
      q: slots.query,
      type: slots.types?.includes('movie') ? 'cinema' : undefined,
      limit: slots.limit ?? 20,
    });
    const resultSet = venues.data.length
      ? input.resultSets.create({
          threadId: input.threadId,
          sourceAgent: 'culture',
          sourceAction: input.action,
          ttlMs: input.env.CONVERSATION_RESULT_SET_TTL_MS,
        context: {
          profileId: input.profileId,
            latitude: location.lat,
            longitude: location.lon,
            radiusKm: location.radiusKm,
            from: new Date().toISOString(),
            to: new Date(Date.now() + 86_400_000).toISOString(),
            types: slots.types,
            query: slots.query,
          },
          items: venues.data.map((venue) => ({
            entityType: 'agora.venue',
            entityId: venue.id,
            displayLabel: venue.name,
            metadata: { venue, referenceLabels: [venue.name] },
          })),
        })
      : null;
    return { text: formatVenues(venues), ...(resultSet ? { resultSetId: resultSet.id } : {}) };
  }

  const window = resolveCultureWindow(input.text, now);
  const effectiveWindow = resolveEffectiveCultureWindow({
    from: slots.from ?? window.from,
    to: slots.to ?? window.to,
  }, now);
  if (!effectiveWindow) {
    return { text: 'La fenêtre demandée est déjà passée. Je n’ai aucune séance future à proposer pour cette période.' };
  }
  const { from, to } = effectiveWindow;
  const resultLimit = slots.limit ?? 20;
  const agoraLimit = input.action === 'find_occurrences'
    ? resultLimit
    : input.action === 'recommend_candidates'
      ? 50
      : Math.min(50, resultLimit * 3);
  const result = await client.discover({
    lat: location.lat,
    lon: location.lon,
    radiusKm: location.radiusKm,
    from,
    to,
    types: slots.types?.join(','),
    categories: slots.categories?.join(','),
    tags: slots.tags?.join(','),
    q: slots.query,
    venueId: slots.venueId,
    version: slots.version,
    format: slots.format,
    maxPrice: slots.maxPrice,
    currency: slots.currency,
    freeOnly: slots.freeOnly ? 'true' : undefined,
    limit: agoraLimit,
  });

  const rankedInput = candidatesForPresentation(input.action, result.data, Math.min(50, result.data.length));
  const personalized = input.profiles && input.profileId && input.action !== 'find_occurrences'
    ? new CulturePersonalizationService(input.profiles, input.env.CULTURE_EXPLORATION_RATIO).rank({
        profileId: input.profileId,
        candidates: rankedInput,
        limit: resultLimit,
        mode: slots.recommendationMode ?? (input.action === 'recommend_candidates' ? 'recommend_for_profile' : 'discover'),
        explicitTypes: slots.types,
        explicitCategories: [...(slots.categories ?? []), ...(slots.tags ?? [])],
        nowMs: now.getTime(),
      })
    : rankedInput.slice(0, resultLimit).map((candidate) => ({
        candidate,
        personalizationScore: 0,
        personalizationReasons: [] as string[],
        exploration: false,
      }));
  const presentedCandidates = personalized.map((entry) => entry.candidate);

  const occurrenceIdentity = input.action === 'find_occurrences'
    || presentedCandidates.some((candidate) => candidate.item.type !== 'movie');
  const resultSet = presentedCandidates.length
    ? input.resultSets.create({
        threadId: input.threadId,
        sourceAgent: 'culture',
        sourceAction: input.action,
        ttlMs: input.env.CONVERSATION_RESULT_SET_TTL_MS,
          context: {
            profileId: input.profileId,
          latitude: location.lat,
          longitude: location.lon,
          radiusKm: location.radiusKm,
          from,
          to,
          types: slots.types,
          categories: slots.categories,
          tags: slots.tags,
          query: slots.query,
          venueId: slots.venueId,
          version: slots.version,
          format: slots.format,
          maxPrice: slots.maxPrice,
          currency: slots.currency,
          freeOnly: slots.freeOnly,
          recommendationMode: slots.recommendationMode,
        },
        items: personalized.map(({ candidate, personalizationScore, personalizationReasons }) => ({
          entityType: occurrenceIdentity ? 'agora.occurrence' : 'agora.item',
          entityId: occurrenceIdentity ? candidate.occurrence.id : candidate.item.id,
          displayLabel: `${candidate.item.title} — ${candidate.venue.name}`,
          metadata: {
            candidate,
            personalizationScore,
            personalizationReasons,
            referenceLabels: candidateReferenceLabels(
              candidate,
              occurrenceIdentity ? 'occurrence' : 'item',
            ),
          },
        })),
      })
    : null;
  let text = displayCandidates(presentedCandidates, result.meta.stale, result.meta.partial);
  if ((input.action === 'compare_candidates' || input.action === 'recommend_candidates') && presentedCandidates.length) {
    try {
      text = await synthesize(personalized.map(({ candidate, personalizationScore, personalizationReasons }) => ({
        candidate,
        personalizationScore,
        personalizationReasons,
      })), input.text, input.env, resultLimit);
      const warnings = freshnessWarnings(result.meta.stale, result.meta.partial);
      if (warnings.length) text = `${text}\n${warnings.join('\n')}`;
    } catch {
      text = `${text}\nJe n’ai pas pu générer la comparaison locale, mais les données factuelles ci-dessus restent disponibles.`;
    }
  }
  return {
    text,
    ...(resultSet ? { resultSetId: resultSet.id } : {}),
    candidates: personalized.map(({ candidate, personalizationScore, personalizationReasons }, index) => ({
      position: index + 1,
      entityType: occurrenceIdentity ? 'agora.occurrence' : 'agora.item',
      entityId: occurrenceIdentity ? candidate.occurrence.id : candidate.item.id,
      title: candidate.item.title,
      personalizationScore,
      personalizationReasons,
    })),
  };
}
