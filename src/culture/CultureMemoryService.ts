import { z } from 'zod';

import type { Env } from '../env';
import {
  type ConversationResultSet,
  ConversationResultSetRepository,
  type ResolvedConversationResult,
} from '../resultSets/ConversationResultSetRepository';
import { getParisLocalDateParts, getParisStartOfDayUtc } from '../time/parisTime';
import { AgoraClient } from './AgoraClient';
import { type AgoraCandidate, agoraCandidateSchema } from './contracts';
import {
  type CultureFeedback,
  CultureProfileRepository,
  type CultureSavedEntity,
} from './CultureProfileRepository';

const candidateMetadataSchema = z.object({ candidate: agoraCandidateSchema }).passthrough();
const savedMetadataSchema = z.object({
  savedEntity: z.object({
    profileId: z.string(),
    entityType: z.string(),
    entityId: z.string(),
    title: z.string(),
  }).passthrough(),
  availability: z.enum(['available', 'no_future_occurrence', 'unavailable']),
}).passthrough();

export type CultureMemoryCommand =
  | { type: 'save' }
  | { type: 'remove_saved' }
  | { type: 'list_saved'; period?: 'weekend' }
  | { type: 'inspect_profile' }
  | { type: 'export_profile' }
  | { type: 'reset_profile' }
  | { type: 'forget_preference'; preference: string }
  | { type: 'explain' }
  | { type: 'set_proactive'; enabled: boolean }
  | { type: 'feedback'; signal: 'explicit_like' | 'explicit_dislike' | 'dismiss'; scope: 'candidate' | 'genre' | 'venue' }
  | {
      type: 'preference';
      direction: 1 | -1;
      culturalType?: string;
      tag?: string;
      free?: boolean;
      maxPrice?: number;
      avoid?: boolean;
    };

const TYPE_LABELS: Record<string, string> = {
  movie: 'cinéma', theatre: 'théâtre', concert: 'concerts', exhibition: 'expositions',
  comedy: 'humour', festival: 'festivals', other: 'autres sorties',
};

