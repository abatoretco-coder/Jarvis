import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { loadEnv } from '../src/env';
import { type OpenAiTextCapability,resolveOpenAiCapability } from '../src/openai/capabilities';
import { configureOpenAiResilience } from '../src/openai/resilience';
import { getOpenAiTelemetrySnapshot, requestOpenAiResponse } from '../src/openai/responsesClient';

function parseEnvFile(path: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const rawLine of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const separator = line.indexOf('=');
    if (separator <= 0) continue;
    const name = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
      value = value.slice(1, -1);
    }
    values[name] = value;
  }
  return values;
}

function requiredArg(name: string): string {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (!value) throw new Error(`Missing required argument ${name}`);
  return value;
}

const env = loadEnv({ ...process.env, ...parseEnvFile(resolve(requiredArg('--env'))) });
if (!env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY is required');

type Evaluation = {
  id: string;
  capability: OpenAiTextCapability;
  system: string;
  user: string;
  validate: (text: string) => boolean;
  jsonSchema?: { name: string; schema: Record<string, unknown> };
};

type Metric = { inputTokens?: number; outputTokens?: number; totalTokens?: number };
type Telemetry = { capabilities?: Record<string, Metric> };
type Price = { inputUsdPerMillion: number; outputUsdPerMillion: number };

const PRICES_USD: Record<string, Price> = {
  'gpt-6-luna': { inputUsdPerMillion: 0.10, outputUsdPerMillion: 0.50 },
  'gpt-6.1-sol': { inputUsdPerMillion: 2.00, outputUsdPerMillion: 10.00 },
};

function enumObjectSchema(name: string, properties: Record<string, string[]>): Evaluation['jsonSchema'] {
  return {
    name,
    schema: {
      type: 'object',
      properties: Object.fromEntries(Object.entries(properties).map(([key, values]) => [
        key, { type: 'string', enum: values },
      ])),
      required: Object.keys(properties),
      additionalProperties: false,
    },
  };
}

function parseJson(text: string): Record<string, unknown> {
  const parsed = JSON.parse(text) as unknown;
  return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {};
}

const evaluations: Evaluation[] = [
  {
    id: 'router.weather', capability: 'router',
    system: 'Classe la demande dans la route attendue. Réponds selon le schéma.',
    user: 'Quel temps fera-t-il demain à Paris ?',
    jsonSchema: enumObjectSchema('router_weather', { route: ['weather'] }),
    validate: (text) => parseJson(text).route === 'weather',
  },
  {
    id: 'router.mail', capability: 'router',
    system: 'Classe la demande dans la route attendue. Réponds selon le schéma.',
    user: 'Montre-moi mes messages non lus.',
    jsonSchema: enumObjectSchema('router_mail', { route: ['mail'] }),
    validate: (text) => parseJson(text).route === 'mail',
  },
  {
    id: 'router.todo', capability: 'router',
    system: 'Classe la demande dans la route attendue. Réponds selon le schéma.',
    user: 'Ajoute acheter du café à ma liste de tâches.',
    jsonSchema: enumObjectSchema('router_todo', { route: ['todo'] }),
    validate: (text) => parseJson(text).route === 'todo',
  },
  {
    id: 'summary.booking', capability: 'summary',
    system: 'Résume en une phrase factuelle sans inventer de détail.',
    user: 'La salle Orion est réservée mardi à 9 heures pour la revue mensuelle.',
    validate: (text) => /Orion/iu.test(text) && /mardi/iu.test(text) && /(?:9|neuf)/iu.test(text),
  },
  {
    id: 'summary.delivery', capability: 'summary',
    system: 'Résume en une phrase factuelle sans inventer de détail.',
    user: 'Le colis 4821 arrivera vendredi entre 14 h et 16 h au point relais République.',
    validate: (text) => /4821/u.test(text) && /vendredi/iu.test(text) && /République/iu.test(text),
  },
  {
    id: 'summary.energy', capability: 'summary',
    system: 'Résume en une phrase factuelle sans inventer de détail.',
    user: 'La consommation du chauffe-eau a baissé de 12 % cette semaine.',
    validate: (text) => /12/u.test(text) && /(baiss|diminu|rédu)/iu.test(text) && /semaine/iu.test(text),
  },
  {
    id: 'agent.todo_create', capability: 'agent',
    system: 'Produis uniquement le plan demandé selon le schéma, sans exécuter l’action.',
    user: 'Ajoute Dentiste à mes tâches.',
    jsonSchema: enumObjectSchema('agent_todo_create', { action: ['create'], domain: ['todo'], title: ['Dentiste'] }),
    validate: (text) => {
      const value = parseJson(text);
      return value.action === 'create' && value.domain === 'todo' && value.title === 'Dentiste';
    },
  },
  {
    id: 'agent.calendar_read', capability: 'agent',
    system: 'Produis uniquement le plan demandé selon le schéma, sans exécuter l’action.',
    user: 'Affiche mon agenda de demain.',
    jsonSchema: enumObjectSchema('agent_calendar_read', { action: ['list'], domain: ['calendar'], period: ['tomorrow'] }),
    validate: (text) => {
      const value = parseJson(text);
      return value.action === 'list' && value.domain === 'calendar' && value.period === 'tomorrow';
    },
  },
  {
    id: 'agent.light_plan', capability: 'agent',
    system: 'Produis uniquement le plan demandé selon le schéma, sans exécuter l’action.',
    user: 'Prépare la commande pour éteindre la lumière du salon.',
    jsonSchema: enumObjectSchema('agent_light_plan', { action: ['turn_off'], domain: ['light'], room: ['salon'] }),
    validate: (text) => {
      const value = parseJson(text);
      return value.action === 'turn_off' && value.domain === 'light' && value.room === 'salon';
    },
  },
  {
    id: 'music.play', capability: 'music',
    system: 'Produis uniquement la décision musicale selon le schéma.',
    user: 'Mets Daft Punk.',
    jsonSchema: enumObjectSchema('music_play', { action: ['play'], query: ['Daft Punk'] }),
    validate: (text) => {
      const value = parseJson(text);
      return value.action === 'play' && value.query === 'Daft Punk';
    },
  },
  {
    id: 'music.pause', capability: 'music',
    system: 'Produis uniquement la décision musicale selon le schéma.',
    user: 'Mets la musique en pause.',
    jsonSchema: enumObjectSchema('music_pause', { action: ['pause'] }),
    validate: (text) => parseJson(text).action === 'pause',
  },
  {
    id: 'music.resume', capability: 'music',
    system: 'Produis uniquement la décision musicale selon le schéma.',
    user: 'Reprends la lecture.',
    jsonSchema: enumObjectSchema('music_resume', { action: ['resume'] }),
    validate: (text) => parseJson(text).action === 'resume',
  },
  {
    id: 'synthesis.weather', capability: 'synthesis',
    system: 'Réponds en français en une phrase, uniquement avec les faits fournis.',
    user: 'Température : 18 °C. Risque de pluie : 70 %. Donne un conseil bref.',
    validate: (text) => /18/u.test(text) && /70/u.test(text) && /(pluie|imperméable|parapluie)/iu.test(text),
  },
  {
    id: 'synthesis.nas', capability: 'synthesis',
    system: 'Réponds en français en une phrase, uniquement avec les faits fournis.',
    user: 'NAS : stockage utilisé 62 %, température 41 °C, état sain. Fais un état bref.',
    validate: (text) => /62/u.test(text) && /41/u.test(text) && /sain/iu.test(text),
  },
  {
    id: 'synthesis.agenda', capability: 'synthesis',
    system: 'Réponds en français en une phrase, uniquement avec les faits fournis.',
    user: 'Agenda : réunion équipe à 10 h, dentiste à 16 h. Fais un rappel bref.',
    validate: (text) => /réunion/iu.test(text) && /dentiste/iu.test(text) && /10/u.test(text) && /16/u.test(text),
  },
];

function metricFor(capability: OpenAiTextCapability): Metric {
  return (getOpenAiTelemetrySnapshot() as Telemetry).capabilities?.[capability] ?? {};
}

function delta(after?: number, before?: number): number {
  return Math.max(0, (after ?? 0) - (before ?? 0));
}

function percentile(values: number[], quantile: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * quantile) - 1)] ?? 0;
}

