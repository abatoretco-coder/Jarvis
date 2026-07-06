import type { FastifyInstance } from 'fastify';

import type { ProactiveContextDomain, ProactiveContextResult } from '../context/ProactiveContextCache';
import type { AppDeps } from '../server';

function parseDomain(value: unknown): ProactiveContextDomain | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toLowerCase();
  if (
    normalized === 'spotify'
    || normalized === 'mail'
    || normalized === 'todo'
    || normalized === 'calendar'
    || normalized === 'weather'
    || normalized === 'home'
    || normalized === 'nas'
    || normalized === 'news'
    || normalized === 'daily_brief'
  ) {
    return normalized;
  }
  return undefined;
}

function isForce(value: unknown): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value !== 'string') return false;
  return ['1', 'true', 'yes', 'force'].includes(value.trim().toLowerCase());
}

function isDetail(value: unknown): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value !== 'string') return false;
  return ['1', 'true', 'yes', 'full', 'detail'].includes(value.trim().toLowerCase());
}

function serializeContextResult(result: ProactiveContextResult, detail: boolean): ProactiveContextResult | Omit<ProactiveContextResult, 'snapshot'> & {
  snapshot: Pick<ProactiveContextResult['snapshot'], 'domain' | 'preparedAnswers'>;
} {
  if (detail) return result;
  return {
    ...result,
    snapshot: {
      domain: result.snapshot.domain,
      preparedAnswers: result.snapshot.preparedAnswers,
    },
  };
}

export function registerContextCacheRoute(app: FastifyInstance, deps: AppDeps): void {
  app.get('/v1/context-cache', async (req, reply) => {
    if (!deps.contextCache) {
      return reply.code(503).send({ status: 'disabled', reason: 'context_cache_not_available' });
    }

    const query = (req.query ?? {}) as { detail?: unknown; domain?: unknown; refresh?: unknown };
    const domain = parseDomain(query.domain);
    if (!domain) {
      return reply.code(200).send({
        status: deps.env.PROACTIVE_CONTEXT_CACHE_ENABLED ? 'ok' : 'disabled',
        enabled: deps.env.PROACTIVE_CONTEXT_CACHE_ENABLED,
        providers: deps.contextCache.status(),
      });
    }

    try {
      const result = await deps.contextCache.get(domain, { force: isForce(query.refresh) });
      if (!result) {
        return reply.code(404).send({ status: 'unavailable', domain, reason: 'domain_disabled_or_not_configured' });
      }
      return reply.code(200).send({ status: 'ok', ...serializeContextResult(result, isDetail(query.detail)) });
    } catch (error) {
      app.log.warn({ error, domain }, 'context_cache_domain_failed');
      return reply.code(502).send({
        status: 'unavailable',
        domain,
        reason: error instanceof Error ? error.message : 'context_cache_failed',
      });
    }
  });

  app.post('/v1/context-cache/refresh', async (_req, reply) => {
    if (!deps.contextCache) {
      return reply.code(503).send({ status: 'disabled', reason: 'context_cache_not_available' });
    }
    const refreshed = await deps.contextCache.refreshAll();
    return reply.code(200).send({
      status: 'ok',
      refreshed: refreshed.map((item) => ({
        domain: item.domain,
        fetchedAt: item.fetchedAt,
        stale: item.stale,
      })),
      providers: deps.contextCache.status(),
    });
  });
}