function normalize(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/gu, '')
    .replace(/['’_-]+/gu, ' ')
    .replace(/[?.!,;:]/gu, ' ')
    .toLowerCase()
    .replace(/\s+/gu, ' ')
    .trim();
}

function typeFromText(value: string): string | undefined {
  if (/\bfilms?|cinema\b/u.test(value)) return 'movie';
  if (/\btheatre\b/u.test(value)) return 'theatre';
  if (/\bconcerts?\b/u.test(value)) return 'concert';
  if (/\bexpos?|expositions?\b/u.test(value)) return 'exhibition';
  if (/\bhumour|comedie\b/u.test(value)) return 'comedy';
  if (/\bfestivals?\b/u.test(value)) return 'festival';
  return undefined;
}

function tagFromText(value: string): string | undefined {
  return ['jazz', 'photo', 'danse', 'famille', 'art contemporain', 'plein air']
    .find((tag) => value.includes(tag));
}

export function inferCultureMemoryCommand(text: string): CultureMemoryCommand | null {
  const value = normalize(text);
  if (/\b(reinitialise|remets a zero|efface)\b.*\b(preferences?|profil|gouts?)\b.*\bculture\b/u.test(value)) {
    return { type: 'reset_profile' };
  }
  if (/\bqu est ce que tu sais de mes gouts|montre(?: moi)? mes preferences(?: culture)?\b/u.test(value)) {
    return { type: 'inspect_profile' };
  }
  if (/\bexporte(?: moi)? (?:mon|mes) (?:profil|preferences) culture\b/u.test(value)) {
    return { type: 'export_profile' };
  }
  if (/\b(?:active|autorise)\b.*\b(?:recommandations?|notifications?)\b.*\bculture/u.test(value)) {
    return { type: 'set_proactive', enabled: true };
  }
  if (/\b(?:desactive|coupe|arrete)\b.*\b(?:recommandations?|notifications?)\b.*\bculture/u.test(value)) {
    return { type: 'set_proactive', enabled: false };
  }
  if (/\b(?:montre|liste|qu est ce que).*(?:favoris|sorties? sauvegardees?|mis(?:e)?s? de cote)\b/u.test(value)) {
    return { type: 'list_saved', period: /\bweek ?end\b/u.test(value) ? 'weekend' : undefined };
  }
  if (/\b(?:garde|sauvegarde|mets? de cote|ajoute aux favoris)\b/u.test(value)) return { type: 'save' };
  if (
    /\b(?:retire|enleve|supprime)\b.*\b(?:favoris|sauvegard|mis de cote)\b/u.test(value)
    || /^(?:supprime|retire|enleve) (?:le |la )?(?:premier|premiere|deuxieme|second|seconde|troisieme|dernier|derniere)$/u.test(value)
  ) return { type: 'remove_saved' };
  if (/\b(?:pourquoi|quelle raison)\b.*\b(?:proposes?|conseilles?|penses?|aime)\b/u.test(value)) return { type: 'explain' };
  const forgotten = value.match(/\boublie (?:que j aime |ma preference pour |le gout pour )?(.+)$/u)?.[1]?.trim();
  if (forgotten) return { type: 'forget_preference', preference: forgotten.slice(0, 100) };

  if (/\b(?:bonne idee|j adore ce genre|j en veux plus comme ca|j aime bien ce genre)\b/u.test(value)) {
    return { type: 'feedback', signal: 'explicit_like', scope: 'genre' };
  }
  if (/\b(?:j aime|j adore|je prefere)\b.*\b(?:ce lieu|cet endroit|ce cinema|cette salle)\b/u.test(value)) {
    return { type: 'feedback', signal: 'explicit_like', scope: 'venue' };
  }
  if (/\b(?:bof|pas celui la)\b/u.test(value)) return { type: 'feedback', signal: 'dismiss', scope: 'candidate' };
  if (/\b(?:pas mon truc)\b/u.test(value)) return { type: 'feedback', signal: 'explicit_dislike', scope: 'candidate' };
  if (/\b(?:evite ce genre)\b/u.test(value)) return { type: 'feedback', signal: 'explicit_dislike', scope: 'genre' };

  const culturalType = typeFromText(value);
  const tag = tagFromText(value);
  const dislike = /\b(?:je n aime pas|j aime pas|evite|pas encore)\b/u.test(value);
  const like = /\b(?:j aime|j adore|je prefere)\b/u.test(value);
  const free = /\b(?:je prefere|j aime).*(?:gratuit|sans payer)\b/u.test(value);
  const maxPriceMatch = value.match(/\b(?:reste|rester|essaie de rester)\b.*\bsous\s+(\d{1,4}(?:[.,]\d{1,2})?)\s*(?:€|euros?)/u);
  const cheap = /\b(?:je prefere|plutot).*(?:pas cher|economique)\b/u.test(value);
  if (dislike && (culturalType || tag)) {
    return { type: 'preference', direction: -1, culturalType, tag, avoid: /\bevite|pas encore\b/u.test(value) };
  }
  if (like && (culturalType || tag || free)) {
    return { type: 'preference', direction: 1, culturalType, tag, free };
  }
  if (maxPriceMatch || cheap) {
    return {
      type: 'preference', direction: 1,
      maxPrice: maxPriceMatch ? Number(maxPriceMatch[1]?.replace(',', '.')) : undefined,
    };
  }
  return null;
}

function sourceRefs(candidate: AgoraCandidate): Array<{ provider: string; externalId: string; sourceUrl?: string | null }> {
  return [...new Map([candidate.source, ...(candidate.sources ?? [])]
    .map((source) => [`${source.provider}:${source.externalId}`, {
      provider: source.provider,
      externalId: source.externalId,
      sourceUrl: source.sourceUrl,
    }])).values()];
}

export function candidateFeedbackMetadata(candidate: AgoraCandidate): Record<string, unknown> {
  const startsAt = new Date(candidate.occurrence.startsAt);
  const hour = Number(new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Paris', hour: '2-digit', hour12: false,
  }).format(startsAt));
  return {
    type: candidate.item.type,
    categories: candidate.item.categories,
    venueId: candidate.venue.id,
    venueName: candidate.venue.name,
    priceMin: candidate.occurrence.price?.min ?? null,
    priceMax: candidate.occurrence.price?.max ?? null,
    isFree: candidate.occurrence.isFree,
    distanceKm: candidate.venue.distanceKm,
    startsAt: candidate.occurrence.startsAt,
    daypart: hour < 12 ? 'morning' : hour < 18 ? 'afternoon' : hour < 22 ? 'evening' : 'night',
  };
}

