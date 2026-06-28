import { randomUUID } from 'node:crypto';

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { toSingleParagraphPlainText } from '../conversation/plainText';
import type { AppDeps } from '../server';

function optionalTrimmedString(max: number) {
  return z.preprocess(
    (value) => {
      if (typeof value !== 'string') return value;
      const trimmed = value.trim();
      return trimmed.length > 0 ? trimmed.slice(0, max) : undefined;
    },
    z.string().min(1).max(max).optional()
  );
}

function requiredTrimmedString(max: number) {
  return z.preprocess(
    (value) => {
      if (typeof value !== 'string') return value;
      return value.trim().slice(0, max);
    },
    z.string().min(1).max(max)
  );
}

function optionalLinkString() {
  return z.preprocess(
    (value) => {
      if (typeof value !== 'string') return value;
      const trimmed = value.trim();
      return trimmed.length > 0 ? trimmed.slice(0, 1000) : undefined;
    },
    z.string().min(1).max(1000).optional()
  );
}

const newsSummaryBodySchema = z.object({
  scopeKey: z.string().min(1).max(200).optional(),
  scopeLabel: z.string().min(1).max(120),
  sectorLabel: z.string().min(1).max(120).optional(),
  contextFacts: z.array(z.string().min(1).max(220)).max(12).optional(),
  outputStyle: z.object({
    neutralOnly: z.boolean().optional(),
    oneIdeaPerBullet: z.boolean().optional(),
  }).optional(),
  items: z.array(
    z.object({
      title: requiredTrimmedString(400),
      link: optionalLinkString(),
      source: optionalTrimmedString(120),
      snippet: optionalTrimmedString(600),
      publishedAt: optionalTrimmedString(40),
    })
  ).min(3).max(18),
});

type NewsItemsQuery = {
  geoFilter?: string;
  tab?: string;
  sectors?: string;
  limit?: number;
};

const queryToken = z.string().trim().min(1).max(80).regex(/^[\p{L}\p{N} .,_:-]+$/u);
const newsItemsQuerySchema = z.object({
  geoFilter: queryToken.optional(),
  tab: queryToken.optional(),
  sectors: z.string().trim().min(1).max(300).regex(/^[\p{L}\p{N} .,_:-]+$/u).optional(),
  limit: z.coerce.number().int().min(1).max(50).optional(),
}).strict();

type HelixSummaryResponse = {
  status?: string;
  text?: string;
  contextNote?: string;
  selection?: unknown;
  generatedAt?: string;
};

function buildHelixHeaders(deps: AppDeps, input: { contentType?: string; requestId: string; correlationId?: string }): Record<string, string> {
  return {
    ...(input.contentType ? { 'content-type': input.contentType } : {}),
    'x-request-id': input.requestId,
    ...(input.correlationId ? { 'x-correlation-id': input.correlationId } : {}),
    ...(deps.env.HELIX_NEWS_API_TOKEN?.trim() ? { 'x-api-token': deps.env.HELIX_NEWS_API_TOKEN.trim() } : {}),
  };
}

function buildHelixUrl(deps: AppDeps, path: string, query?: URLSearchParams): string | null {
  const base = deps.env.HELIX_NEWS_BASE_URL?.trim();
  if (!base) return null;
  const url = `${base.replace(/\/$/, '')}${path}`;
  const qs = query?.toString();
  return qs ? `${url}?${qs}` : url;
}

async function readJsonResponse(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return {};
  }
}

async function proxyToHelix(url: string, deps: AppDeps, init?: RequestInit): Promise<unknown> {
  const response = await fetch(url, {
    ...init,
    signal: AbortSignal.timeout(deps.env.HELIX_NEWS_TIMEOUT_MS),
  });
  const payload = await readJsonResponse(response);
  if (!response.ok) {
    throw new Error(`helix_http_${response.status}:${JSON.stringify(payload).slice(0, 200)}`);
  }
  return payload;
}

export function registerNewsSummaryRoute(app: FastifyInstance, deps: AppDeps): void {
  app.get('/v1/news/items', async (req, reply) => {
    const parsedQuery = newsItemsQuerySchema.safeParse(req.query ?? {});
    if (!parsedQuery.success) {
      return reply.code(400).send({ error: 'invalid_query', issues: parsedQuery.error.issues });
    }
    const params = new URLSearchParams();
    const query: NewsItemsQuery = parsedQuery.data;
    if (query.geoFilter) params.set('geoFilter', query.geoFilter);
    if (query.tab) params.set('tab', query.tab);
    if (query.sectors) params.set('sectors', query.sectors);
    if (query.limit) params.set('limit', String(query.limit));

    const url = buildHelixUrl(deps, '/v1/news/items', params);
    if (!url) return reply.code(503).send({ error: 'helix_news_not_configured' });

    try {
      const requestId = typeof req.headers['x-request-id'] === 'string' ? req.headers['x-request-id'].slice(0, 120) : randomUUID();
      const correlationId = typeof req.headers['x-correlation-id'] === 'string' ? req.headers['x-correlation-id'].slice(0, 120) : undefined;
      const payload = await proxyToHelix(url, deps, { headers: buildHelixHeaders(deps, { requestId, correlationId }) });
      return reply.code(200).send(payload);
    } catch (error) {
      app.log.warn({ err: error, query: req.query }, 'helix_news_items_failed');
      return reply.code(502).send({ error: 'helix_news_items_failed' });
    }
  });

  app.post('/v1/news/summary', async (req, reply) => {
    const parsed = newsSummaryBodySchema.safeParse(req.body);
    if (!parsed.success) {
      app.log.warn({ issues: parsed.error.issues }, 'news_summary_invalid_body');
      return reply.code(400).send({ error: 'invalid_body', issues: parsed.error.issues });
    }

    const url = buildHelixUrl(deps, '/v1/news/summary');
    if (!url) return reply.code(503).send({ error: 'helix_news_not_configured' });

    try {
      const payload = await proxyToHelix(url, deps, {
        method: 'POST',
        headers: buildHelixHeaders(deps, {
          contentType: 'application/json',
          requestId: typeof req.headers['x-request-id'] === 'string' ? req.headers['x-request-id'].slice(0, 120) : randomUUID(),
          correlationId: typeof req.headers['x-correlation-id'] === 'string' ? req.headers['x-correlation-id'].slice(0, 120) : undefined,
        }),
        body: JSON.stringify(parsed.data),
      }) as HelixSummaryResponse;

      const text = typeof payload.text === 'string' ? toSingleParagraphPlainText(payload.text) : '';
      if (!text) return reply.code(502).send({ error: 'helix_news_summary_empty' });

      return reply.code(200).send({
        ...payload,
        status: payload.status ?? 'ok',
        source: 'helix',
        scopeKey: parsed.data.scopeKey,
        text,
        generatedAt: payload.generatedAt ?? new Date().toISOString(),
      });
    } catch (error) {
      app.log.warn({ err: error, scopeKey: parsed.data.scopeKey, scopeLabel: parsed.data.scopeLabel }, 'helix_news_summary_failed');
      return reply.code(502).send({ error: 'helix_news_summary_failed' });
    }
  });
}
