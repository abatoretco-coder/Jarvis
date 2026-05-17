import type { WeatherSnapshot } from './weatherSnapshot';

export function isTemperatureQuestion(text: string): boolean {
  return /temp(é?rature)?\b|fait.*combi|combien.*degr|combien.*il.*fait/i.test(text);
}

export function isHumidityQuestion(text: string): boolean {
  return /humidité|hygrométrie/i.test(text);
}

export function isPrecipitationQuestion(text: string): boolean {
  return /pleu|plu|rain|précipitation|goutte|mouillé|averse/i.test(text);
}

export function isGeneralWeatherQuestion(text: string): boolean {
  return /quel.*temps|état.*météo|météo|condition|dehors/i.test(text);
}

export function isDeterministicWeatherQuestion(text: string): boolean {
  const normalized = text.toLowerCase();
  const hasCurrentIndicator = /actuel|maintenant|en ce moment|ici|à la maison|du moment|dehors/i.test(normalized);
  const isComplexQuery = /demain|semaine|jeudi|dans|quand|comment.*habill/i.test(normalized);

  if (isComplexQuery) return false;

  return (
    isTemperatureQuestion(normalized)
    || isHumidityQuestion(normalized)
    || isPrecipitationQuestion(normalized)
    || (isGeneralWeatherQuestion(normalized) && (hasCurrentIndicator || !isComplexQuery))
  );
}

export function isClearlyLocalWeather(text: string): boolean {
  const localIndicators = /chez.*moi|maison|local|actuellement|maintenant|ici|salon|cuisine|chambre|du moment/i;
  const externalLocations = /paris|lyon|marseille|london|tokyo|france|italie|allemagne|espagne|florence|venise|rome/i;

  return localIndicators.test(text) || !externalLocations.test(text);
}

export function isClearlyExternalWeather(text: string): boolean {
  const externalLocations = /paris|lyon|marseille|london|londres|tokyo|france|italie|allemagne|espagne|florence|venise|rome|ville|externe|ailleurs|autre/i;
  return externalLocations.test(text);
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
  const text = params.userText.toLowerCase().trim();
  const snap = params.weather.current;

  if (!snap) return null;

  if (isTemperatureQuestion(text)) {
    if (snap.temperature !== undefined) {
      const temp = Math.round(snap.temperature);
      params.log?.info({ temperature: temp }, 'weather_deterministic_temperature');
      return `Il fait actuellement ${temp}°C.`;
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
      const isRainy = /pluie|rain|averse|ondée/i.test(snap.condition);
      const msg = isRainy
        ? 'Il pleut actuellement.'
        : 'Il ne pleut pas actuellement.';
      params.log?.info({ condition: snap.condition }, 'weather_deterministic_condition_precipitation');
      return msg;
    }
  }

  if (isGeneralWeatherQuestion(text)) {
    let reply = `À ${snap.entityId.replace(/^weather\./, '')} `;
    if (snap.condition) {
      reply += `il est ${snap.condition}`;
    }
    if (snap.temperature !== undefined) {
      const temp = Math.round(snap.temperature);
      reply += ` (${temp}°C)`;
    }
    reply += '.';
    params.log?.info({ condition: snap.condition, temperature: snap.temperature }, 'weather_deterministic_general');
    return reply;
  }

  return null;
}
