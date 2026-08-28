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
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  radiusKm: z.number().positive().max(200),
  from: z.string().datetime({ offset: true }),
  to: z.string().datetime({ offset: true }),
  types: z.array(z.string()).max(10).optional(),
  categories: z.array(z.string()).max(20).optional(),
  query: z.string().max(200).optional(),
  venueId: z.string().max(128).optional(),
  version: z.string().max(32).optional(),
  format: z.string().max(32).optional(),
  maxPrice: z.number().nonnegative().optional(),
  currency: z.string().length(3).optional(),
});

const candidateMetadataSchema = z.object({ candidate: agoraCandidateSchema });
const venueMetadataSchema = z.object({
  venue: z.object({
    id: z.string(),
    name: z.string(),
    city: z.string().nullable(),
    distanceKm: z.number().optional(),
  }),
});

function normalize(value: string): string {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/['’_-]+/gu, ' ').toLowerCase();
}

function parisWeekday(date: Date): number {
  const { year, month, day } = getParisLocalDateParts(date);
  return new Date(Date.UTC(year, month - 1, day, 12)).getUTCDay();
}

export function resolveCultureWindow(text: string, now = new Date()): { from: string; to: string } {
  const value = normalize(text);
  const tomorrow = /\bdemain\b/u.test(value);
  let startOffset = tomorrow ? 1 : 0;
  let dayCount = 1;

  if (/\bce(?:tte)? week[ -]?end\b/u.test(value)) {
    const weekday = parisWeekday(now);
    startOffset = weekday === 0 ? 0 : (6 - weekday + 7) % 7;
    dayCount = weekday === 0 ? 1 : 2;
  } else if (/\bsamedi\b/u.test(value)) {
    startOffset = (6 - parisWeekday(now) + 7) % 7;
  } else if (/\bcette semaine\b/u.test(value)) {
    dayCount = 7;
  }

  const requestedHour = value.match(/\bvers\s+([01]?\d|2[0-3])\s*h(?:([0-5]\d))?\b/u);
  if (requestedHour) {
    const hour = Number(requestedHour[1]);
    const minute = Number(requestedHour[2] ?? 0);
    return {
      from: getParisDateTimeUtc(now, startOffset, Math.max(0, hour - 1), minute).toISOString(),
      to: getParisDateTimeUtc(now, startOffset, Math.min(23, hour + 2), minute).toISOString(),
    };
  }
  if (/\bsoir\b/u.test(value)) {
    return {
      from: getParisDateTimeUtc(now, startOffset, 18).toISOString(),
      to: getParisDateTimeUtc(now, startOffset + 1, 2).toISOString(),
    };
  }
  if (/\b(apres midi|apres-midi)\b/u.test(value)) {
    return {
      from: getParisDateTimeUtc(now, startOffset, 12).toISOString(),
      to: getParisDateTimeUtc(now, startOffset, 18).toISOString(),
    };
  }
  return {
    from: getParisStartOfDayUtc(now, startOffset).toISOString(),
    to: getParisStartOfDayUtc(now, startOffset + dayCount).toISOString(),
  };
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

function displayCandidates(candidates: AgoraCandidate[], stale: boolean, partial: boolean): string {
  if (!candidates.length) return 'Je n’ai trouvé aucune séance correspondant à ces critères dans les données Agora.';
  const lines = candidates.slice(0, 20).map((candidate, index) => {
    const version = typeof candidate.occurrence.attributes.version === 'string'
      ? candidate.occurrence.attributes.version
      : 'version inconnue';
    return `${index + 1}. ${candidate.item.title} — ${candidate.venue.name}, ${PARIS_FORMATTER.format(new Date(candidate.occurrence.startsAt))} · ${version} · ${formatPrice(candidate)}`;
  });
  const warnings = [
    stale ? 'Les données servies par Agora sont anciennes mais encore dans leur fenêtre autorisée.' : '',
    partial ? 'Certaines sources Agora sont temporairement indisponibles ; la liste peut être incomplète.' : '',
  ].filter(Boolean);
  return [...lines, ...warnings].join('\n');
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
  const summary = item.summary?.trim() || 'Synopsis non communiqué.';
  const occurrences = item.occurrences.slice(0, 5).map((occurrence, index) => (
    `${index + 1}. ${occurrence.venue.name}, ${PARIS_FORMATTER.format(new Date(occurrence.startsAt))}`
  ));
  return `${item.title} — ${summary}${occurrences.length ? `\n${occurrences.join('\n')}` : '\nAucune séance future connue.'}`;
}

function formatSelectedOccurrence(candidate: AgoraCandidate): string {
  const summary = candidate.item.summary?.trim() || 'Synopsis non communiqué.';
  const version = typeof candidate.occurrence.attributes.version === 'string'
    ? candidate.occurrence.attributes.version
    : 'version inconnue';
  return `${candidate.item.title} — ${summary}\n${candidate.venue.name}, ${PARIS_FORMATTER.format(new Date(candidate.occurrence.startsAt))} · ${version} · ${formatPrice(candidate)}`;
}

function queryFromResultContext(
  context: Record<string, unknown> | null,
): Record<string, string | number | undefined> | undefined {
  const parsed = cultureResultContextSchema.safeParse(context);
  if (!parsed.success) return undefined;
  return {
    lat: parsed.data.latitude,
    lon: parsed.data.longitude,
    radiusKm: parsed.data.radiusKm,
    from: parsed.data.from,
    to: parsed.data.to,
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
    query: parsed.data.query,
    venueId: parsed.data.venueId,
    version: parsed.data.version,
    format: parsed.data.format,
    maxPrice: parsed.data.maxPrice,
    currency: parsed.data.currency,
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
  let refined = false;

  const version = /\bvostfr\b/u.test(value) ? 'VOSTFR' : /\bvo\b/u.test(value) ? 'VO' : /\bvf\b/u.test(value) ? 'VF' : undefined;
  if (version) {
    slots.version = version;
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
    slots.types = ['movie'];
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
  if (!response.data.length) return 'Je n’ai trouvé aucun cinéma correspondant dans ce rayon.';
  return response.data.slice(0, 20).map((venue, index) => {
    const distance = venue.distanceKm === undefined ? '' : ` · ${venue.distanceKm.toFixed(1)} km`;
    return `${index + 1}. ${venue.name} — ${venue.city ?? 'ville non communiquée'}${distance}`;
  }).join('\n');
}

function requestedLimit(text: string): number | undefined {
  const value = normalize(text);
  const words: Record<string, number> = { un: 1, deux: 2, trois: 3, quatre: 4, cinq: 5 };
  const match = value.match(/\b(?:les\s+)?(un|deux|trois|quatre|cinq|\d{1,2})\s+(?:meilleurs?|films?|choix)/u);
  if (!match) return undefined;
  const limit = words[match[1] ?? ''] ?? Number(match[1]);
  return Number.isInteger(limit) ? Math.min(20, Math.max(1, limit)) : undefined;
}

export function inferCultureRequest(text: string): { action: CultureAction; slots: Record<string, unknown> } | null {
  const value = normalize(text);
  const implicitMovieRecommendation = /\b(?:quelque chose|pourrait etre)\b.*\b(sympa|leger|interessant)\b.*\b(ce soir|demain|week[ -]?end)\b/u.test(value);
  const qualitativeMovieRequest = /\bfilms?\b.*\b(sympa|leger|interessant|pas idiot)\b/u.test(value);
  if (!/\b(films?|cinemas?|seances?|sorties?)\b/u.test(value) && !implicitMovieRecommendation) return null;
  const types = implicitMovieRecommendation || /\b(films?|cinemas?|seances?)\b/u.test(value) ? ['movie'] : undefined;
  const version = /\bvostfr\b/u.test(value) ? 'VOSTFR' : /\bvo\b/u.test(value) ? 'VO' : /\bvf\b/u.test(value) ? 'VF' : undefined;
  let action: CultureAction = implicitMovieRecommendation || qualitativeMovieRequest || /\b(compare|choisir|choisirais|prefere|recommand\w*|pitch\w*)\b/u.test(value)
    ? 'recommend_candidates'
    : 'discover';
  if (/\bcinemas?\b/u.test(value) && /\b(proche\w*|pres|autour|moins de|rayon)\b/u.test(value)) {
    action = 'find_venues';
  } else if (/\bseances?\b/u.test(value) || /\bou\s+(?:(?:est ce que\s+)?je\s+(?:peux|puis)|puis\s+je)?\s*voir\b/u.test(value)) {
    action = 'find_occurrences';
  }
  const titleMatch = value.match(/\b(?:seances?\s+(?:du film\s+|de\s+|pour\s+)?|ou\s+(?:(?:est ce que\s+)?je\s+(?:peux|puis)|puis\s+je)?\s*voir\s+)(.+?)(?=\s+(?:aujourd hui|demain|ce soir|demain soir|en vo|en vf|en vostfr|pres de|autour)|[?.!,]|$)/u);
  const query = titleMatch?.[1]?.trim();
  const limit = requestedLimit(value);
  return { action, slots: { types, version, ...(query ? { query } : {}), ...(limit ? { limit } : {}) } };
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
  now?: Date;
}): Promise<{ text: string; resultSetId?: string }> {
  if (!input.env.AGORA_BASE_URL || !input.env.AGORA_API_TOKEN) throw new Error('agora_not_configured');
  const slots = cultureSlotsSchema.parse(input.slots ?? {});
  const client = new AgoraClient({
    baseUrl: input.env.AGORA_BASE_URL,
    token: input.env.AGORA_API_TOKEN,
    timeoutMs: input.env.AGORA_TIMEOUT_MS,
  });

  if (
    input.selectedResult
    && (input.action === 'compare_candidates' || input.action === 'recommend_candidates')
  ) {
    const parsed = candidateMetadataSchema.safeParse(input.selectedResult.metadata);
    if (parsed.success) {
      try {
        return {
          text: await synthesize([parsed.data.candidate], input.text, input.env, 1),
          resultSetId: input.selectedResult.resultSetId,
        };
      } catch {
        return {
          text: `${formatSelectedOccurrence(parsed.data.candidate)}\nJe n’ai pas pu générer le pitch local.`,
          resultSetId: input.selectedResult.resultSetId,
        };
      }
    }
  }

  if (input.selectedResult?.entityType === 'agora.venue') {
    const parsed = venueMetadataSchema.safeParse(input.selectedResult.metadata);
    if (parsed.success) {
      const distance = parsed.data.venue.distanceKm === undefined ? '' : ` · ${parsed.data.venue.distanceKm.toFixed(1)} km`;
      return { text: `${parsed.data.venue.name} — ${parsed.data.venue.city ?? 'ville non communiquée'}${distance}` };
    }
  }

  if (input.action === 'get_item' && input.selectedResult?.entityType === 'agora.occurrence') {
    const parsed = candidateMetadataSchema.safeParse(input.selectedResult.metadata);
    if (parsed.success) return { text: formatSelectedOccurrence(parsed.data.candidate) };
    return { text: 'Je ne peux plus retrouver précisément cette séance. Relance la recherche pour actualiser la liste.' };
  }

  if (input.action === 'get_item' && slots.itemId) {
    const context = input.selectedResult?.resultSetContext ?? null;
    return { text: formatItemDetail(await client.getItem(slots.itemId, queryFromResultContext(context))) };
  }

  if (slots.resultSetId && (input.action === 'compare_candidates' || input.action === 'recommend_candidates')) {
    const active = input.resultSets.findActive(input.threadId);
    if (active?.id === slots.resultSetId) {
      const limit = slots.limit ?? 10;
      const storedCandidates = active.items
        .map((item) => candidateMetadataSchema.safeParse(item.metadata))
        .filter((parsed) => parsed.success)
        .map((parsed) => parsed.data.candidate)
        .slice(0, limit);
      if (storedCandidates.length) {
        return { text: await synthesize(storedCandidates, input.text, input.env, limit), resultSetId: active.id };
      }
      const itemQuery = queryFromResultContext(active.context);
      const ids = [...new Set(active.items
        .filter((item) => item.entityType === 'agora.item')
        .map((item) => item.entityId))].slice(0, limit);
      const details = (await Promise.all(ids.map((id) => client.getItem(id, itemQuery)))).map(boundedItemDetail);
      if (details.length) return { text: await synthesize(details, input.text, input.env, limit), resultSetId: active.id };
    }
  }

  const location = resolveLocation({ slots, clientContext: input.clientContext, env: input.env });
  if (!location) {
    return { text: 'J’ai besoin de ta position ou de coordonnées de domicile configurées pour chercher des séances autour de toi.' };
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

  const now = input.now ?? new Date();
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
  const agoraLimit = input.action === 'find_occurrences' ? resultLimit : Math.min(50, resultLimit * 3);
  const result = await client.discover({
    lat: location.lat,
    lon: location.lon,
    radiusKm: location.radiusKm,
    from,
    to,
    types: slots.types?.join(','),
    categories: slots.categories?.join(','),
    q: slots.query,
    venueId: slots.venueId,
    version: slots.version,
    format: slots.format,
    maxPrice: slots.maxPrice,
    currency: slots.currency,
    limit: agoraLimit,
  });

  const presentedCandidates = candidatesForPresentation(input.action, result.data, resultLimit);

  const resultSet = presentedCandidates.length
    ? input.resultSets.create({
        threadId: input.threadId,
        sourceAgent: 'culture',
        sourceAction: input.action,
        ttlMs: input.env.CONVERSATION_RESULT_SET_TTL_MS,
        context: {
          latitude: location.lat,
          longitude: location.lon,
          radiusKm: location.radiusKm,
          from,
          to,
          types: slots.types,
          categories: slots.categories,
          query: slots.query,
          venueId: slots.venueId,
          version: slots.version,
          format: slots.format,
          maxPrice: slots.maxPrice,
          currency: slots.currency,
        },
        items: presentedCandidates.map((candidate) => ({
          entityType: input.action === 'find_occurrences' ? 'agora.occurrence' : 'agora.item',
          entityId: input.action === 'find_occurrences' ? candidate.occurrence.id : candidate.item.id,
          displayLabel: `${candidate.item.title} — ${candidate.venue.name}`,
          metadata: {
            candidate,
            referenceLabels: candidateReferenceLabels(
              candidate,
              input.action === 'find_occurrences' ? 'occurrence' : 'item',
            ),
          },
        })),
      })
    : null;
  let text = displayCandidates(presentedCandidates, result.meta.stale, result.meta.partial);
  if ((input.action === 'compare_candidates' || input.action === 'recommend_candidates') && presentedCandidates.length) {
    try {
      text = await synthesize(presentedCandidates, input.text, input.env, resultLimit);
    } catch {
      text = `${text}\nJe n’ai pas pu générer la comparaison locale, mais les données factuelles ci-dessus restent disponibles.`;
    }
  }
  return { text, ...(resultSet ? { resultSetId: resultSet.id } : {}) };
}
