import type { WeatherSnapshot } from './weatherSnapshot';

export function isTemperatureQuestion(_text: string): boolean { return false; }
export function isHumidityQuestion(_text: string): boolean { return false; }
export function isPrecipitationQuestion(_text: string): boolean { return false; }
export function isGeneralWeatherQuestion(_text: string): boolean { return false; }
export function isDeterministicWeatherQuestion(_text: string): boolean { return false; }
export function isClearlyLocalWeather(_text: string): boolean { return false; }
export function isClearlyExternalWeather(_text: string): boolean { return false; }

export function synthesizeDeterministicWeatherReply(_params: {
  userText: string;
  weather: WeatherSnapshot;
  log?: { info: (obj: Record<string, unknown>, msg: string) => void };
}): string | null {
  return null;
}
