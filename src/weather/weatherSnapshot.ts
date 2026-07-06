export type HaStateLike = {
  entity_id: string;
  state?: string;
  attributes?: Record<string, unknown>;
};

export type WeatherSnapshot = {
  location: string;
  current?: {
    entityId: string;
    condition: string;
    temperature?: number;
    feelsLike?: number;
    humidity?: number;
    windSpeed?: number;
    windBearing?: number;
    precipitation?: number;
  };
  sensors: Array<{ entityId: string; label?: string; value?: number }>;
  forecast: Array<{
    date: string;
    condition: string;
    temperature?: number;
    tempLow?: number;
    precipitation?: number;
    windSpeed?: number;
  }>;
};

function asFiniteNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

export function buildWeatherSnapshotFromStates(states: HaStateLike[]): WeatherSnapshot | null {
  const weatherEntity = states.find((state) => state.entity_id === 'weather.maison')
    ?? states.find((state) => state.entity_id.startsWith('weather.'));
  const weatherSensors = states.filter((state) =>
    state.entity_id.startsWith('sensor.maison_weather')
    || state.entity_id === 'sensor.maison_temperature'
    || state.entity_id === 'sensor.maison_apparent_temperature'
    || state.entity_id === 'sensor.maison_heat_index_temperature'
    || state.entity_id === 'sensor.maison_humidity'
  );

  if (!weatherEntity && weatherSensors.length === 0) return null;

  const attributes = weatherEntity?.attributes ?? {};
  const forecast = Array.isArray(attributes.forecast) ? attributes.forecast as Array<Record<string, unknown>> : [];
  const location = String(attributes.friendly_name ?? weatherEntity?.entity_id.replace(/^weather\./, '') ?? 'Maison');
  const currentCondition = String(weatherEntity?.state ?? attributes.condition ?? 'nuageux');
  const currentTemperature = asFiniteNumber(attributes.temperature);
  const currentFeelsLike = asFiniteNumber(attributes.apparent_temperature);
  const currentHumidity = asFiniteNumber(attributes.humidity);
  const currentWindSpeed = asFiniteNumber(attributes.wind_speed);
  const currentWindBearing = asFiniteNumber(attributes.wind_bearing);
  const currentPrecipitation = asFiniteNumber(attributes.precipitation_probability);

  return {
    location,
    current: weatherEntity
      ? {
          entityId: weatherEntity.entity_id,
          condition: currentCondition,
          ...(currentTemperature !== undefined ? { temperature: currentTemperature } : {}),
          ...(currentFeelsLike !== undefined ? { feelsLike: currentFeelsLike } : {}),
          ...(currentHumidity !== undefined ? { humidity: currentHumidity } : {}),
          ...(currentWindSpeed !== undefined ? { windSpeed: currentWindSpeed } : {}),
          ...(currentWindBearing !== undefined ? { windBearing: currentWindBearing } : {}),
          ...(currentPrecipitation !== undefined ? { precipitation: currentPrecipitation } : {}),
        }
      : undefined,
    sensors: weatherSensors.map((sensor) => ({
      entityId: sensor.entity_id,
      label: typeof sensor.attributes?.friendly_name === 'string' ? sensor.attributes.friendly_name : undefined,
      value: asFiniteNumber(sensor.state) ?? asFiniteNumber(sensor.attributes?.state),
    })),
    forecast: forecast.slice(0, 7).map((item, index) => ({
      date: typeof item.datetime === 'string' ? item.datetime : new Date(Date.now() + index * 86_400_000).toISOString(),
      condition: String(item.condition ?? currentCondition),
      ...(asFiniteNumber(item.temperature) !== undefined ? { temperature: asFiniteNumber(item.temperature) } : {}),
      ...(asFiniteNumber(item.templow) !== undefined ? { tempLow: asFiniteNumber(item.templow) } : {}),
      ...(asFiniteNumber(item.precipitation_probability) !== undefined
        ? { precipitation: asFiniteNumber(item.precipitation_probability) }
        : asFiniteNumber(item.precipitation) !== undefined
          ? { precipitation: asFiniteNumber(item.precipitation) }
          : {}),
      ...(asFiniteNumber(item.wind_speed) !== undefined ? { windSpeed: asFiniteNumber(item.wind_speed) } : {}),
    })),
  };
}