function selectedCandidate(result: ResolvedConversationResult | null | undefined): AgoraCandidate | null {
  const parsed = candidateMetadataSchema.safeParse(result?.metadata);
  return parsed.success ? parsed.data.candidate : null;
}

function selectedSaved(result: ResolvedConversationResult | null | undefined): z.infer<typeof savedMetadataSchema> | null {
  const parsed = savedMetadataSchema.safeParse(result?.metadata);
  return parsed.success ? parsed.data : null;
}

function currentSelection(
  selected: ResolvedConversationResult | null | undefined,
  active: ConversationResultSet | null,
): ResolvedConversationResult | null {
  if (selected) return selected;
  if (!active || active.focusedPosition === null) return null;
  const item = active.items.find((entry) => entry.position === active.focusedPosition);
  return item ? { ...item, resultSetId: active.id, resultSetContext: active.context } : null;
}

function profileFromContext(result: ResolvedConversationResult | null): string | null {
  return typeof result?.resultSetContext?.profileId === 'string' ? result.resultSetContext.profileId : null;
}

function formatProfile(repository: CultureProfileRepository, profileId: string): string {
  const profile = repository.getProfile(profileId);
  const positiveTypes = Object.entries(profile.typeWeights).filter(([, weight]) => weight > 0)
    .sort((left, right) => right[1] - left[1]).map(([type]) => TYPE_LABELS[type] ?? type);
  const positiveTags = Object.entries(profile.tagWeights).filter(([, weight]) => weight > 0)
    .sort((left, right) => right[1] - left[1]).map(([tag]) => tag);
  const parts = [
    positiveTypes.length ? `types appréciés : ${positiveTypes.join(', ')}` : '',
    positiveTags.length ? `thèmes appréciés : ${positiveTags.join(', ')}` : '',
    profile.freeAffinity > 0 ? 'préférence pour le gratuit' : '',
    profile.explicitExclusions.length ? `à éviter : ${profile.explicitExclusions.join(', ')}` : '',
    `recommandations proactives : ${profile.proactiveEnabled ? 'activées' : 'désactivées'}`,
  ].filter(Boolean);
  return parts.length > 1
    ? `Voici ce que je conserve localement pour Culture : ${parts.join(' ; ')}.`
    : 'Je n’ai pas encore assez de préférences Culture explicites pour décrire tes goûts.';
}

function explanation(result: ResolvedConversationResult | null): string {
  const reasons = Array.isArray(result?.metadata?.personalizationReasons)
    ? result.metadata.personalizationReasons.filter((reason): reason is string => typeof reason === 'string')
    : [];
  const readable = reasons.filter((reason) => reason !== 'agora_base').map((reason) => {
    if (reason.startsWith('matches_preference:')) return `cela correspond à ta préférence « ${reason.split(':')[1]} »`;
    if (reason === 'preferred_distance') return 'la distance correspond à tes habitudes';
    if (reason === 'preferred_price') return 'le prix correspond à tes préférences';
    if (reason === 'new_category') return 'cela apporte une catégorie nouvelle';
    if (reason === 'exploration_pick') return 'c’est le choix d’exploration de la liste';
    if (reason === 'recently_repeated') return 'ce choix a déjà été vu récemment';
    if (reason === 'explicit_dislike') return 'une préférence négative connue le pénalise';
    if (reason === 'cold_start') return 'le profil est encore en démarrage';
    return null;
  }).filter((reason): reason is string => reason !== null);
  return readable.length
    ? `Je le propose parce que ${readable.slice(0, 3).join(', ')}. Le classement de base vient toujours des faits Agora.`
    : 'Je n’ai pas de raison personnelle déterministe pour ce résultat ; il vient du classement factuel Agora.';
}

