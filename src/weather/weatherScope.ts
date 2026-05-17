export function isClearlyLocalWeather(text: string): boolean {
  const value = text.toLowerCase();
  return value.includes('chez moi') || value.includes('maison') || value.includes('ici') || value.includes('actuellement') || value.includes('maintenant') || !isClearlyExternalWeather(value);
}

export function isClearlyExternalWeather(text: string): boolean {
  const value = text.toLowerCase();
  return value.includes('paris') || value.includes('lyon') || value.includes('marseille') || value.includes('londres') || value.includes('london') || value.includes('tokyo') || value.includes('florence') || value.includes('venise') || value.includes('rome') || value.includes('externe') || value.includes('ailleurs');
}
