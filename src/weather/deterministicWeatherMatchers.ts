const lower = (text: string): string => text.toLowerCase();

export function isTemperatureQuestion(text: string): boolean {
  const value = lower(text);
  return value.includes('temp') || value.includes('degr') || (value.includes('combien') && value.includes('fait'));
}

export function isHumidityQuestion(text: string): boolean {
  const value = lower(text);
  return value.includes('humid') || value.includes('hygrom');
}

export function isPrecipitationQuestion(text: string): boolean {
  const value = lower(text);
  return ['pleu', 'plui', 'rain', 'averse', 'goutte', 'mouill'].some((needle) => value.includes(needle));
}

export function isGeneralWeatherQuestion(text: string): boolean {
  const value = lower(text);
  return ['temps', 'météo', 'meteo', 'condition', 'dehors'].some((needle) => value.includes(needle));
}

export function isDeterministicWeatherQuestion(text: string): boolean {
  const value = lower(text);
  const future = ['prévi', 'previ', 'demain', 'semaine', 'jeudi', 'quand', 'habill', 'fera', 'pleuvra', 'va faire', 'va pleuvoir'];
  if (future.some((needle) => value.includes(needle))) return false;
  return isTemperatureQuestion(value)
    || isHumidityQuestion(value)
    || isPrecipitationQuestion(value)
    || isGeneralWeatherQuestion(value);
}