async function main(): Promise<void> {
  configureOpenAiResilience(env);
  const results: Array<{
    id: string; capability: OpenAiTextCapability; model: string; ok: boolean; latencyMs: number;
    inputTokens: number; outputTokens: number; totalTokens: number; estimatedCostUsd: number | null; error?: string;
  }> = [];

  for (const evaluation of evaluations) {
    const modelConfig = resolveOpenAiCapability(env, evaluation.capability);
    const before = metricFor(evaluation.capability);
    const startedAt = Date.now();
    try {
      const response = await requestOpenAiResponse({
        apiKey: env.OPENAI_API_KEY!, baseUrl: env.OPENAI_BASE_URL, model: modelConfig.model,
        capability: evaluation.capability,
        messages: [{ role: 'system', content: evaluation.system }, { role: 'user', content: evaluation.user }],
        maxOutputTokens: modelConfig.maxOutputTokens, timeoutMs: env.OPENAI_TIMEOUT_MS,
        reasoningEffort: modelConfig.reasoningEffort, jsonSchema: evaluation.jsonSchema,
      });
      const after = metricFor(evaluation.capability);
      const inputTokens = delta(after.inputTokens, before.inputTokens);
      const outputTokens = delta(after.outputTokens, before.outputTokens);
      const totalTokens = delta(after.totalTokens, before.totalTokens);
      const price = PRICES_USD[modelConfig.model.toLowerCase()];
      const estimatedCostUsd = price
        ? Number(((inputTokens * price.inputUsdPerMillion + outputTokens * price.outputUsdPerMillion) / 1_000_000).toFixed(8))
        : null;
      let ok = false;
      try { ok = evaluation.validate(response.text); } catch { ok = false; }
      results.push({ id: evaluation.id, capability: evaluation.capability, model: modelConfig.model, ok,
        latencyMs: Date.now() - startedAt, inputTokens, outputTokens, totalTokens, estimatedCostUsd });
    } catch (error) {
      results.push({ id: evaluation.id, capability: evaluation.capability, model: modelConfig.model, ok: false,
        latencyMs: Date.now() - startedAt, inputTokens: 0, outputTokens: 0, totalTokens: 0, estimatedCostUsd: null,
        error: error instanceof Error ? error.message : 'unknown_error' });
    }
  }

  const capabilities = [...new Set(evaluations.map((item) => item.capability))];
  const byCapability = Object.fromEntries(capabilities.map((capability) => {
    const items = results.filter((item) => item.capability === capability);
    const passed = items.filter((item) => item.ok).length;
    const latencies = items.map((item) => item.latencyMs);
    const costs = items.map((item) => item.estimatedCostUsd).filter((value): value is number => value !== null);
    return [capability, {
      model: items[0]?.model, passed, total: items.length, passRate: passed / items.length,
      latencyMs: { min: Math.min(...latencies), p50: percentile(latencies, 0.50), p95: percentile(latencies, 0.95), max: Math.max(...latencies) },
      inputTokens: items.reduce((sum, item) => sum + item.inputTokens, 0),
      outputTokens: items.reduce((sum, item) => sum + item.outputTokens, 0),
      totalTokens: items.reduce((sum, item) => sum + item.totalTokens, 0),
      estimatedCostUsd: costs.length === items.length ? Number(costs.reduce((sum, value) => sum + value, 0).toFixed(8)) : null,
    }];
  }));

  const passed = results.filter((item) => item.ok).length;
  const qualityGate = passed / results.length >= 0.90
    && Object.values(byCapability).every((item) => item.passRate >= 2 / 3);
  const costs = results.map((item) => item.estimatedCostUsd).filter((value): value is number => value !== null);
  const report = {
    schemaVersion: 1, evaluatedAt: new Date().toISOString(), environment: 'pc', contentLogged: false,
    corpus: { synthetic: true, personalData: false, cases: results.length },
    pricing: { effectiveDate: '2026-10-06', currency: 'USD', source: 'https://developers.openai.com/api/docs/models/compare',
      assumption: 'All input tokens are conservatively priced as uncached input.' },
    gate: { requiredOverallPassRate: 0.90, requiredPerCapabilityPassRate: 2 / 3, passed: qualityGate },
    summary: {
      passed, total: results.length, passRate: passed / results.length,
      latencyMs: { p50: percentile(results.map((item) => item.latencyMs), 0.50), p95: percentile(results.map((item) => item.latencyMs), 0.95), max: Math.max(...results.map((item) => item.latencyMs)) },
      inputTokens: results.reduce((sum, item) => sum + item.inputTokens, 0),
      outputTokens: results.reduce((sum, item) => sum + item.outputTokens, 0),
      totalTokens: results.reduce((sum, item) => sum + item.totalTokens, 0),
      estimatedCostUsd: costs.length === results.length ? Number(costs.reduce((sum, value) => sum + value, 0).toFixed(8)) : null,
    },
    byCapability,
    cases: results,
    telemetry: getOpenAiTelemetrySnapshot(),
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!qualityGate) process.exitCode = 1;
}

void main();
