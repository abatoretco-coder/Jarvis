import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { toSingleParagraphPlainText } from '../conversation/plainText';
import type { AppDeps } from '../server';

function optionalTrimmedString(max: number) {
  return z.preprocess(
    (value) => {
      if (typeof value !== 'string') return value;
      const trimmed = value.trim();
      if (trimmed.length === 0) return undefined;
      return trimmed.slice(0, max);
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
      if (trimmed.length === 0) return undefined;
      return trimmed.slice(0, 1000);
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

const SUMMARY_SELECTED_ITEMS_MAX = 18;
const SUMMARY_ARTICLES_IN_PROMPT_MAX = 18;

type NewsSummaryRequest = z.infer<typeof newsSummaryBodySchema>;

type PreparedNewsItem = {
  title: string;
  link?: string;
  source?: string;
  snippet?: string;
  publishedAt?: string;
  sourceDomain: string;
  normalizedTitle: string;
  titleTokens: string[];
  firstIndex: number;
};

type PreparedSummaryInput = {
  items: PreparedNewsItem[];
  stats: {
    received: number;
    deduplicated: number;
    clustered: number;
    selected: number;
    uniqueSources: number;
  };
};

function firstSentence(text: string): string {
  const clean = toSingleParagraphPlainText(text);
  if (!clean) return '';
  const m = clean.match(/^(.+?[.!?])(?:\s|$)/);
  return m ? m[1] : clean;
}

function normalizeSourceDomain(input: string | undefined): string {
  const raw = (input ?? '').trim().toLowerCase();
  if (!raw) return 'unknown';
  try {
    const withProtocol = /^https?:\/\//.test(raw) ? raw : `https://${raw}`;
    const host = new URL(withProtocol).hostname.replace(/^www\./, '');
    return host || raw;
  } catch {
    return raw.replace(/^www\./, '').replace(/\/$/, '');
  }
}

function normalizeTitle(input: string): string {
  return toSingleParagraphPlainText(input)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function titleTokens(input: string): string[] {
  const stopWords = new Set([
    'the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'for', 'with', 'by',
    'le', 'la', 'les', 'de', 'des', 'du', 'un', 'une', 'et', 'ou', 'dans', 'pour', 'sur', 'par', 'au', 'aux',
  ]);
  return input
    .split(/\s+/)
    .filter((token) => token.length >= 3)
    .filter((token) => !stopWords.has(token));
}

function jaccardSimilarity(left: string[], right: string[]): number {
  if (left.length === 0 || right.length === 0) return 0;
  const leftSet = new Set(left);
  const rightSet = new Set(right);
  let intersection = 0;
  for (const token of leftSet) {
    if (rightSet.has(token)) intersection += 1;
  }
  const union = leftSet.size + rightSet.size - intersection;
  return union > 0 ? intersection / union : 0;
}

function parsePublishedAtMillis(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function buildPreparedItems(items: NewsSummaryRequest['items']): PreparedNewsItem[] {
  return items
    .map((item, index) => {
      const normalized = normalizeTitle(item.title);
      return {
        title: toSingleParagraphPlainText(item.title),
        link: item.link?.trim(),
        source: item.source?.trim(),
        snippet: item.snippet ? toSingleParagraphPlainText(item.snippet) : undefined,
        publishedAt: item.publishedAt?.trim(),
        sourceDomain: normalizeSourceDomain(item.source),
        normalizedTitle: normalized,
        titleTokens: titleTokens(normalized),
        firstIndex: index,
      } satisfies PreparedNewsItem;
    })
    .filter((item) => item.title.length > 0);
}

function deduplicateItems(items: PreparedNewsItem[]): PreparedNewsItem[] {
  const seen = new Set<string>();
  const kept: PreparedNewsItem[] = [];

  for (const item of items) {
    const linkKey = item.link?.toLowerCase();
    const titleSourceKey = `${item.normalizedTitle}::${item.sourceDomain}`;
    const titleSnippetKey = `${item.normalizedTitle}::${item.snippet ?? ''}`;
    const key = linkKey || titleSourceKey || titleSnippetKey;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    kept.push(item);
  }

  return kept;
}

type NewsCluster = {
  head: PreparedNewsItem;
  members: PreparedNewsItem[];
  sourceDomains: Set<string>;
  firstIndex: number;
};

function shouldJoinCluster(item: PreparedNewsItem, cluster: NewsCluster): boolean {
  const sim = jaccardSimilarity(item.titleTokens, cluster.head.titleTokens);
  if (sim >= 0.58) return true;

  const left = item.normalizedTitle;
  const right = cluster.head.normalizedTitle;
  if (!left || !right) return false;
  if (left.includes(right) || right.includes(left)) {
    const shorter = Math.min(left.length, right.length);
    return shorter >= 24;
  }

  return false;
}

function chooseClusterHead(cluster: NewsCluster): PreparedNewsItem {
  return [...cluster.members].sort((a, b) => {
    const aSnippet = (a.snippet ?? '').length;
    const bSnippet = (b.snippet ?? '').length;
    if (bSnippet !== aSnippet) return bSnippet - aSnippet;

    const aTime = parsePublishedAtMillis(a.publishedAt) ?? Number.MIN_SAFE_INTEGER;
    const bTime = parsePublishedAtMillis(b.publishedAt) ?? Number.MIN_SAFE_INTEGER;
    if (bTime !== aTime) return bTime - aTime;

    return a.firstIndex - b.firstIndex;
  })[0] ?? cluster.head;
}

function buildClusters(items: PreparedNewsItem[]): NewsCluster[] {
  const clusters: NewsCluster[] = [];

  for (const item of items) {
    const existing = clusters.find((cluster) => shouldJoinCluster(item, cluster));
    if (!existing) {
      clusters.push({
        head: item,
        members: [item],
        sourceDomains: new Set([item.sourceDomain]),
        firstIndex: item.firstIndex,
      });
      continue;
    }

    existing.members.push(item);
    existing.sourceDomains.add(item.sourceDomain);
    if (item.firstIndex < existing.firstIndex) existing.firstIndex = item.firstIndex;
    existing.head = chooseClusterHead(existing);
  }

  return clusters;
}

function scoreCluster(cluster: NewsCluster, now: number): number {
  const publishedAt = parsePublishedAtMillis(cluster.head.publishedAt);
  const recencyScore = publishedAt
    ? Math.max(0, 1 - (now - publishedAt) / (1000 * 60 * 60 * 48))
    : 0.4;
  const sourceDiversityScore = Math.min(1, cluster.sourceDomains.size / 3);
  const evidenceScore = Math.min(1, cluster.members.length / 4);
  const richnessScore = Math.min(1, ((cluster.head.snippet ?? '').length + cluster.head.title.length) / 420);
  const orderScore = Math.max(0, 1 - cluster.firstIndex / 24);

  return (
    recencyScore * 0.34
    + sourceDiversityScore * 0.23
    + evidenceScore * 0.18
    + richnessScore * 0.15
    + orderScore * 0.10
  );
}

function prepareSummaryInput(body: NewsSummaryRequest): PreparedSummaryInput {
  const prepared = buildPreparedItems(body.items);
  const deduplicated = deduplicateItems(prepared);
  const clusters = buildClusters(deduplicated);
  const now = Date.now();

  const ranked = [...clusters]
    .sort((a, b) => {
      const diff = scoreCluster(b, now) - scoreCluster(a, now);
      if (Math.abs(diff) > 0.0001) return diff > 0 ? 1 : -1;
      return a.firstIndex - b.firstIndex;
    });

  const selected = ranked.slice(0, SUMMARY_SELECTED_ITEMS_MAX).map((cluster) => cluster.head);
  const uniqueSources = new Set(selected.map((item) => item.sourceDomain)).size;

  return {
    items: selected,
    stats: {
      received: body.items.length,
      deduplicated: deduplicated.length,
      clustered: clusters.length,
      selected: selected.length,
      uniqueSources,
    },
  };
}

const OPINION_MARKERS_RE = /\b(cela souligne|ceci souligne|il faut|il faudrait|il est urgent|urgence d(?:'| )agir|doit|devrait|il est crucial|il est essentiel|on doit|on devrait|cela montre|ce qui montre)\b/i;

function splitBulletCandidates(text: string): string[] {
  const clean = toSingleParagraphPlainText(text);
  if (!clean) return [];

  const byBullet = clean
    .split(/\s*[•-]\s+/)
    .map((part) => part.trim())
    .filter(Boolean);

  if (byBullet.length >= 2) return byBullet;

  return clean
    .split(/(?<=[.!?])\s+/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function normalizeNeutralNewsSummary(summaryText: string): string {
  const bullets = splitBulletCandidates(summaryText)
    .map((entry) => firstSentence(entry))
    .map((entry) => toSingleParagraphPlainText(entry))
    .filter(Boolean)
    .filter((entry) => !OPINION_MARKERS_RE.test(entry))
    .map((entry) => `• ${entry}`);

  if (bullets.length === 0) return '';
  return toSingleParagraphPlainText(bullets.slice(0, 10).join(' '));
}

function buildDeterministicNewsSummary(body: NewsSummaryRequest, prepared: PreparedSummaryInput): string {
  const sectorLabel = body.sectorLabel?.trim();
  const facts = (body.contextFacts ?? [])
    .map((fact) => toSingleParagraphPlainText(fact))
    .filter(Boolean)
    .slice(0, 2);

  const lines: string[] = [];
  lines.push(`• Vue: ${body.scopeLabel}${sectorLabel ? ` (${sectorLabel})` : ''}.`);

  if (facts.length > 0) {
    lines.push(`• Repères: ${facts.join(' ; ')}.`);
  }

  const articleLines = prepared.items.slice(0, 8).map((item) => {
    const source = item.source?.trim() ? ` [${item.source.trim()}]` : '';
    const snippet = item.snippet ? firstSentence(item.snippet) : '';
    return `• ${item.title}${source}${snippet ? ` — ${snippet}` : ''}`;
  });

  lines.push(...articleLines);
  lines.push(
    `• Total analyse: ${prepared.stats.selected} histoire${prepared.stats.selected > 1 ? 's' : ''} cle${prepared.stats.selected > 1 ? 's' : ''} issue${prepared.stats.selected > 1 ? 's' : ''} de ${prepared.stats.received} article${prepared.stats.received > 1 ? 's' : ''}.`
  );

  return toSingleParagraphPlainText(lines.slice(0, 10).join(' '));
}

function buildPrompt(body: NewsSummaryRequest, prepared: PreparedSummaryInput): string {
  const sectorLabel = body.sectorLabel?.trim();
  const facts = (body.contextFacts ?? []).map((fact) => toSingleParagraphPlainText(fact)).filter(Boolean);
  const articleList = prepared.items
    .slice(0, SUMMARY_ARTICLES_IN_PROMPT_MAX)
    .map((item, index) => {
      const source = item.source?.trim() ? ` [${item.source.trim()}]` : '';
      const snippet = item.snippet?.trim() ? ` — ${toSingleParagraphPlainText(item.snippet)}` : '';
      return `${index + 1}. ${toSingleParagraphPlainText(item.title)}${source}${snippet}`;
    })
    .join('\n');

  const factBlock = facts.length > 0
    ? `Repères de vue:\n- ${facts.join('\n- ')}\n\n`
    : '';

  const neutralOnly = body.outputStyle?.neutralOnly !== false;
  const oneIdeaPerBullet = body.outputStyle?.oneIdeaPerBullet !== false;

  return [
    `Vue d'actualite: ${body.scopeLabel}${sectorLabel ? ` (${sectorLabel})` : ''}.`,
    factBlock,
    `Articles recents (deja dedoublonnes et regroupes par histoire):\n${articleList}`,
    `Meta selection: ${prepared.stats.received} recus, ${prepared.stats.deduplicated} dedoublonnes, ${prepared.stats.clustered} groupes, ${prepared.stats.selected} retenus, ${prepared.stats.uniqueSources} source(s) unique(s).`,
    neutralOnly ? 'Fais une synthese en francais, strictement neutre, en 10 points maximum separes par des tirets (•).' : 'Fais une synthese en francais en 10 points maximum separes par des tirets (•).',
    oneIdeaPerBullet ? 'Un point = une seule idee factuelle issue des titres/extraits. Pas de fusion de deux idees dans le meme point.' : '',
    neutralOnly ? 'Interdiction de commenter, interpreter, recommander, juger ou expliquer "pourquoi c est important".' : '',
    neutralOnly ? 'Interdiction des formulations d opinion ou normatives (ex: "cela souligne", "il faut", "urgence d agir").' : '',
    'Utilise uniquement les informations deduisibles de ces articles et des reperes fournis.',
    'Ne fais ni introduction, ni disclaimer, ni texte supplementaire.',
    'Format exact: • fait 1 • fait 2 • fait 3 ...',
  ].filter(Boolean).join('\n\n');
}

function buildContextNote(body: NewsSummaryRequest, summaryText: string, prepared: PreparedSummaryInput): string {
  const articleTitles = prepared.items
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
    + ` Selection: ${prepared.stats.selected} histoire(s) sur ${prepared.stats.received} article(s), ${prepared.stats.uniqueSources} source(s) unique(s).`
    + `${facts ? ` Reperes: ${facts}.` : ''}`
    + `${articleTitles ? ` Titres sources: ${articleTitles}.` : ''}`
  );
}

async function requestSummaryFromOpenAi(body: NewsSummaryRequest, prepared: PreparedSummaryInput, deps: AppDeps): Promise<string> {
  const openAiApiKey = deps.env.OPENAI_API_KEY?.trim();
  if (!openAiApiKey) {
    throw new Error('openai_api_key_missing');
  }

  const summaryModel = deps.env.OPENAI_MODEL_SUMMARY.trim() === 'gpt-4o-mini'
    ? 'gpt-4o'
    : deps.env.OPENAI_MODEL_SUMMARY;

  const response = await fetch(`${deps.env.OPENAI_BASE_URL.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${openAiApiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: summaryModel,
      temperature: 0.15,
      max_tokens: 520,
      messages: [
        {
          role: 'system',
          content:
            'Tu es un redacteur de flash info. Tu rends uniquement des faits, sans opinion ni interpretation. Une puce = une information factuelle unique. Tu n inventes rien au-dela des titres et extraits fournis.',
        },
        {
          role: 'user',
          content: buildPrompt(body, prepared),
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
  const summaryText = normalizeNeutralNewsSummary(content);
  if (!summaryText) {
    throw new Error('news_summary_empty');
  }

  return summaryText;
}

export function registerNewsSummaryRoute(app: FastifyInstance, deps: AppDeps): void {
  app.post('/v1/news/summary', async (req, reply) => {
    const parsed = newsSummaryBodySchema.safeParse(req.body);
    if (!parsed.success) {
      app.log.warn({ issues: parsed.error.issues }, 'news_summary_invalid_body');
      return reply.code(400).send({ error: 'invalid_body', issues: parsed.error.issues });
    }

    try {
      const prepared = prepareSummaryInput(parsed.data);
      const summaryText = await requestSummaryFromOpenAi(parsed.data, prepared, deps);
      return reply.code(200).send({
        status: 'ok',
        scopeKey: parsed.data.scopeKey,
        text: summaryText,
        contextNote: buildContextNote(parsed.data, summaryText, prepared),
        selection: prepared.stats,
        generatedAt: new Date().toISOString(),
      });
    } catch (error) {
      app.log.warn({ err: error, scopeKey: parsed.data.scopeKey, scopeLabel: parsed.data.scopeLabel }, 'news_summary_failed');
      const prepared = prepareSummaryInput(parsed.data);
      const fallbackText = buildDeterministicNewsSummary(parsed.data, prepared);
      return reply.code(200).send({
        status: 'fallback',
        scopeKey: parsed.data.scopeKey,
        text: fallbackText,
        contextNote: buildContextNote(parsed.data, fallbackText, prepared),
        selection: prepared.stats,
        generatedAt: new Date().toISOString(),
      });
    }
  });
}
