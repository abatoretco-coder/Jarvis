import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';

import { DailyLifeRepository } from '../dailyLife/DailyLifeRepository';
import type { HouseholdAgendaService } from '../dailyLife/HouseholdAgendaService';
import { requireUserPrincipal } from '../identity/requestIdentity';

const listCreateSchema = z.object({
  kind: z.enum(['shopping', 'todo']),
  name: z.string().trim().min(1).max(80),
}).strict();
const listUpdateSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  archived: z.boolean().optional(),
}).strict().refine((value) => Object.keys(value).length > 0);
const itemCreateSchema = z.object({
  title: z.string().trim().min(1).max(180),
  details: z.string().trim().max(1000).optional(),
  quantity: z.string().trim().max(40).nullable().optional(),
  category: z.string().trim().max(60).nullable().optional(),
  dueAtMs: z.number().int().nonnegative().nullable().optional(),
  recurrence: z.enum(['none', 'weekly', 'monthly']).optional(),
  recurrenceUnit: z.enum(['none', 'day', 'week', 'month', 'quarter', 'year']).optional(),
  recurrenceInterval: z.number().int().min(1).max(999).optional(),
  recurrenceAnchorAtMs: z.number().int().nonnegative().nullable().optional(),
  assignedToUserId: z.string().uuid().nullable().optional(),
}).strict();
const itemUpdateSchema = itemCreateSchema.partial().extend({
  expectedVersion: z.number().int().positive(),
  completed: z.boolean().optional(),
}).strict().refine((value) => Object.keys(value).some((key) => key !== 'expectedVersion'));
const itemDeleteSchema = z.object({ expectedVersion: z.coerce.number().int().positive() });
const agendaQuerySchema = z.object({
  timeMin: z.string().datetime({ offset: true }),
  timeMax: z.string().datetime({ offset: true }),
}).refine((value) => {
  const duration = Date.parse(value.timeMax) - Date.parse(value.timeMin);
  return duration > 0 && duration <= 31 * 86_400_000;
});
const agendaSharingSchema = z.object({ enabled: z.boolean() }).strict();

function routeError(reply: FastifyReply, error: unknown) {
  const code = error instanceof Error ? error.message : 'daily_life_failed';
  if (code === 'daily_life_list_not_found' || code === 'daily_life_item_not_found') {
    return reply.code(404).send({ error: code });
  }
  if (code === 'daily_life_list_exists' || code === 'daily_life_version_conflict') {
    return reply.code(409).send({ error: code });
  }
  if (code === 'daily_life_household_required') return reply.code(403).send({ error: code });
  if (code === 'daily_life_assignee_invalid') return reply.code(400).send({ error: code });
  if (code === 'daily_life_calendar_connection_required') return reply.code(409).send({ error: code });
  throw error;
}

export function registerDailyLifeRoutes(
  app: FastifyInstance,
  repository: DailyLifeRepository,
  agenda?: HouseholdAgendaService,
): void {
  app.get('/v1/daily-life', async (request) => {
    const principal = requireUserPrincipal(request);
    return repository.snapshot(principal.userId);
  });

  app.get('/v1/daily-life/agenda', async (request, reply) => {
    const principal = requireUserPrincipal(request);
    const parsed = agendaQuerySchema.safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ error: 'daily_life_agenda_range_invalid' });
    if (!agenda) return reply.code(503).send({ error: 'daily_life_agenda_unavailable' });
    return agenda.snapshot(principal.userId, parsed.data.timeMin, parsed.data.timeMax);
  });

  app.put('/v1/daily-life/agenda/sharing', async (request, reply) => {
    const principal = requireUserPrincipal(request);
    const parsed = agendaSharingSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'daily_life_request_invalid' });
    try {
      repository.setCalendarSharing(principal.userId, parsed.data.enabled);
      return reply.code(200).send({ enabled: parsed.data.enabled });
    } catch (error) { return routeError(reply, error); }
  });

  app.post('/v1/daily-life/lists', async (request, reply) => {
    const principal = requireUserPrincipal(request);
    const parsed = listCreateSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'daily_life_request_invalid' });
    try { return reply.code(201).send(repository.createList(principal.userId, parsed.data)); }
    catch (error) { return routeError(reply, error); }
  });

  app.patch('/v1/daily-life/lists/:listId', async (request, reply) => {
    const principal = requireUserPrincipal(request);
    const parsed = listUpdateSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'daily_life_request_invalid' });
    try {
      repository.updateList(principal.userId, (request.params as { listId: string }).listId, parsed.data);
      return reply.code(204).send();
    } catch (error) { return routeError(reply, error); }
  });

  app.post('/v1/daily-life/lists/:listId/items', async (request, reply) => {
    const principal = requireUserPrincipal(request);
    const parsed = itemCreateSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'daily_life_request_invalid' });
    try {
      const { recurrence, ...input } = parsed.data;
      return reply.code(201).send(repository.createItem(principal.userId,
        (request.params as { listId: string }).listId, {
          ...input,
          recurrenceUnit: input.recurrenceUnit ?? (recurrence === 'weekly' ? 'week' : recurrence === 'monthly' ? 'month' : 'none'),
        }));
    } catch (error) { return routeError(reply, error); }
  });

  app.patch('/v1/daily-life/items/:itemId', async (request, reply) => {
    const principal = requireUserPrincipal(request);
    const parsed = itemUpdateSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'daily_life_request_invalid' });
    const { expectedVersion, recurrence, ...input } = parsed.data;
    try {
      return repository.updateItem(
        principal.userId, (request.params as { itemId: string }).itemId, expectedVersion, {
          ...input,
          ...(input.recurrenceUnit === undefined && recurrence !== undefined ? {
            recurrenceUnit: recurrence === 'weekly' ? 'week' : recurrence === 'monthly' ? 'month' : 'none',
          } : {}),
        },
      );
    } catch (error) { return routeError(reply, error); }
  });

  app.get('/v1/daily-life/items/:itemId/occurrences', async (request) => {
    const principal = requireUserPrincipal(request);
    return {
      items: repository.listItemOccurrences(
        principal.userId,
        (request.params as { itemId: string }).itemId
      ),
    };
  });

  app.delete('/v1/daily-life/items/:itemId', async (request, reply) => {
    const principal = requireUserPrincipal(request);
    const parsed = itemDeleteSchema.safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ error: 'daily_life_request_invalid' });
    try {
      repository.deleteItem(
        principal.userId, (request.params as { itemId: string }).itemId, parsed.data.expectedVersion,
      );
      return reply.code(204).send();
    } catch (error) { return routeError(reply, error); }
  });
}
