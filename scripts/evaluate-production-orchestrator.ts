/**
 * Production-contract evaluation for the Jarvis orchestrator.
 *
 * This does not execute a capability. It sends raw client text through the
 * same prompt, model endpoint and JSON contract as orchestratorRouter.ts, then
 * records whether the returned domain and (where supported) action are correct.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { buildOrchestratorSystemPrompt } from '../src/conversation/prompts/orchestratorSystemPrompt';
import { buildOrchestratorUserPrompt } from '../src/conversation/prompts/orchestratorUserTemplate';
import { buildOrchestratorResponseFormat, GENERAL_ROUTER_AGENT_ID, HOME_CONTROL_ROUTER_AGENT_ID, LOCAL_WEATHER_ROUTER_AGENT_ID, parseAgentMap, SPOTIFY_AGENT_ID, type AgentRouteEntry } from '../src/conversation/orchestratorRouter';

type Client = 'desktop' | 'apk' | 'voice';
type Expected = { agentIds: string[] };
type Case = { id: string; client: Client; text: string; expected: Expected };
type Result = Case & {
  actualTargets: Array<{ agentId: string; confidence: number; action?: string }>;
  raw: string;
  latencyMs: number;
  targetOk: boolean;
  issue?: string;
};

function buildRouterAgents(agentMap: string | undefined): AgentRouteEntry[] {
  return [
  { agentId: GENERAL_ROUTER_AGENT_ID, routerId: GENERAL_ROUTER_AGENT_ID, key: GENERAL_ROUTER_AGENT_ID, hint: 'Conversation générale: salutations, discussion, questions générales, vérification du chat, blagues et aide sur Jarvis sans action connectée' },
  { agentId: SPOTIFY_AGENT_ID, key: 'spotify', hint: 'Musique streaming Spotify: jouer, pause, suivant, précédent, volume, recherche musicale' },
  { agentId: 'weather', routerId: LOCAL_WEATHER_ROUTER_AGENT_ID, key: 'weather', hint: 'Meteo locale Home Assistant: etat actuel, temperature, humidite, precipitation, previsions courtes. Jamais une ville externe.' },
  ...parseAgentMap(agentMap),
  ];
}

function variants(client: Client, prefix: string, texts: string[], agentId: string): Case[] {
  return texts.map((text, index) => ({ id: `${prefix}-${index + 1}`, client, text, expected: { agentIds: [agentId] } }));
}

const baseCases: Case[] = [
  ...variants('desktop', 'general', [
    'Test, tu me reçois ?', 'Bonjour Jarvis', 'Tu m entends bien ?', 'Merci.', 'Comment vas-tu ?',
    'Peux-tu discuter avec moi ?', 'Explique-moi ce que tu sais faire.', 'Quelle est la différence entre RAM et stockage ?',
    'Raconte-moi une blague courte.', 'Je voulais juste vérifier que tu réponds.', 'Allô ?', 'Quel est ton nom ?',
  ], GENERAL_ROUTER_AGENT_ID),
  ...variants('apk', 'mail-read', [
    'Lis mes emails non lus.', 'Quels nouveaux mails ai-je reçus ?', 'Montre ma boîte de réception.',
    'Cherche les emails de Léa.', 'Lis le mail de la banque.', 'Trouve le message avec le devis.',
  ], 'gmail'),
  ...variants('voice', 'mail-write', [
    'Envoie un email à Léa pour confirmer le déjeuner.', 'Réponds au dernier email de Marc que je suis disponible.',
    'Transfère le mail du devis à Paul.', 'Mets le dernier email à la corbeille.',
    'Marque le mail de Sophie comme lu.', 'Remets le message de la banque en non lu.',
    'Marque le dernier email comme important.', 'Rédige un mail à julie@example.com.',
  ], 'gmail'),
  ...variants('desktop', 'todo', [
    'Liste mes tâches.', 'Quelles tâches me restent-il aujourd hui ?', 'Montre les tâches en retard.',
    'Ajoute acheter du lait à mes tâches.', 'Crée une tâche appeler Paul demain.',
    'Marque acheter du lait comme terminée.', 'Supprime la tâche acheter du lait.',
    'Renomme la tâche courses en courses du week-end.', 'Crée une liste vacances.',
    'Supprime ma liste vacances.', 'Ajoute passeport à la checklist vacances.',
    'Coche passeport dans la checklist vacances.', 'Retire passeport de la checklist vacances.',
  ], 'todo'),
  ...variants('voice', 'spotify-pause', ['Mets la musique en pause.', 'Pause Spotify.', 'Arrête la musique.'], SPOTIFY_AGENT_ID),
  ...variants('desktop', 'spotify-play', ['Reprends la musique.', 'Relance Spotify.', 'Joue de la musique.'], SPOTIFY_AGENT_ID),
  ...variants('apk', 'spotify-navigation', ['Passe au morceau suivant.', 'Reviens au morceau précédent.', 'Quel titre est en cours ?', 'Liste mes appareils Spotify.'], SPOTIFY_AGENT_ID),
  ...variants('voice', 'spotify-search', ['Joue du jazz.', 'Mets Daft Punk sur Spotify.', 'Ajoute Bohemian Rhapsody à la file.', 'Transfère la musique sur le salon.', 'Mets le volume Spotify à 30 %.'], SPOTIFY_AGENT_ID),
  ...variants('desktop', 'weather-local', ['Quelle température fait-il chez moi ?', 'Est-ce qu il pleut ?', 'Quel temps demain ?', 'Quelle humidité y a-t-il ici ?', 'Va-t-il pleuvoir cette semaine ?'], 'weather'),
  ...variants('apk', 'weather-external', ['Quelle météo à Paris demain ?', 'Quel temps fait-il à Londres ?', 'Est-ce qu il pleut à Lyon ?', 'Prévisions pour Rome ce week-end.'], 'search.news'),
  ...variants('voice', 'search-news', ['Qui a gagné le match hier ?', 'Quelles sont les actualités du jour ?', 'Quel est le prix du bitcoin ?'], 'search.news'),
  ...variants('voice', 'search-web', ['Cherche pourquoi le ciel est bleu.', 'Qui est Marie Curie ?'], 'search.web'),
  ...variants('voice', 'search-deep', ['Compare le NAS et le cloud en profondeur.'], 'search.deep'),
  ...variants('desktop', 'executor', [
    'Allume la lumière du salon.', 'Éteins la prise du bureau.', 'Mets un minuteur de cinq minutes.',
    'Programme un rappel à 18 heures.', 'Lance le script bonne nuit.', 'Active la scène cinéma.',
    'Démarre l aspirateur robot.', 'Renvoie le robot à sa base.', 'Quelle est la batterie du robot ?',
    'Ferme les volets du salon.', 'Mets le chauffage à 20 degrés.', 'Joue la radio dans la cuisine.',
    'Appelle le service interphone du portail.', 'Ouvre le garage.', 'Éteins toutes les lumières de l étage.',
  ], HOME_CONTROL_ROUTER_AGENT_ID),
  ...variants('apk', 'adversarial-general', [
    'Est-ce que tu reçois mes messages ?', 'Tu réponds ?', 'Je teste le chat.', 'Salut assistant.',
    'Peux-tu me dire bonjour ?', 'Je n ai aucune commande à faire.', 'Merci, c est tout.', 'On peut parler ?'
  ], GENERAL_ROUTER_AGENT_ID),
  { id: 'multi-intent-1', client: 'voice', text: 'Lis mes mails et ajoute répondre à Léa à mes tâches.', expected: { agentIds: ['gmail', 'todo'] } },
  { id: 'multi-intent-2', client: 'voice', text: 'Donne-moi la météo et joue du jazz.', expected: { agentIds: ['weather', SPOTIFY_AGENT_ID] } },
  { id: 'multi-intent-3', client: 'voice', text: 'Allume le salon puis liste mes tâches.', expected: { agentIds: [HOME_CONTROL_ROUTER_AGENT_ID, 'todo'] } },
  { id: 'multi-intent-4', client: 'voice', text: 'Cherche les actualités et mets la musique en pause.', expected: { agentIds: ['search.news', SPOTIFY_AGENT_ID] } },
];

// Desktop and APK submit the same raw contract to this router. Evaluate every
// utterance through both surfaces; any divergent result would be a backend
// defect because the router prompt intentionally has no client branch.
const allCases: Case[] = baseCases.flatMap((test) => (['desktop', 'apk'] as Client[]).map((client) => ({
  ...test,
  id: `${test.id}-${client}`,
  client,
})));

if (allCases.length < 150) throw new Error(`Corpus insufficient: ${allCases.length} cases`);

function readEnvFile(): Record<string, string> {
  const file = resolve(process.cwd(), '.env.pc');
  return Object.fromEntries(readFileSync(file, 'utf8').split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
    .flatMap((line) => {
      const index = line.indexOf('=');
      return index > 0 ? [[line.slice(0, index), line.slice(index + 1).replace(/^['"]|['"]$/g, '')]] : [];
    }));
}

function parseTargets(raw: string, routerIdToAgentId: Map<string, string>): Result['actualTargets'] {
  try {
    const value = JSON.parse(raw) as { targets?: unknown };
    if (!Array.isArray(value.targets)) return [];
    return value.targets.flatMap((target) => {
      if (!target || typeof target !== 'object') return [];
      const item = target as Record<string, unknown>;
      const routerId = typeof item.agentId === 'string' ? item.agentId : '';
      const agentId = routerIdToAgentId.get(routerId) ?? routerId;
      return agentId
        ? [{ agentId, confidence: typeof item.confidence === 'number' ? item.confidence : 0, ...(typeof item.action === 'string' ? { action: item.action } : {}) }]
        : [];
    });
  } catch {
    return [];
  }
}

function resolveEvaluationBaseUrl(raw: string | undefined): string {
  const configured = (raw || 'http://127.0.0.1:11434/v1').replace(/\/$/, '');
  // The evaluator runs on the host, while Jarvis itself runs in Docker.
  // Translate its private service name to the deliberately separate host port;
  // port 11434 can belong to another Ollama installation (for example Helix).
  if (/^https?:\/\/jarvis-ollama:11434(?:\/|$)/.test(configured)) {
    return configured.replace('jarvis-ollama:11434', '127.0.0.1:11435');
  }
  // `host.docker.internal` is therefore translated back to the host loopback.
  return configured.replace('host.docker.internal', '127.0.0.1');
}

async function evaluate(test: Case, model: string, routerAgents: AgentRouteEntry[], baseUrl: string): Promise<Result> {
  const started = performance.now();
  try {
  const nativeBaseUrl = baseUrl.replace(/\/v1\/?$/, '').replace(/\/$/, '');
  const responseFormat = buildOrchestratorResponseFormat('ollama', routerAgents.map((agent) => agent.routerId ?? agent.agentId));
  const schema = ((responseFormat.json_schema as { schema?: Record<string, unknown> } | undefined)?.schema ?? {});
  const response = await fetch(`${nativeBaseUrl}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ollama' },
    signal: AbortSignal.timeout(20_000),
    body: JSON.stringify({
      model,
      stream: false,
      think: false,
      format: schema,
      options: { temperature: 0, top_p: 1, seed: 17, num_predict: 160 },
      messages: [
        { role: 'system', content: buildOrchestratorSystemPrompt() },
        { role: 'user', content: buildOrchestratorUserPrompt({ text: test.text, agents: routerAgents, recentMessages: [] }) },
      ],
    }),
  });
  const body = await response.json() as { message?: { content?: string }; error?: string | { message?: string } };
  const raw = body.message?.content?.trim() ?? '';
  const routerIdToAgentId = new Map(routerAgents.map((agent) => [agent.routerId ?? agent.agentId, agent.agentId]));
  const actualTargets = response.ok ? parseTargets(raw, routerIdToAgentId) : [];
  const actual = actualTargets.filter((target) => target.confidence >= 0.7);
  const expectedAgentIds = test.expected.agentIds.map((agentId) => routerIdToAgentId.get(agentId) ?? agentId);
  const targetOk = expectedAgentIds.every((expectedAgentId) => actual.some((target) => target.agentId === expectedAgentId));
  const issue = !response.ok
    ? `http_${response.status}:${typeof body.error === 'string' ? body.error : body.error?.message ?? 'unknown'}`
    : !targetOk
      ? `expected ${test.expected.agentIds.join('+')}, got ${actual.map((target) => target.agentId).join(',') || 'none'}`
      : undefined;
  return { ...test, actualTargets, raw, latencyMs: Math.round(performance.now() - started), targetOk, ...(issue ? { issue } : {}) };
  } catch (error) {
    return {
      ...test,
      actualTargets: [],
      raw: '',
      latencyMs: Math.round(performance.now() - started),
      targetOk: false,
      issue: error instanceof Error && error.name === 'TimeoutError' ? 'ollama_timeout_20s' : `ollama_request_failed:${String(error)}`,
    };
  }
}

async function main() {
  const env = readEnvFile();
  const model = process.env.OLLAMA_ROUTER_MODEL?.trim() || env.OLLAMA_MODEL || 'qwen2.5:1.5b-instruct';
  const baseUrl = resolveEvaluationBaseUrl(process.env.OLLAMA_EVALUATION_BASE_URL || env.OLLAMA_BASE_URL);
  const requestedLimit = Number.parseInt(process.env.ROUTER_EVAL_LIMIT ?? '', 10);
  const requestedOffset = Number.parseInt(process.env.ROUTER_EVAL_OFFSET ?? '0', 10);
  const offset = Number.isFinite(requestedOffset) && requestedOffset >= 0 ? requestedOffset : 0;
  const cases = Number.isFinite(requestedLimit) && requestedLimit > 0
    ? allCases.slice(offset, offset + requestedLimit)
    : allCases.slice(offset);
  const routerAgents = buildRouterAgents(env.HA_AGENT_MAP);
  const results: Result[] = [];
  for (const [index, test] of cases.entries()) {
    results.push(await evaluate(test, model, routerAgents, baseUrl));
    if ((index + 1) % 10 === 0) console.log(`progress=${index + 1}/${cases.length}`);
  }
  const timestamp = new Date().toISOString();
  const report = {
    timestamp,
    model,
    baseUrl,
    scope: 'Raw client requests against the production orchestrator prompt and its configured agents. No capability, planner or connector is executed.',
    configuredAgents: routerAgents.map(({ agentId, key }) => ({ agentId, key })),
    totals: {
      cases: results.length,
      targetPassed: results.filter((result) => result.targetOk).length,
    },
    results,
  };
  const directory = resolve(process.cwd(), 'artifacts');
  mkdirSync(directory, { recursive: true });
  const file = resolve(directory, `production-orchestrator-${timestamp.replace(/[:.]/g, '-')}.json`);
  writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`model=${model} cases=${report.totals.cases} target=${report.totals.targetPassed}/${report.totals.cases}`);
  console.log(`report=${file}`);
  for (const result of results.filter((item) => item.issue).slice(0, 40)) {
    console.log(`FAIL ${result.id}: ${result.issue} | ${result.text} | ${result.raw.slice(0, 180)}`);
  }
}

void main();