function applyPreference(
  repository: CultureProfileRepository,
  profileId: string,
  command: Extract<CultureMemoryCommand, { type: 'preference' }>,
): string {
  const magnitude = command.direction * 4;
  const addExclusions = command.direction < 0 && command.avoid
    ? [
        ...(command.culturalType ? [`type:${command.culturalType}`] : []),
        ...(command.tag ? [`tag:${command.tag}`] : []),
      ]
    : [];
  repository.updatePreferences(profileId, {
    typeWeights: command.culturalType ? { [command.culturalType]: magnitude } : undefined,
    tagWeights: command.tag ? { [command.tag]: magnitude } : undefined,
    freeAffinityDelta: command.free ? 4 : undefined,
    priceAffinityDelta: command.maxPrice !== undefined || (!command.culturalType && !command.tag) ? 2 : undefined,
    addExclusions,
  });
  repository.recordFeedback({
    profileId,
    entityType: 'culture.preference',
    entityId: command.tag ?? command.culturalType ?? (command.free ? 'free' : 'price'),
    signal: command.direction > 0 ? 'explicit_like' : 'explicit_dislike',
    strength: 8,
    metadata: {
      type: command.culturalType,
      categories: command.tag ? [command.tag] : [],
      free: command.free,
      preferredMaxPrice: command.maxPrice,
    },
  });
  const subject = command.tag ?? (command.culturalType ? TYPE_LABELS[command.culturalType] ?? command.culturalType : command.free ? 'les sorties gratuites' : 'les sorties peu coûteuses');
  return command.direction > 0
    ? `C’est noté localement : tu apprécies ${subject}.`
    : `C’est noté localement : je pénaliserai ${subject}, sauf si tu le demandes explicitement.`;
}

function recordCandidateFeedback(
  repository: CultureProfileRepository,
  profileId: string,
  result: ResolvedConversationResult,
  signal: CultureFeedback['signal'],
  strength: number,
  scope: 'candidate' | 'genre' | 'venue',
): string {
  const candidate = selectedCandidate(result);
  if (!candidate) return 'Je n’ai pas assez de faits dans le résultat focalisé pour enregistrer ce retour.';
  repository.recordFeedback({
    profileId,
    entityType: result.entityType,
    entityId: result.entityId,
    signal,
    strength,
    metadata: candidateFeedbackMetadata(candidate),
  });
  if (scope === 'genre') {
    const direction = signal === 'explicit_dislike' || signal === 'dismiss' ? -1 : 1;
    repository.updatePreferences(profileId, {
      typeWeights: { [candidate.item.type]: direction * 0.75 },
      tagWeights: Object.fromEntries(candidate.item.categories.slice(0, 5).map((tag) => [tag, direction * 2])),
      venueWeights: { [candidate.venue.id]: direction * 0.2 },
      addExclusions: signal === 'explicit_dislike'
        ? candidate.item.categories.slice(0, 5).map((tag) => `tag:${tag.toLowerCase()}`)
        : undefined,
    });
  } else if (scope === 'venue') {
    repository.updatePreferences(profileId, {
      venueWeights: { [candidate.venue.id]: signal === 'explicit_dislike' ? -3 : 3 },
    });
  }
  return signal === 'dismiss' || signal === 'explicit_dislike'
    ? `C’est noté : je pénaliserai ${scope === 'genre' ? 'ce genre de sortie' : 'ce résultat'}.`
    : `C’est noté : ${scope === 'venue' ? 'ce lieu' : 'ce retour'} influencera les prochaines recommandations sans rendre le classement exclusif.`;
}

