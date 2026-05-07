import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { toSingleParagraphPlainText } from '../conversation/plainText';
import type { AppDeps } from '../server';

const newsSummaryBodySchema = z.object({
  scopeKey: z.string().min(1).max(200).optional(),
  scopeLabel: z.string().min(1).max(120),
  sectorLabel: z.string().min(1).max(120).optional(),
  contextFacts: z.array(z.string().min(1).max(180)).max(8).optional(),
  items: z.array(
    z.object({
      title: z.string().min(1).max(400),
      link: z.string().url().optional(),
      source: z.string().min(1).max(120).optional(),
      snippet: z.string().min(1).max(600).optional(),
    })
  ).min(3).max(12),
});

type NewsSummaryRequest = z.infer<typeof newsSummaryBodySchema>;

function buildPrompt(body: NewsSummaryRequest): string {
  const sectorLabel = body.sectorLabel?.trim();
  const facts = (body.contextFacts ?? []).map((fact) => toSingleParagraphPlainText(fact)).filter(Boolean);
  const articleList = body.items
    .slice(0, 10)
    .map((item, index) => {
      const source = item.source?.trim() ? ` [${item.source.trim()}]` : '';
      const snippet = item.snippet?.trim() ? ` — ${toSingleParagraphPlainText(item.snippet)}` : '';
      return `${index + 1}. ${toSingleParagraphPlainText(item.title)}${source}${snippet}`;
    })
    .join('\n');

  const factBlock = facts.length > 0
    ? `Repères de vue:\n- ${facts.join('\n- ')}\n\n`
    : '';

  return [
    `Vue d'actualite: ${body.scopeLabel}${sectorLabel ? ` (${sectorLabel})` : ''}.`,
    factBlock,
    `Articles recents:\n${articleList}`,
    'Fais une synthese en francais en 4 points cles courts et factuels, separes par des tirets (•).',
    'Utilise uniquement les informations deduisibles de ces articles et des reperes fournis.',
    'Ne fais ni introduction, ni disclaimer, ni texte supplementaire.',
    'Format exact: • point 1 • point 2 • point 3 • point 4',
  ].filter(Boolean).join('\n\n');
}

function buildContextNote(body: NewsSummaryRequest, summaryText: string): string {
  const articleTitles = body.items
    .slice(0, 5)
    .map((item) => toSingleParagraphPlainText(item.title))
    .filter(Boolean)
    .join(' ; ');
  const facts = (body.contextFacts ?? [])
    .map((fact) => toSingleParagraphPlainText(fact))
    .filter(Boolean)
    .join(' ; ');

  return toSingleParagraphPlainText(
    `Contexte actualite a conserver pour cette conversation. Vue: ${body.scopeLabel}.`
    + `${body.sectorLabel ? ` Secteur: ${body.sectorLabel}.` : ''}`
    + ` Synthese: ${summaryText}.`
    + `${facts ? ` Reperes: ${facts}.` : ''}`
    + `${articleTitles ? ` Titres sources: ${articleTitles}.` : ''}`
  );
}

async function requestSummaryFromOpenAi(body: NewsSummaryRequest, deps: AppDeps): Promise<string> {
  const openAiApiKey = deps.env.OPENAI_API_KEY?.trim();
  if (!openAiApiKey) {
    throw new Error('openai_api_key_missing');
  }

  const response = await fetch(`${deps.env.OPENAI_BASE_URL.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${openAiApiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: deps.env.OPENAI_MODEL_SUMMARY,
      temperature: 0.2,
      max_tokens: 260,
      messages: [
        {
          role: 'system',
          content:
            'Tu es un assistant d actualite francais. Tu rediges des syntheses tres concises, factuelles et sans emphase. Tu n inventes rien au-dela des titres et extraits fournis.',
        },
        {
          role: 'user',
          content: buildPrompt(body),
        },
      ],
    }),
    signal: AbortSignal.timeout(deps.env.OPENAI_TIMEOUT_MS),
  });

  if (!response.ok) {
    const rawBody = await response.text().catch(() => '');
    throw new Error(`news_summary_http_${response.status}:${rawBody.slice(0, 200)}`);
  }

  const raw = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
  const content = raw.choices?.[0]?.message?.content?.trim() ?? '';
  const summaryText = toSingleParagraphPlainText(content);
  if (!summaryText) {
    throw new Error('news_summary_empty');
  }

  return summaryText;
}

export function registerNewsSummaryRoute(app: FastifyInstance, deps: AppDeps): void {
  app.post('/v1/news/summary', async (req, reply) => {
    const parsed = newsSummaryBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_body', issues: parsed.error.issues });
    }

    try {
      const summaryText = await requestSummaryFromOpenAi(parsed.data, deps);
      return reply.code(200).send({
        status: 'ok',
        scopeKey: parsed.data.scopeKey,
        text: summaryText,
        contextNote: buildContextNote(parsed.data, summaryText),
        generatedAt: new Date().toISOString(),
      });
    } catch (error) {
      app.log.warn({ err: error, scopeKey: parsed.data.scopeKey, scopeLabel: parsed.data.scopeLabel }, 'news_summary_failed');
      const message = error instanceof Error ? error.message : String(error);
      if (message === 'openai_api_key_missing') {
        return reply.code(503).send({ error: 'summary_provider_not_configured' });
      }
      return reply.code(502).send({ error: 'news_summary_failed' });
    }
  });
}