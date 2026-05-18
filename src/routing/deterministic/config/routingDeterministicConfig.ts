import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';

import multiIntentLikelihoodRaw from './multiIntentLikelihood.json';
import localWeatherRoutingRaw from './localWeatherRouting.json';
import ingestAckRaw from './ingestAck.json';
import ingestRuntimeTuningRaw from './ingestRuntimeTuning.json';

type MultiIntentWeights = {
  segmentStep: number;
  segmentMax: number;
  extraVerbStep: number;
  extraVerbMax: number;
  markerStep: number;
  markerMax: number;
};

type MultiIntentLikelihoodConfig = {
  coordinationMarkers: string[];
  actionVerbs: string[];
  weights: MultiIntentWeights;
};

type LocalWeatherRoutingConfig = {
  weatherLexemes: string[];
  explicitLocalMarkers: string[];
  explicitLocalLocationTerms: string[];
  externalLocationPrepositions: string[];
  locationArticles: string[];
  explicitExternalLocations: string[];
};

type IngestAckConfig = {
  mailPrefixes: string[];
  todoPrefixes: string[];
  weatherPrefixes: string[];
  searchPrefix: string;
  responses: {
    mailOnly: string;
    todoOnly: string;
    weatherOnly: string;
    searchOnly: string;
    default: string;
  };
};

type IngestRuntimeTuningConfig = {
  conversationRetentionMs: number;
  retentionCleanupIntervalMs: number;
  ttsProviderCacheTtlMs: number;
  ttsCircuitBreakerThreshold: number;
  ttsCircuitBreakerOpenMs: number;
  perfMaxSamples: number;
};

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
}

function toRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function mergeObjects(base: Record<string, unknown>, override: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      result[key] = mergeObjects(toRecord(base[key]), value as Record<string, unknown>);
    } else {
      result[key] = value;
    }
  }
  return result;
}

function parseJsonObject(raw: string): Record<string, unknown> {
  try {
    return toRecord(JSON.parse(raw));
  } catch {
    return {};
  }
}

function loadRoutingConfigOverrides(): Record<string, unknown> {
  const envOverrideRaw = process.env.ROUTING_CONFIG_JSON?.trim();
  const envOverrides = envOverrideRaw ? parseJsonObject(envOverrideRaw) : {};

  const overridePath = process.env.ROUTING_CONFIG_PATH?.trim();
  const fileOverrides = overridePath && existsSync(overridePath)
    ? parseJsonObject(readFileSync(overridePath, 'utf8'))
    : {};

  return mergeObjects(envOverrides, fileOverrides);
}

function applyOverrides<T>(key: string, baseRaw: T, overrides: Record<string, unknown>): Record<string, unknown> {
  return mergeObjects(toRecord(baseRaw), toRecord(overrides[key]));
}

function toNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function parseMultiIntentLikelihoodConfig(raw: unknown): MultiIntentLikelihoodConfig {
  const obj = (raw && typeof raw === 'object') ? raw as Record<string, unknown> : {};
  const weightsRaw = (obj.weights && typeof obj.weights === 'object')
    ? obj.weights as Record<string, unknown>
    : {};

  return {
    coordinationMarkers: toStringArray(obj.coordinationMarkers),
    actionVerbs: toStringArray(obj.actionVerbs),
    weights: {
      segmentStep: toNumber(weightsRaw.segmentStep, 0.18),
      segmentMax: toNumber(weightsRaw.segmentMax, 0.35),
      extraVerbStep: toNumber(weightsRaw.extraVerbStep, 0.16),
      extraVerbMax: toNumber(weightsRaw.extraVerbMax, 0.35),
      markerStep: toNumber(weightsRaw.markerStep, 0.16),
      markerMax: toNumber(weightsRaw.markerMax, 0.45),
    },
  };
}

function parseLocalWeatherRoutingConfig(raw: unknown): LocalWeatherRoutingConfig {
  const obj = toRecord(raw);
  return {
    weatherLexemes: toStringArray(obj.weatherLexemes),
    explicitLocalMarkers: toStringArray(obj.explicitLocalMarkers),
    explicitLocalLocationTerms: toStringArray(obj.explicitLocalLocationTerms),
    externalLocationPrepositions: toStringArray(obj.externalLocationPrepositions),
    locationArticles: toStringArray(obj.locationArticles),
    explicitExternalLocations: toStringArray(obj.explicitExternalLocations),
  };
}

