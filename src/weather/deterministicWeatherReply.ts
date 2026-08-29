import { LOCAL_WEATHER_ROUTING_CONFIG } from '../routing/deterministic/config/routingDeterministicConfig';
import type { WeatherSnapshot } from './weatherSnapshot';

function normalizeWeatherText(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/gu, '')
    .toLowerCase();
}

export function isTemperatureQuestion(text: string): boolean {
  const normalized = normalizeWeatherText(text);
  return /temp(erature)?\b|fait.*combi|combien.*degr|combien.*il.*fait/iu.test(normalized);
}

export function isHumidityQuestion(text: string): boolean {
  const normalized = normalizeWeatherText(text);
  return /humidite|hygrometrie/iu.test(normalized);
}

export function isPrecipitationQuestion(text: string): boolean {
  const normalized = normalizeWeatherText(text);
  return /pleu|plu|rain|precipitation|goutte|mouille|averse/iu.test(normalized);
}

export function isGeneralWeatherQuestion(text: string): boolean {
  const normalized = normalizeWeatherText(text);
  return /quel.*temps|etat.*meteo|meteo|condition|dehors/iu.test(normalized);
}

export function isDeterministicWeatherQuestion(text: string): boolean {
  const normalized = normalizeWeatherText(text);
  const isComplexQuery = /demain|apres-demain|semaine|prevision|previsions|lundi|mardi|mercredi|jeudi|vendredi|samedi|dimanche|va\s+pleuvoir|fera|pleuvra|dans|quand|comment.*habill/iu.test(normalized);

  if (isComplexQuery) return false;

  return (
    isTemperatureQuestion(normalized)
    || isHumidityQuestion(normalized)
    || isPrecipitationQuestion(normalized)
    || isGeneralWeatherQuestion(normalized)
  );
}

function normalizeRoutingPhrase(text: string): string {
  return normalizeWeatherText(text).replace(/[^a-z0-9]+/giu, ' ').trim().replace(/\s+/gu, ' ');
}

function containsConfiguredPhrase(text: string, values: string[]): boolean {
  const paddedText = ` ${normalizeRoutingPhrase(text)} `;
  return values.some((value) => paddedText.includes(` ${normalizeRoutingPhrase(value)} `));
}

function isWeatherRoutingText(text: string): boolean {
  return containsConfiguredPhrase(text, LOCAL_WEATHER_ROUTING_CONFIG.weatherLexemes)
    || isTemperatureQuestion(text)
    || isHumidityQuestion(text)
    || isPrecipitationQuestion(text)
    || isGeneralWeatherQuestion(text);
}

function hasExplicitLocalMarker(text: string): boolean {
  return containsConfiguredPhrase(text, [
    ...LOCAL_WEATHER_ROUTING_CONFIG.explicitLocalMarkers,
    ...LOCAL_WEATHER_ROUTING_CONFIG.explicitLocalLocationTerms,
  ]);
}

function hasExplicitExternalLocation(text: string): boolean {
  return containsConfiguredPhrase(text, LOCAL_WEATHER_ROUTING_CONFIG.explicitExternalLocations);
}

export function isClearlyLocalWeather(text: string): boolean {
  if (!isWeatherRoutingText(text)) return false;
  return hasExplicitLocalMarker(text) || !hasExplicitExternalLocation(text);
}

export function isClearlyExternalWeather(text: string): boolean {
  if (!isWeatherRoutingText(text) || hasExplicitLocalMarker(text)) return false;
  return hasExplicitExternalLocation(text);
}

function formatTemperature(value: number): string {
  return `${Math.round(value)}°C`;
}

function formatCondition(condition: string): string {
  const normalized = normalizeWeatherText(condition);
  if (/\bsunny\b|ensoleille|clear/iu.test(normalized)) return 'ensoleillé';
  if (/partlycloudy|partly.cloudy|partiellement/iu.test(normalized)) return 'partiellement nuageux';
  if (/cloudy|nuage/iu.test(normalized)) return 'nuageux';
  if (/rain|pluie|averse/iu.test(normalized)) return 'pluvieux';
  if (/snow|neige/iu.test(normalized)) return 'neigeux';
  if (/fog|brouillard/iu.test(normalized)) return 'brumeux';
  return condition.replace(/_/gu, ' ');
}

/**
 * Synthesizes a deterministic weather response for trivial requests.
 * Returns null if the request is not a simple/deterministic weather question.
 */
export function synthesizeDeterministicWeatherReply(params: {
  userText: string;
  weather: WeatherSnapshot;
  log?: { info: (obj: Record<string, unknown>, msg: string) => void };
}): string | null {
  const text = normalizeWeatherText(params.userText).trim();
  const snap = params.weather.current;

  if (!isDeterministicWeatherQuestion(text)) return null;
  if (!snap) return null;

  if (isTemperatureQuestion(text)) {
    if (snap.temperature !== undefined) {
      params.log?.info({ temperature: Math.round(snap.temperature) }, 'weather_deterministic_temperature');
      return `Il fait actuellement ${formatTemperature(snap.temperature)}.`;
    }
  }

  if (isHumidityQuestion(text)) {
    if (snap.humidity !== undefined) {
      const humidity = Math.round(snap.humidity);
      params.log?.info({ humidity }, 'weather_deterministic_humidity');
      return `L'humidité est actuellement de ${humidity}%.`;
    }
  }

  if (isPrecipitationQuestion(text)) {
    if (snap.precipitation !== undefined && snap.precipitation > 0) {
      const proba = Math.round(snap.precipitation);
      params.log?.info({ precipitation: proba }, 'weather_deterministic_precipitation');
      return `Il y a ${proba}% de chance de pluie actuellement.`;
    }

    if (snap.condition) {
      const isRainy = /pluie|rain|averse|ondee/iu.test(normalizeWeatherText(snap.condition));
      const msg = isRainy
        ? 'Il pleut actuellement.'
        : 'Il ne pleut pas actuellement.';
      params.log?.info({ condition: snap.condition }, 'weather_deterministic_condition_precipitation');
      return msg;
    }
  }

  if (isGeneralWeatherQuestion(text)) {
    const location = snap.entityId.replace(/^weather\./u, '').replace(/_/gu, ' ');
    let reply = `À ${location}, `;
    if (snap.condition) {
      reply += `le temps est ${formatCondition(snap.condition)}`;
    }
    if (snap.temperature !== undefined) {
      reply += `, ${formatTemperature(snap.temperature)}`;
    }
    reply += '.';
    params.log?.info({ condition: snap.condition, temperature: snap.temperature }, 'weather_deterministic_general');
    return reply;
  }

  return null;
}
