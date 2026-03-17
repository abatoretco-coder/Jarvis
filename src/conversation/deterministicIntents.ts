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

const SAFE_TAUNTS = [
  'la boussole la plus calibree du tiroir',
  'le quartier le mieux desservi de la ville',
  'la notice la plus claire de l etagere',
  'le pingouin le plus rapide de la banquise',
  'la connexion la plus stable du wifi',
  'la playlist la plus coherente du vendredi soir',
  'le phare le plus lumineux du port',
  'la mise a jour la plus inspiree de la semaine',
  'le GPS le plus decide du tableau de bord',
  'le detour le plus court de l itineraire',
  'la tactique la plus subtile du championnat',
  'la repartie la plus chirurgicale du groupe',
  'la perle la plus rare du collier',
  'la meteo la plus fiable de l ete',
  'le raccourci le plus rapide du clavier',
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

function hashString(input: string): number {
  let acc = 0;
  for (let i = 0; i < input.length; i += 1) {
    acc = (acc * 31 + input.charCodeAt(i)) >>> 0;
  }
  return acc;
}

function pickDeterministic<T>(items: T[], seed: string): T {
  const idx = hashString(seed) % items.length;
  return items[idx]!;
}

function extractTarget(normalizedText: string): string | undefined {
  const direct = normalizedText.match(DIRECT_CAPTURE_RE)?.[1];
  if (direct) return direct;

  const captured = normalizedText.match(TARGET_CAPTURE_RE)?.[1];
  if (captured) return captured;

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
    if (!match.target) {
      return 'Je peux taquiner gentiment, mais il me faut un prenom. Donne-moi une cible.';
    }

    const targetName = toDisplayName(match.target);
    const ending = pickDeterministic(SAFE_TAUNTS, `${ctx.normalizedText}|${targetName}`);
    return `${targetName} n est pas ${ending}.`;
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
