import type { Env } from '../env';
import { completeOllamaChat } from '../ollamaChat';
import type { ConversationResultSetRepository } from '../resultSets/ConversationResultSetRepository';
import { getParisDateTimeUtc, getParisLocalDateParts, getParisStartOfDayUtc } from '../time/parisTime';
import { AgoraClient } from './AgoraClient';
import {
  type AgoraCandidate,
  type AgoraItemResponse,
  type AgoraVenuesResponse,
  type CultureAction,
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
  const contextualRecommendation = /\b(?:pitch\w*|compare|recommand\w*)\b/u.test(value);
  if (!/\b(films?|cinemas?|seances?|sorties?)\b/u.test(value) && !implicitMovieRecommendation && !contextualRecommendation) return null;
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
  now?: Date;
}): Promise<{ text: string; resultSetId?: string }> {
  if (!input.env.AGORA_BASE_URL || !input.env.AGORA_API_TOKEN) throw new Error('agora_not_configured');
  const slots = cultureSlotsSchema.parse(input.slots ?? {});
  const client = new AgoraClient({
    baseUrl: input.env.AGORA_BASE_URL,
    token: input.env.AGORA_API_TOKEN,
    timeoutMs: input.env.AGORA_TIMEOUT_MS,
  });

  if (input.action === 'get_item' && slots.itemId) {
    return { text: formatItemDetail(await client.getItem(slots.itemId)) };
  }

  if (slots.resultSetId && (input.action === 'compare_candidates' || input.action === 'recommend_candidates')) {
    const active = input.resultSets.findActive(input.threadId);
    if (active?.id === slots.resultSetId) {
      const limit = slots.limit ?? 10;
      const ids = [...new Set(active.items.filter((item) => item.entityType === 'agora.item').map((item) => item.entityId))].slice(0, limit);
      const details = (await Promise.all(ids.map((id) => client.getItem(id)))).map(boundedItemDetail);
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
    return { text: formatVenues(venues) };
  }

  const window = resolveCultureWindow(input.text, input.now);
  const result = await client.discover({
    lat: location.lat,
    lon: location.lon,
    radiusKm: location.radiusKm,
    from: slots.from ?? window.from,
    to: slots.to ?? window.to,
    types: slots.types?.join(','),
    categories: slots.categories?.join(','),
    q: slots.query,
    venueId: slots.venueId,
    version: slots.version,
    format: slots.format,
    maxPrice: slots.maxPrice,
    currency: slots.currency,
    limit: slots.limit ?? 20,
  });

  const resultSet = result.data.length
    ? input.resultSets.create({
        threadId: input.threadId,
        sourceAgent: 'culture',
        sourceAction: input.action,
        items: result.data.slice(0, 20).map((candidate) => ({
          entityType: 'agora.item',
          entityId: candidate.item.id,
          displayLabel: `${candidate.item.title} — ${candidate.venue.name}`,
        })),
      })
    : null;
  let text = displayCandidates(result.data, result.meta.stale, result.meta.partial);
  if ((input.action === 'compare_candidates' || input.action === 'recommend_candidates') && result.data.length) {
    try {
      text = await synthesize(result.data, input.text, input.env, slots.limit ?? 20);
    } catch {
      text = `${text}\nJe n’ai pas pu générer la comparaison locale, mais les données factuelles ci-dessus restent disponibles.`;
    }
  }
  return { text, ...(resultSet ? { resultSetId: resultSet.id } : {}) };
}