export class CultureMemoryService {
  constructor(
    private readonly repository: CultureProfileRepository,
    private readonly resultSets: ConversationResultSetRepository,
    private readonly env: Env,
  ) {}

  recordImplicitSelection(profileId: string, result: ResolvedConversationResult, detailRequest: boolean): void {
    if (profileFromContext(result) && profileFromContext(result) !== profileId) return;
    const candidate = selectedCandidate(result);
    if (!candidate) return;
    this.repository.recordFeedback({
      profileId,
      entityType: result.entityType,
      entityId: result.entityId,
      signal: detailRequest ? 'details' : 'selection',
      strength: detailRequest ? 1.5 : 1,
      metadata: candidateFeedbackMetadata(candidate),
    });
  }

  recordQuery(profileId: string, slots: Record<string, unknown>): void {
    const types = Array.isArray(slots.types) ? slots.types.filter((value): value is string => typeof value === 'string') : [];
    const categories = [
      ...(Array.isArray(slots.categories) ? slots.categories : []),
      ...(Array.isArray(slots.tags) ? slots.tags : []),
    ].filter((value): value is string => typeof value === 'string');
    if (!types.length && !categories.length) return;
    this.repository.recordFeedback({
      profileId,
      entityType: 'culture.query',
      entityId: [...types, ...categories].join(':').slice(0, 256) || 'generic',
      signal: 'query',
      strength: 0.25,
      metadata: { type: types[0], categories },
    });
  }

  async execute(input: {
    command: CultureMemoryCommand;
    profileId: string;
    threadId: string;
    selectedResult?: ResolvedConversationResult | null;
    activeResultSet?: ConversationResultSet | null;
  }): Promise<{ text: string; resultSetId?: string }> {
    const selected = currentSelection(input.selectedResult, input.activeResultSet ?? null);
    if (selected && profileFromContext(selected) && profileFromContext(selected) !== input.profileId) {
      return { text: 'Cette liste appartient à un autre profil local. Relance la recherche avec le profil courant.' };
    }
    switch (input.command.type) {
      case 'inspect_profile': return { text: formatProfile(this.repository, input.profileId) };
      case 'export_profile': return {
        text: 'L’export JSON local est disponible via GET /v1/culture/profile/export avec le même user_id. Je ne recopie pas tout l’historique dans la conversation.',
      };
      case 'set_proactive': {
        this.repository.setProactiveEnabled(input.profileId, input.command.enabled);
        return { text: input.command.enabled
          ? 'Les recommandations Culture proactives sont activées pour ce profil local. Le garde-fou runtime doit aussi être activé.'
          : 'Les recommandations Culture proactives sont désactivées pour ce profil local.' };
      }
      case 'forget_preference': {
        const preference = normalize(input.command.preference);
        const profile = this.repository.getProfile(input.profileId);
        const culturalType = typeFromText(preference);
        const tag = tagFromText(preference) ?? preference;
        this.repository.updatePreferences(input.profileId, {
          typeWeights: culturalType ? { [culturalType]: -(profile.typeWeights[culturalType] ?? 0) } : undefined,
          tagWeights: tag ? { [tag]: -(profile.tagWeights[tag] ?? 0) } : undefined,
          removeExclusions: [
            ...(culturalType ? [`type:${culturalType}`] : []),
            ...(tag ? [`tag:${tag}`] : []),
          ],
        });
        this.repository.forgetFeedback(input.profileId, tag || culturalType || preference);
        return { text: `J’ai oublié localement la préférence « ${input.command.preference} ».` };
      }
      case 'preference': return { text: applyPreference(this.repository, input.profileId, input.command) };
      case 'explain': return { text: explanation(selected) };
      case 'feedback': {
        if (!selected) return { text: 'Je n’ai pas de résultat Culture focalisé auquel associer ce retour.' };
        return { text: recordCandidateFeedback(
          this.repository,
          input.profileId,
          selected,
          input.command.signal,
          input.command.signal === 'dismiss' ? 3 : 8,
          input.command.scope,
        ) };
      }
      case 'save': return this.save(input.profileId, selected);
      case 'remove_saved': return this.removeSaved(input.profileId, selected);
      case 'list_saved': return this.listSaved(input.profileId, input.threadId, input.command.period);
      case 'reset_profile': return { text: 'La réinitialisation complète nécessite une confirmation.' };
    }
  }

