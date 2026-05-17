import type { WeatherSnapshot } from './weatherSnapshot';

export function isTemperatureQuestion(text: string): boolean { return /temp|degr/i.test(text); }
export function isHumidityQuestion(text: string): boolean { return /humid|hygrom/i.test(text); }
export function isPrecipitationQuestion(text: string): boolean { return /pleu|plu|rain|averse/i.test(text); }
export function isGeneralWeatherQuestion(text: string): boolean { return /temps|météo|meteo|dehors/i.test(text); }
export function isDeterministicWeatherQuestion(text: string): boolean {
  const value = text.toLowerCase();
  if (/demain|semaine|jeudi|dans|quand|habill|va pleuvoir|fera|pleuvra|prévoi|prevoi/i.test(value)) return false;
  return isTemperatureQuestion(value) || isHumidityQuestion(value) || isPrecipitationQuestion(value) || isGeneralWeatherQuestion(value);
}
export function isClearlyLocalWeather(text: string): boolean { return !/paris|lyon|marseille|londres|london|tokyo|florence|rome|venise/i.test(text); }
export function isClearlyExternalWeather(text: string): boolean { return !isClearlyLocalWeather(text); }
export function synthesizeDeterministicWeatherReply(params: { userText: string; weather: WeatherSnapshot; log?: { info: (obj: Record<string, unknown>, msg: string) => void } }): string | null {
  if (!isDeterministicWeatherQuestion(params.userText)) return null;
  const snap = params.weather.current;
  if (!snap) return null;
  if (isTemperatureQuestion(params.userText) && snap.temperature !== undefined) return `Il fait actuellement ${Math.round(snap.temperature)}°C.`;
  if (isHumidityQuestion(params.userText) && snap.humidity !== undefined) return `L'humidité est actuellement de ${Math.round(snap.humidity)}%.`;
  if (isPrecipitationQuestion(params.userText)) return snap.precipitation && snap.precipitation > 0 ? `Il y a ${Math.round(snap.precipitation)}% de chance de pluie actuellement.` : 'Il ne pleut pas actuellement.';
  if (isGeneralWeatherQuestion(params.userText)) return `À ${snap.entityId.replace(/^weather\./, '')} il est ${snap.condition}${snap.temperature !== undefined ? ` (${Math.round(snap.temperature)}°C)` : ''}.`;
  return null;
}
