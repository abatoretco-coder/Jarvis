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
  'le chef d orchestre le plus synchronise de la fosse',
  'la feuille de route la plus lineaire du dossier',
  'le radar le plus sensible de la circulation',
  'la boule de cristal la plus precise de la reunion',
  'le mode d emploi le plus limpide de la boite',
  'la strategie la plus froide du vestiaire',
  'le coupe vent le plus impermeable de la tempete',
  'la calibrage le plus fin du banc de test',
  'la prediction la plus stable du week end',
  'la fusee la plus droite du decollage',
  'la carte la plus lisible de la ville',
  'le decorateur le plus minimaliste du carnaval',
  'la punchline la plus douce du stand up',
  'la serrure la plus ouverte du quartier',
  'le signal le plus net du tunnel',
  'la meilleure affaire du marche noir des idees',
  'le chrono le plus indulgent du championnat',
  'la marche arriere la plus elegante de l autoroute',
  'la precision la plus chirurgicale du marteau piqueur',
  'le plan B le plus convaincant du plan A',
  'la recette la plus dietetique de la friteuse',
  'la batterie la plus chargee un lundi matin',
  'la repartition la plus logique du chaos',
  'le musee le plus anime a 3 heures du matin',
  'la couverture reseau la plus large du sous sol',
  'la ponctualite la plus rigoureuse du dimanche',
  'la ligne droite la plus sinueuse de la carte',
  'la playlist la plus calme d un reveillon',
  'le mediateur le plus neutre d un derby',
  'la simplification la plus simple du mode expert',
  'la mise au point la plus nette du brouillard',
  'la coherence la plus coherentement incoherente du lot',
  'la garantie la plus rassurante sans garantie',
  'la trajectoire la plus directe avec trois escales',
  'le filtre anti bruit le plus bavard du studio',
  'la pause cafe la plus courte de l administration',
  'la stabilite la plus dynamique du circuit',
  'la voie rapide la plus contemplative du peripherique',
  'la marguerite la plus fraiche du bitume',
  'la clim la plus chaude de l ete',
  'la synthese la plus courte avec preface',
  'le juge de paix le plus indecis du tournoi',
  'la salve la plus discrete du feu d artifice',
  'la route la plus plate des montagnes russes',
  'le compromis le plus tranche de la negociation',
  'la station la plus proche a trois changements',
  'la maintenance la plus preventive de l urgence',
  'la visibilite la plus claire de la nuit sans lune',
  'la vitesse de croisiere la plus sportive en zone 30',
  'la pedagogie la plus concise en 48 chapitres',
  'la sortie de secours la plus centrale de l impasse',
  'le cap le plus fixe quand la boussole tourne',
  'la sobriete la plus festive du festival',
  'la stabilisation la plus stable quand tout tremble',
];

const SAFE_STARTERS = [
  '{target} n est pas {ending}.',
  'Disons que {target} n est pas {ending}.',
  '{target}, c est pas exactement {ending}.',
  'On va rester honnete: {target} n est pas {ending}.',
  '{target} n est clairement pas {ending}.',
  'Soyons francs, {target} n est pas {ending}.',
  'Sans vouloir juger, {target} n est pas {ending}.',
  'En toute objectivite, {target} n est pas {ending}.',
  '{target} n est pas vraiment {ending}.',
  'Objectivement, {target} n est pas {ending}.',
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