  private save(profileId: string, selected: ResolvedConversationResult | null): { text: string } {
    if (!selected) return { text: 'Je n’ai pas de résultat Culture focalisé à sauvegarder.' };
    const candidate = selectedCandidate(selected);
    if (!candidate) return { text: 'Ce résultat ne contient pas assez de provenance factuelle pour être sauvegardé.' };
    this.repository.saveEntity({
      profileId,
      entityType: selected.entityType,
      entityId: selected.entityId,
      sourceRefs: sourceRefs(candidate),
      title: candidate.item.title,
      categories: candidate.item.categories,
      venue: { id: candidate.venue.id, name: candidate.venue.name },
      occurrenceDate: candidate.occurrence.startsAt,
      metadata: { candidate },
    });
    this.repository.recordFeedback({
      profileId,
      entityType: selected.entityType,
      entityId: selected.entityId,
      signal: 'save',
      strength: 4,
      metadata: candidateFeedbackMetadata(candidate),
    });
    return { text: `${candidate.item.title} est sauvegardé localement avec ses références sources.` };
  }

  private removeSaved(profileId: string, selected: ResolvedConversationResult | null): { text: string } {
    if (!selected) return { text: 'Je n’ai pas de favori Culture focalisé à retirer.' };
    const saved = selectedSaved(selected);
    const entityType = saved?.savedEntity.entityType ?? selected.entityType;
    const entityId = saved?.savedEntity.entityId ?? selected.entityId;
    const removed = this.repository.removeSaved(profileId, entityType, entityId);
    return { text: removed ? 'Ce résultat a été retiré des favoris Culture.' : 'Ce résultat n’était pas dans les favoris Culture.' };
  }

  private async listSaved(
    profileId: string,
    threadId: string,
    period?: 'weekend',
  ): Promise<{ text: string; resultSetId?: string }> {
    const saved = this.repository.listSaved(profileId, 20);
    if (!saved.length) return { text: 'Tu n’as aucune sortie sauvegardée dans ce profil local.' };
    const client = this.client();
    const now = new Date();
    let from = now;
    let to = new Date(now.getTime() + 31 * 86_400_000);
    if (period === 'weekend') {
      const parts = getParisLocalDateParts(now);
      const weekday = new Date(Date.UTC(parts.year, parts.month - 1, parts.day, 12)).getUTCDay();
      const saturdayOffset = weekday === 0 ? -1 : (6 - weekday + 7) % 7;
      from = getParisStartOfDayUtc(now, saturdayOffset);
      to = getParisStartOfDayUtc(now, saturdayOffset + 2);
    }
    const refreshed = await Promise.all(saved.map(async (entity) => this.refreshSaved(client, entity, from, to)));
    const visible = period === 'weekend'
      ? refreshed.filter((entry) => entry.availability === 'available')
      : refreshed;
    if (!visible.length) return { text: 'Aucune sortie sauvegardée n’a de date future confirmée pour ce week-end.' };
    const resultSet = this.resultSets.create({
      threadId,
      sourceAgent: 'culture',
      sourceAction: 'list_saved',
      ttlMs: this.env.CONVERSATION_RESULT_SET_TTL_MS,
      context: {
        profileId,
        latitude: this.env.CULTURE_HOME_LATITUDE ?? this.env.AGORA_HOME_LAT,
        longitude: this.env.CULTURE_HOME_LONGITUDE ?? this.env.AGORA_HOME_LON,
        radiusKm: this.env.CULTURE_DEFAULT_RADIUS_KM,
        from: from.toISOString(),
        to: to.toISOString(),
      },
      items: visible.map(({ entity, availability, candidate }) => ({
        entityType: entity.entityType,
        entityId: candidate
          ? entity.entityType === 'agora.item' ? candidate.item.id : candidate.occurrence.id
          : entity.entityId,
        displayLabel: entity.title,
        metadata: {
          savedEntity: entity,
          availability,
          ...(candidate ? { candidate } : {}),
          referenceLabels: [entity.title, entity.venue?.name].filter((value): value is string => typeof value === 'string'),
        },
      })),
    });
    const lines = visible.map(({ entity, availability, nextOccurrence }, index) => {
      const status = availability === 'available' && nextOccurrence
        ? `prochaine occurrence confirmée : ${nextOccurrence}`
        : availability === 'no_future_occurrence'
          ? 'aucune date future connue dans Agora'
          : 'actualité indisponible ; snapshot non présenté comme courant';
      return `${index + 1}. ${entity.title} — ${status}`;
    });
    return { text: lines.join('\n'), resultSetId: resultSet.id };
  }

