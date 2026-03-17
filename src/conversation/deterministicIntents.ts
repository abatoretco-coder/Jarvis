import { toSingleParagraphPlainText } from './plainText';

type DeterministicContext = {
  text: string;
  normalizedText: string;
};

type DeterministicMatch = {
  intent: string;
  target: string;
};

type DeterministicRule = {
  id: string;
  match: (ctx: DeterministicContext) => DeterministicMatch | undefined;
  render: (ctx: DeterministicContext, match: DeterministicMatch) => string;
};

export type DeterministicIntentReply = {
  intent: string;
  responseText: string;
  target?: string;
};

const COMPLIMENT_TRIGGER_RE = /\b(compliment(?:e|er)?|complimente|roast(?:e|er)?|vanne(?:r)?|taquine(?:r)?|punchline)\b/i;
const TARGET_CAPTURE_RE = /\b(?:a|a\s+la|a\s+l'|pour|sur)\s+([a-z][a-z\-']{1,30})\b/i;
const DIRECT_CAPTURE_RE = /\b(?:compliment(?:e|er)?|complimente|roast(?:e|er)?|vanne(?:r)?|taquine(?:r)?)\s+([a-z][a-z\-']{1,30})\b/i;
const TARGET_STOPWORDS = new Set(['pour', 'sur', 'a', 'au', 'aux', 'la', 'le', 'les', 'un', 'une', 'du', 'de', 'des', 'l']);

const SAFE_TAUNTS = [
  'le couteau le plus affute du tiroir',
  'la connexion la plus stable du metro',
  'le GPS le plus inspire dans un tunnel',
  'la punchline la plus fine du parking',
  'le plan B le plus solide du plan C',
  'le phare le plus lumineux en plein midi',
  'la fusee la plus rapide en marche arriere',
  'la boussole la plus fiable pendant un tremblement de terre',
  'la preuve vivante que le hasard existe',
  'la mise a jour la plus utile juste avant une panne',
  'le detour le plus court de l autoroute',
  'la strategie la plus subtile du marteau piqueur',
  'la clim la plus froide en plein sauna',
  'le mode d emploi le plus clair en police 4',
  'la repartie la plus rapide apres trois jours de latence',
  'la solution la plus simple en 12 etapes',
  'le raccourci le plus long du clavier',
  'la couverture reseau la plus large du sous sol',
  'la meteo la plus fiable un jour de grele',
  'le turbo le plus discret d un velo sans chaine',
];

const SAFE_STARTERS = [
  '{target} n est pas {ending}.',
  'Soyons honnetes: {target} n est pas {ending}.',
  '{target}, c est pas exactement {ending}.',
  'Objectivement, {target} n est pas {ending}.',
  '{target} n est clairement pas {ending}.',
];

function normalizeText(input: string): string {
  return toSingleParagraphPlainText(input)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

function toDisplayName(raw: string): string {
  const clean = raw
    .replace(/[^a-zA-Z\-']/g, ' ')
    .trim()
    .split(/\s+/)
    .filter((part) => part.length > 0)
    .slice(0, 2)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(' ');
  return clean || 'Robin';
}

function pickRandom<T>(items: T[]): T {
  const idx = Math.floor(Math.random() * items.length);
  return items[idx]!;
}

function extractTarget(normalizedText: string): string | undefined {
  const direct = normalizedText.match(DIRECT_CAPTURE_RE)?.[1];
  if (direct && !TARGET_STOPWORDS.has(direct)) return direct;

  const capturedMatches = Array.from(normalizedText.matchAll(/\b(?:a|pour|sur)\s+([a-z][a-z\-']{1,30})\b/gi));
  for (const match of capturedMatches) {
    const candidate = (match[1] ?? '').toLowerCase();
    if (!candidate || TARGET_STOPWORDS.has(candidate)) continue;
    return candidate;
  }

  const captured = normalizedText.match(TARGET_CAPTURE_RE)?.[1]?.toLowerCase();
  if (captured && !TARGET_STOPWORDS.has(captured)) return captured;

  if (/\brobin\b/i.test(normalizedText)) return 'robin';
  return undefined;
}

const complimentRule: DeterministicRule = {
  id: 'taunt_compliment',
  match: (ctx) => {
    if (!COMPLIMENT_TRIGGER_RE.test(ctx.normalizedText)) return undefined;

    const target = extractTarget(ctx.normalizedText);
    if (!target) {
      return {
        intent: 'taunt_missing_target',
        target: '',
      };
    }

    return {
      intent: 'taunt_named_target',
      target,
    };
  },
  render: (ctx, match) => {
    void ctx;
    if (!match.target) {
      return 'Je peux taquiner gentiment, mais il me faut un prenom. Donne-moi une cible.';
    }

    const targetName = toDisplayName(match.target);
    const ending = pickRandom(SAFE_TAUNTS);
    const template = pickRandom(SAFE_STARTERS);
    return template.replace('{target}', targetName).replace('{ending}', ending);
  },
};

const deterministicRules: DeterministicRule[] = [
  complimentRule,
];

export function resolveDeterministicIntentReply(text: string): DeterministicIntentReply | undefined {
  const clean = toSingleParagraphPlainText(text);
  if (!clean) return undefined;

  const context: DeterministicContext = {
    text: clean,
    normalizedText: normalizeText(clean),
  };

  for (const rule of deterministicRules) {
    const match = rule.match(context);
    if (!match) continue;

    return {
      intent: match.intent,
      target: match.target || undefined,
      responseText: toSingleParagraphPlainText(rule.render(context, match)),
    };
  }

  return undefined;
}
