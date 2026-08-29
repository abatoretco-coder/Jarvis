import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { createConversationDb } from '../conversation/repositories/SqliteRepositories';
import { AgoraClient } from '../culture/AgoraClient';
import { CulturePersonalizationService } from '../culture/CulturePersonalizationService';
import { CultureProactiveRecommendationService } from '../culture/CultureProactiveRecommendationService';
import { CultureProfileRepository, resolveCultureProfileId } from '../culture/CultureProfileRepository';
import type { AppDeps } from '../server';

const userIdSchema = z.string().trim().min(1).max(128).refine((value) => [...value].every((character) => {
  const code = character.codePointAt(0) ?? 0;
  return code >= 32 && code !== 127;
}), 'control characters are not allowed');
const profileQuerySchema = z.object({ user_id: userIdSchema.optional() }).strict();

export function registerCultureProfileRoutes(app: FastifyInstance, deps: AppDeps): void {
  const db = createConversationDb(deps.env.CONVERSATION_DB_PATH);
  const profiles = new CultureProfileRepository(db, deps.env.CULTURE_FEEDBACK_RETENTION_DAYS);
  const profileIdFrom = (userId?: string) => resolveCultureProfileId(
    userId,
    deps.env.CULTURE_DEFAULT_PROFILE_ID ?? 'local-default',
  );
  app.addHook('onClose', async () => { db.close(); });

  app.get('/v1/culture/profile', async (req, reply) => {
    const query = profileQuerySchema.safeParse(req.query);
    if (!query.success) return reply.code(400).send({ error: 'invalid_query', issues: query.error.issues });
    return reply.send({ data: profiles.getProfile(profileIdFrom(query.data.user_id)) });
  });

  app.get('/v1/culture/profile/export', async (req, reply) => {
    const query = profileQuerySchema.safeParse(req.query);
    if (!query.success) return reply.code(400).send({ error: 'invalid_query', issues: query.error.issues });
    return reply.send({ data: profiles.exportProfile(profileIdFrom(query.data.user_id)) });
  });

  app.get('/v1/culture/favorites', async (req, reply) => {
    const query = profileQuerySchema.safeParse(req.query);
    if (!query.success) return reply.code(400).send({ error: 'invalid_query', issues: query.error.issues });
    const data = profiles.listSaved(profileIdFrom(query.data.user_id)).map((entity) => ({
      ...entity,
      currentAvailability: 'not_refreshed',
    }));
    return reply.send({ data });
  });

  app.delete('/v1/culture/favorites/:entityType/:entityId', async (req, reply) => {
    const params = z.object({
      entityType: z.string().trim().min(1).max(64),
      entityId: z.string().trim().min(1).max(128),
    }).strict().safeParse(req.params);
    const query = profileQuerySchema.safeParse(req.query);
    if (!params.success || !query.success) return reply.code(400).send({ error: 'invalid_request' });
    const removed = profiles.removeSaved(
      profileIdFrom(query.data.user_id),
      params.data.entityType,
      params.data.entityId,
    );
    return reply.code(removed ? 200 : 404).send({ removed });
  });

  app.put('/v1/culture/profile/proactive', async (req, reply) => {
    const body = z.object({ user_id: userIdSchema.optional(), enabled: z.boolean() }).strict().safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid_body', issues: body.error.issues });
    return reply.send({ data: profiles.setProactiveEnabled(profileIdFrom(body.data.user_id), body.data.enabled) });
  });

  app.delete('/v1/culture/profile/preferences/:kind/:key', async (req, reply) => {
    const params = z.object({
      kind: z.enum(['type', 'tag', 'venue']),
      key: z.string().trim().min(1).max(120),
    }).strict().safeParse(req.params);
    const query = profileQuerySchema.safeParse(req.query);
    if (!params.success || !query.success) return reply.code(400).send({ error: 'invalid_request' });
    const profileId = profileIdFrom(query.data.user_id);
    const profile = profiles.getProfile(profileId);
    const key = params.data.key.toLowerCase();
    profiles.updatePreferences(profileId, {
      typeWeights: params.data.kind === 'type' ? { [key]: -(profile.typeWeights[key] ?? 0) } : undefined,
      tagWeights: params.data.kind === 'tag' ? { [key]: -(profile.tagWeights[key] ?? 0) } : undefined,
      venueWeights: params.data.kind === 'venue' ? { [key]: -(profile.venueWeights[key] ?? 0) } : undefined,
      removeExclusions: [`${params.data.kind}:${key}`],
    });
    profiles.forgetFeedback(profileId, key);
    return reply.send({ removed: true });
  });

  app.post('/v1/culture/profile/reset', async (req, reply) => {
    const body = z.object({ user_id: userIdSchema.optional(), confirm: z.literal(true) }).strict().safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'explicit_confirmation_required' });
    profiles.resetProfile(profileIdFrom(body.data.user_id));
    return reply.send({ reset: true });
  });

  app.post('/v1/culture/proactive/evaluate', async (req, reply) => {
    const body = z.object({
      user_id: userIdSchema.optional(),
      latitude: z.number().min(-90).max(90).optional(),
      longitude: z.number().min(-180).max(180).optional(),
      radiusKm: z.number().positive().max(200).optional(),
      from: z.string().datetime({ offset: true }).optional(),
      to: z.string().datetime({ offset: true }).optional(),
    }).strict().superRefine((value, context) => {
      if ((value.latitude === undefined) !== (value.longitude === undefined)) {
        context.addIssue({ code: 'custom', path: ['latitude'], message: 'latitude and longitude must be provided together' });
      }
    }).safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: 'invalid_body', issues: body.error.issues });
    const profileId = profileIdFrom(body.data.user_id);
    const profile = profiles.getProfile(profileId);
    if (!deps.env.CULTURE_PROACTIVE_ENABLED || !profile.proactiveEnabled) {
      return reply.send({ shouldNotify: false, reason: deps.env.CULTURE_PROACTIVE_ENABLED ? 'profile_opt_out' : 'runtime_disabled', candidates: [] });
    }
    if (!deps.env.AGORA_BASE_URL || !deps.env.AGORA_API_TOKEN) return reply.code(503).send({ error: 'agora_not_configured' });
    const lat = body.data.latitude ?? deps.env.CULTURE_HOME_LATITUDE ?? deps.env.AGORA_HOME_LAT;
    const lon = body.data.longitude ?? deps.env.CULTURE_HOME_LONGITUDE ?? deps.env.AGORA_HOME_LON;
    if (lat === undefined || lon === undefined) return reply.code(422).send({ error: 'culture_location_required' });
    const from = body.data.from ?? new Date().toISOString();
    const to = body.data.to ?? new Date(Date.parse(from) + deps.env.CULTURE_PROACTIVE_LOOKAHEAD_HOURS * 3_600_000).toISOString();
    const agora = new AgoraClient({
      baseUrl: deps.env.AGORA_BASE_URL,
      token: deps.env.AGORA_API_TOKEN,
      timeoutMs: deps.env.AGORA_TIMEOUT_MS,
    });
    try {
      const facts = await agora.discover({
        lat,
        lon,
        radiusKm: body.data.radiusKm ?? deps.env.CULTURE_DEFAULT_RADIUS_KM,
        from,
        to,
        limit: 50,
      });
      const service = new CultureProactiveRecommendationService(
        profiles,
        new CulturePersonalizationService(profiles, deps.env.CULTURE_EXPLORATION_RATIO),
      );
      return reply.send(service.evaluate({
        profileId,
        candidates: facts.data,
        runtimeEnabled: deps.env.CULTURE_PROACTIVE_ENABLED,
        responseStale: facts.meta.stale,
        threshold: deps.env.CULTURE_PROACTIVE_THRESHOLD,
        cooldownMs: deps.env.CULTURE_PROACTIVE_COOLDOWN_MS,
      }));
    } catch (error) {
      app.log.warn({ error, profileId }, 'culture_proactive_agora_failed');
      return reply.code(503).send({ error: 'agora_unavailable' });
    }
  });
}
