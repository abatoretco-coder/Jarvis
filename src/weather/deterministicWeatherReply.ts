/**
 * Deterministic weather reply synthesis.
 *
 * Combines matchers + snapshot data to produce zero-LLM French TTS-friendly
 * responses for simple current-state weather questions.
 * Returns null for any question that requires LLM synthesis (forecasts, complex).
 */

export {
  isTemperatureQuestion,
  isHumidityQuestion,
  isPrecipitationQuestion,
  isGeneralWeatherQuestion,
  isDeterministicWeatherQuestion,
} from './deterministicWeatherMatchers';

export { isClearlyLocalWeather, isClearlyExternalWeather } from './weatherScope';

import { isDeterministicWeatherQuestion, isTemperatureQuestion, isHumidityQuestion, isPrecipitationQuestion, isGeneralWeatherQuestion } from './deterministicWeatherMatchers';
import type { WeatherSnapshot } from './weatherSnapshot';

type MinLogger = {
  info: (obj: Record<string, unknown>, msg: string) => void;
  warn: (obj: Record<string, unknown>, msg: string) => void;
};

export function synthesizeDeterministicWeatherReply(params: {
  userText: string;
  weather: WeatherSnapshot;
  log?: MinLogger;
}): string | null {
  const { userText, weather } = params;

  if (!isDeterministicWeatherQuestion(userText)) return null;
  if (!weather.current) return null;

  const { condition, temperature, humidity, precipitation } = weather.current;
  const location = weather.location || 'ici';

  // Humidity question (check before general so 'humidité' doesn't match 'temps')
  if (isHumidityQuestion(userText)) {
    if (humidity === undefined) return null;
    return `L'humidité est actuellement de ${Math.round(humidity)}%.`;
  }

  // Precipitation question
  if (isPrecipitationQuestion(userText)) {
    if (precipitation !== undefined) {
      return `${Math.round(precipitation)}% de chance de pluie en ce moment.`;
    }
    // Fall back to condition-based answer
    if (!condition) return null;
    const cond = condition.toLowerCase();
    if (['pluie', 'rain', 'averse', 'storm', 'orage', 'drizzle'].some((w) => cond.includes(w))) {
      return 'Il pleut actuellement.';
    }
    if (['clear', 'ensoleillé', 'sunny', 'dégagé', 'degage'].some((w) => cond.includes(w))) {
      return 'Il ne pleut pas actuellement.';
    }
    return 'Pas de pluie détectée en ce moment.';
  }

  // Specific temperature question (e.g. "quelle température", "il fait combien")
  // but NOT generic "quel temps" (which should go to general weather below).
  // We disambiguate: if isGeneralWeatherQuestion also matches, treat it as a general question.
  if (isTemperatureQuestion(userText) && !isGeneralWeatherQuestion(userText)) {
    if (temperature === undefined) return null;
    return `Il fait actuellement ${Math.round(temperature)}°C.`;
  }

  // General weather question (includes "quel temps", "météo", "dehors", etc.)
  if (isGeneralWeatherQuestion(userText) || isTemperatureQuestion(userText)) {
    if (temperature !== undefined) {
      return `À ${location} il est ${condition} (${Math.round(temperature)}°C).`;
    }
    if (condition) {
      return `À ${location} le temps est ${condition}.`;
    }
    return null;
  }

  return null;
}