  private async refreshSaved(
    client: AgoraClient,
    entity: CultureSavedEntity,
    from: Date,
    to: Date,
  ): Promise<{
    entity: CultureSavedEntity;
    availability: 'available' | 'no_future_occurrence' | 'unavailable';
    nextOccurrence?: string;
    candidate?: AgoraCandidate;
  }> {
    try {
      if (entity.entityType === 'agora.item') {
        try {
          const detail = await client.getItem(entity.entityId, {
            from: from.toISOString(),
            to: to.toISOString(),
            lat: this.env.CULTURE_HOME_LATITUDE ?? this.env.AGORA_HOME_LAT,
            lon: this.env.CULTURE_HOME_LONGITUDE ?? this.env.AGORA_HOME_LON,
            radiusKm: this.env.CULTURE_DEFAULT_RADIUS_KM,
          });
          const occurrence = detail.data.occurrences[0];
          return occurrence
            ? { entity, availability: 'available', nextOccurrence: occurrence.startsAt }
            : { entity, availability: 'no_future_occurrence' };
        } catch {
          // The canonical Agora id may change after cross-source deduplication.
          // Continue with the bounded provenance/title lookup below.
        }
      }
      const discovered = await client.discover({
        lat: this.env.CULTURE_HOME_LATITUDE ?? this.env.AGORA_HOME_LAT,
        lon: this.env.CULTURE_HOME_LONGITUDE ?? this.env.AGORA_HOME_LON,
        radiusKm: this.env.CULTURE_DEFAULT_RADIUS_KM,
        from: from.toISOString(),
        to: to.toISOString(),
        q: entity.title,
        limit: 20,
      });
      const sourceKeys = new Set(entity.sourceRefs.map((ref) => `${ref.provider}:${ref.externalId}`));
      const candidate = discovered.data.find((entry) => entry.occurrence.id === entity.entityId)
        ?? discovered.data.find((entry) => sourceKeys.has(`${entry.source.provider}:${entry.source.externalId}`))
        ?? discovered.data.find((entry) => normalize(entry.item.title) === normalize(entity.title));
      return candidate
        ? { entity, availability: 'available', nextOccurrence: candidate.occurrence.startsAt, candidate }
        : { entity, availability: 'no_future_occurrence' };
    } catch {
      return { entity, availability: 'unavailable' };
    }
  }

  private client(): AgoraClient {
    if (!this.env.AGORA_BASE_URL || !this.env.AGORA_API_TOKEN) throw new Error('agora_not_configured');
    return new AgoraClient({
      baseUrl: this.env.AGORA_BASE_URL,
      token: this.env.AGORA_API_TOKEN,
      timeoutMs: this.env.AGORA_TIMEOUT_MS,
    });
  }
}