function parseIngestAckConfig(raw: unknown): IngestAckConfig {
  const obj = (raw && typeof raw === 'object') ? raw as Record<string, unknown> : {};
  const responsesRaw = (obj.responses && typeof obj.responses === 'object')
    ? obj.responses as Record<string, unknown>
    : {};

  const searchPrefix = typeof obj.searchPrefix === 'string' && obj.searchPrefix.trim()
    ? obj.searchPrefix.trim()
    : 'search';

  const responseOr = (key: string, fallback: string): string => {
    const value = responsesRaw[key];
    return typeof value === 'string' && value.trim() ? value : fallback;
  };

  return {
    mailPrefixes: toStringArray(obj.mailPrefixes),
    todoPrefixes: toStringArray(obj.todoPrefixes),
    weatherPrefixes: toStringArray(obj.weatherPrefixes),
    searchPrefix,
    responses: {
      mailOnly: responseOr('mailOnly', 'Deux secondes, je consulte tes emails.'),
      todoOnly: responseOr('todoOnly', 'Deux secondes, je regarde tes taches.'),
      weatherOnly: responseOr('weatherOnly', 'Je regarde la meteo, une seconde.'),
      searchOnly: responseOr('searchOnly', 'Je cherche ca, une seconde.'),
      default: responseOr('default', 'Deux secondes, je traite ta demande.'),
    },
  };
}

function parseIngestRuntimeTuningConfig(raw: unknown): IngestRuntimeTuningConfig {
  const obj = (raw && typeof raw === 'object') ? raw as Record<string, unknown> : {};

  return {
    conversationRetentionMs: toNumber(obj.conversationRetentionMs, 7 * 24 * 60 * 60 * 1000),
    retentionCleanupIntervalMs: toNumber(obj.retentionCleanupIntervalMs, 24 * 60 * 60 * 1000),
    ttsProviderCacheTtlMs: toNumber(obj.ttsProviderCacheTtlMs, 15 * 60_000),
    ttsCircuitBreakerThreshold: toNumber(obj.ttsCircuitBreakerThreshold, 3),
    ttsCircuitBreakerOpenMs: toNumber(obj.ttsCircuitBreakerOpenMs, 45_000),
    perfMaxSamples: toNumber(obj.perfMaxSamples, 200),
  };
}

const ROUTING_CONFIG_OVERRIDES = loadRoutingConfigOverrides();

export const MULTI_INTENT_LIKELIHOOD_CONFIG = parseMultiIntentLikelihoodConfig(
  applyOverrides('multiIntentLikelihood', multiIntentLikelihoodRaw, ROUTING_CONFIG_OVERRIDES),
);
export const LOCAL_WEATHER_ROUTING_CONFIG = parseLocalWeatherRoutingConfig(
  applyOverrides('localWeatherRouting', localWeatherRoutingRaw, ROUTING_CONFIG_OVERRIDES),
);
export const INGEST_ACK_CONFIG = parseIngestAckConfig(
  applyOverrides('ingestAck', ingestAckRaw, ROUTING_CONFIG_OVERRIDES),
);
export const INGEST_RUNTIME_TUNING_CONFIG = parseIngestRuntimeTuningConfig(
  applyOverrides('ingestRuntimeTuning', ingestRuntimeTuningRaw, ROUTING_CONFIG_OVERRIDES),
);

export const ROUTING_CONFIG_VERSION = 'routing-config-v1';
export const ROUTING_CONFIG_HASH = createHash('sha256')
  .update(JSON.stringify({
    multiIntentLikelihood: MULTI_INTENT_LIKELIHOOD_CONFIG,
    localWeatherRouting: LOCAL_WEATHER_ROUTING_CONFIG,
    ingestAck: INGEST_ACK_CONFIG,
    ingestRuntimeTuning: INGEST_RUNTIME_TUNING_CONFIG,
  }))
  .digest('hex');
export const SEMANTIC_ROUTER_CONFIG_HASH = createHash('sha256')
  .update(JSON.stringify({
    acceptScore: process.env.SEMANTIC_ROUTER_ACCEPT_SCORE ?? '0.84',
    minMargin: process.env.SEMANTIC_ROUTER_MIN_MARGIN ?? '0.08',
    multiIntentThreshold: process.env.SEMANTIC_ROUTER_MULTI_INTENT_THRESHOLD ?? '0.5',
    highRiskAcceptScore: process.env.SEMANTIC_ROUTER_HIGH_RISK_ACCEPT_SCORE ?? '0.90',
    highRiskMinMargin: process.env.SEMANTIC_ROUTER_HIGH_RISK_MIN_MARGIN ?? '0.12',
    embeddingModel: process.env.SEMANTIC_ROUTER_EMBEDDING_MODEL ?? 'text-embedding-3-small',
  }))
  .digest('hex');
