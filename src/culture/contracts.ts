import { z } from 'zod';

export const cultureActionSchema = z.enum([
  'discover',
  'find_occurrences',
  'get_item',
  'find_venues',
  'compare_candidates',
  'recommend_candidates',
]);
export type CultureAction = z.infer<typeof cultureActionSchema>;

export const cultureSlotsSchema = z.object({
  query: z.string().max(200).optional(),
  itemId: z.string().max(128).optional(),
  venueId: z.string().max(128).optional(),
  types: z.array(z.string()).max(10).optional(),
  categories: z.array(z.string()).max(20).optional(),
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
  timeOfDay: z.string().max(50).optional(),
  latitude: z.number().min(-90).max(90).optional(),
  longitude: z.number().min(-180).max(180).optional(),
  radiusKm: z.number().positive().max(200).optional(),
  version: z.string().max(32).optional(),
  format: z.string().max(32).optional(),
  maxPrice: z.number().nonnegative().optional(),
  currency: z.string().length(3).optional(),
  limit: z.number().int().min(1).max(20).optional(),
  candidatePosition: z.number().int().positive().optional(),
  resultSetId: z.string().max(128).optional(),
}).passthrough().superRefine((value, context) => {
  if ((value.latitude === undefined) !== (value.longitude === undefined)) {
    context.addIssue({
      code: 'custom',
      path: [value.latitude === undefined ? 'latitude' : 'longitude'],
      message: 'latitude and longitude must be provided together',
    });
  }
});

const sourceSchema = z.object({
  provider: z.string().min(1),
  externalId: z.string().min(1),
  sourceUrl: z.string().url().nullable(),
  fetchedAt: z.string().datetime({ offset: true }),
  sourceModifiedAt: z.string().datetime({ offset: true }).nullable(),
  freshness: z.enum(['fresh', 'stale', 'expired']),
  sourceType: z.enum(['official', 'open_data', 'ticketing', 'aggregator']),
});

const itemSchema = z.object({
  id: z.string().min(1).max(128),
  type: z.enum(['movie', 'theatre', 'concert', 'exhibition', 'comedy', 'festival', 'other']),
  title: z.string().min(1),
  originalTitle: z.string().nullable().optional(),
  summary: z.string().nullable(),
  description: z.string().nullable().optional(),
  categories: z.array(z.string()),
  contributors: z.array(z.string()).optional(),
  durationMinutes: z.number().int().positive().nullable().optional(),
  imageUrl: z.string().url().nullable().optional(),
  imageCredit: z.string().nullable().optional(),
  attributes: z.record(z.string(), z.unknown()),
});

const occurrenceCoreSchema = z.object({
  id: z.string().min(1).max(128),
  itemId: z.string().min(1).max(128).optional(),
  venueId: z.string().min(1).max(128).optional(),
  startsAt: z.string().datetime({ offset: true }),
  endsAt: z.string().datetime({ offset: true }).nullable(),
  timezone: z.string().optional(),
  status: z.enum(['scheduled', 'cancelled', 'postponed', 'sold_out', 'unknown']),
  price: z.object({
    min: z.number().nonnegative().nullable(),
    max: z.number().nonnegative().nullable(),
    currency: z.string().nullable(),
  }).nullable(),
  isFree: z.boolean().nullable(),
  bookingUrl: z.string().url().nullable(),
  attributes: z.record(z.string(), z.unknown()),
});

const venueSummarySchema = z.object({
  id: z.string().min(1).max(128),
  name: z.string().min(1),
  latitude: z.number().optional(),
  longitude: z.number().optional(),
  distanceKm: z.number().nonnegative().optional(),
});

export const agoraCandidateSchema = z.object({
  item: itemSchema,
  occurrence: occurrenceCoreSchema,
  venue: venueSummarySchema.extend({ distanceKm: z.number().nonnegative() }),
  source: sourceSchema,
  rankReasons: z.array(z.string()),
});
export type AgoraCandidate = z.infer<typeof agoraCandidateSchema>;

const providerMetaSchema = z.object({
  source: z.string().min(1),
  status: z.enum(['fresh', 'stale', 'expired', 'unavailable']),
  lastSuccessAt: z.string().datetime({ offset: true }).nullable(),
});

export const agoraDiscoverResponseSchema = z.object({
  data: z.array(agoraCandidateSchema),
  meta: z.object({
    generatedAt: z.string().datetime({ offset: true }),
    stale: z.boolean(),
    partial: z.boolean(),
    nextCursor: z.string().nullable(),
    providers: z.array(providerMetaSchema),
  }),
});
export type AgoraDiscoverResponse = z.infer<typeof agoraDiscoverResponseSchema>;

const detailedVenueSchema = venueSummarySchema.extend({
  type: z.string(),
  address: z.string().nullable(),
  city: z.string().nullable(),
  postalCode: z.string().nullable(),
  country: z.string(),
  timezone: z.string(),
  websiteUrl: z.string().url().nullable(),
  attributes: z.record(z.string(), z.unknown()),
  source: sourceSchema,
});

const detailedOccurrenceSchema = occurrenceCoreSchema.extend({
  itemId: z.string().min(1).max(128),
  venueId: z.string().min(1).max(128),
  venue: venueSummarySchema,
  source: sourceSchema,
});

export const agoraItemResponseSchema = z.object({
  data: itemSchema.extend({ source: sourceSchema, occurrences: z.array(detailedOccurrenceSchema) }),
});
export type AgoraItemResponse = z.infer<typeof agoraItemResponseSchema>;

export const agoraVenuesResponseSchema = z.object({
  data: z.array(detailedVenueSchema),
  meta: z.object({ generatedAt: z.string().datetime({ offset: true }) }),
});
export type AgoraVenuesResponse = z.infer<typeof agoraVenuesResponseSchema>;
