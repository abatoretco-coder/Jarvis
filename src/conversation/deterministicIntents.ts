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
const INSULT_TRIGGER_RE = /\b(insulte(?:r)?|insult(?:e|er)?|savage|detruis|atomise|massacre)\b/i;
const TARGET_CAPTURE_RE = /\b(?:a|a\s+la|a\s+l'|pour|sur)\s+([a-z][a-z\-']{1,30})\b/i;
const DIRECT_CAPTURE_RE = /\b(?:compliment(?:e|er)?|complimente|roast(?:e|er)?|vanne(?:r)?|taquine(?:r)?)\s+([a-z][a-z\-']{1,30})\b/i;
const DIRECT_INSULT_CAPTURE_RE = /\b(?:insulte(?:r)?|insult(?:e|er)?|detruis|atomise|massacre)(?:[-\s]*(?:moi|le|la|lui))?\s+([a-z][a-z\-']{1,30})\b/i;
const TARGET_STOPWORDS = new Set(['pour', 'sur', 'a', 'au', 'aux', 'la', 'le', 'les', 'un', 'une', 'du', 'de', 'des', 'l']);

const IRONIC_TAUNTS = [
  'la lumiere la plus vive du couloir eteint',
  'le couteau le plus affute du tiroir en mousse',
  'le GPS le plus serein dans un rond-point infini',
  'la connexion la plus stable du wagon sans reseau',
  'la solution la plus simple en 14 etapes',
  'le detour le plus court de l autoroute',
  'la meteo la plus fiable un jour de grele',
  'le plan B le plus solide du plan C',
  'la boussole la plus fiable dans une machine a laver',
  'la mise a jour la plus opportune a 2% de batterie',
  'la tactique la plus subtile d un marteau piqueur',
  'la ponctualite la plus souple du dimanche soir',
  'la repartie la plus rapide apres verification legale',
  'le raccourci le plus long du clavier',
  'la couverture reseau la plus large du sous-sol',
  'le turbo le plus discret d un velo sans chaine',
  'la precision la plus chirurgicale avec des moufles',
  'la version finale la plus beta du dossier',
  'la playlist la plus calme d un reveillon',
  'la preuve tranquille que le hasard improvise',
];

const SAVAGE_TAUNTS = [
  'la mise a jour qui casse prod un vendredi a 17h59',
  'le bug critique avec une confiance de keynote',
  'le raccourci qui ajoute 40 minutes et un peage',
  'la connexion qui lag meme en mode avion',
  'le plan genial qui oublie le but',
  'la confidence du groupe publiee en story HD',
  'le radar qui rate un bus en plein parking',
  'la strategie brillante ecrite sur un post-it mouille',
  'la preuve qu on peut rater simple avec panache',
  'la reponse urgente livree apres la reunion bilan',
  'le mode expert de la confusion avancee',
  'le tuto vivant du comment empirer vite',
  'la promesse premium en finition brouillon deluxe',
  'la precision d un bulldozer en horlogerie',
  'le champion du demi-tour juste apres avoir parle',
];

const IRONIC_STARTERS = [
  '{target} n est pas exactement {ending}.',
  'On va dire que {target} n est pas {ending}.',
  'En toute franchise, {target} n est pas {ending}.',
  '{target}, c est pas vraiment {ending}.',
  'Soyons precis: {target} n est pas {ending}.',
];

const SAVAGE_STARTERS = [
  '{target}, c est {ending}.',
  'Version courte: {target}, c est {ending}.',
  'A ce stade, {target}, c est juste {ending}.',
  '{target} joue en ligue {ending}.',
  'Soyons francs, {target}, c est {ending}.',
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

function extractTarget(normalizedText: string, directRegex: RegExp): string | undefined {
  if (/\brobin\b/i.test(normalizedText)) return 'robin';

  const direct = normalizedText.match(directRegex)?.[1];
  if (direct && !TARGET_STOPWORDS.has(direct)) return direct;

  const capturedMatches = Array.from(normalizedText.matchAll(/\b(?:a|pour|sur)\s+([a-z][a-z\-']{1,30})\b/gi));
  for (const match of capturedMatches) {
    const candidate = (match[1] ?? '').toLowerCase();
    if (!candidate || TARGET_STOPWORDS.has(candidate)) continue;
    return candidate;
  }

  const captured = normalizedText.match(TARGET_CAPTURE_RE)?.[1]?.toLowerCase();
  if (captured && !TARGET_STOPWORDS.has(captured)) return captured;

  return undefined;
}

const complimentRule: DeterministicRule = {
  id: 'ironic_compliment',
  match: (ctx) => {
    if (!COMPLIMENT_TRIGGER_RE.test(ctx.normalizedText)) return undefined;

    const target = extractTarget(ctx.normalizedText, DIRECT_CAPTURE_RE);
    if (!target) {
      return {
        intent: 'ironic_missing_target',
        target: '',
      };
    }

    return {
      intent: 'ironic_named_target',
      target,
    };
  },
  render: (ctx, match) => {
    void ctx;
    if (!match.target) {
      return 'Je peux faire une ironie, mais il me faut un prenom. Donne-moi une cible.';
    }

    const targetName = toDisplayName(match.target);
    const ending = pickRandom(IRONIC_TAUNTS);
    const template = pickRandom(IRONIC_STARTERS);
    return template.replace('{target}', targetName).replace('{ending}', ending);
  },
};

const insultRule: DeterministicRule = {
  id: 'savage_insult',
  match: (ctx) => {
    if (!INSULT_TRIGGER_RE.test(ctx.normalizedText)) return undefined;

    const target = extractTarget(ctx.normalizedText, DIRECT_INSULT_CAPTURE_RE);
    if (!target) {
      return {
        intent: 'savage_missing_target',
        target: '',
      };
    }

    return {
      intent: 'savage_named_target',
      target,
    };
  },
  render: (ctx, match) => {
    void ctx;
    if (!match.target) {
      return 'Je peux envoyer une vanne sale, mais il me faut un prenom. Donne-moi une cible.';
    }

    const targetName = toDisplayName(match.target);
    const ending = pickRandom(SAVAGE_TAUNTS);
    const template = pickRandom(SAVAGE_STARTERS);
    return template.replace('{target}', targetName).replace('{ending}', ending);
  },
};

const deterministicRules: DeterministicRule[] = [
  insultRule,
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
