import type {
  AdaptiveLightingConfig,
  AdaptiveLightingLevel,
  AdaptiveLightingPhase,
  AdaptiveLightingRoomConfig,
} from './HomeCatalog';

export type AdaptiveLightingState = {
  state?: string;
  attributes?: Record<string, unknown>;
};

export type AdaptiveLightingTarget = AdaptiveLightingLevel & {
  phase: AdaptiveLightingPhase;
  weatherBrightnessAdjustment: number;
  weatherColorTemperatureAdjustmentKelvin: number;
};

function finiteNumber(value: unknown): number | undefined {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

export function resolveLightingPhase(now = new Date()): AdaptiveLightingPhase {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Paris',
    hour: '2-digit',
    minute: '2-digit',
    weekday: 'short',
    hourCycle: 'h23',
    timeZoneName: 'shortOffset',
  }).formatToParts(now);
  const value = (type: Intl.DateTimeFormatPartTypes): string | undefined =>
    parts.find((part) => part.type === type)?.value;
  const hour = Number(value('hour'));
  const minute = Number(value('minute'));
  const minutes = hour * 60 + minute;
  const isWeekend = ['Sat', 'Sun'].includes(value('weekday') ?? '');
  const dayStart = (isWeekend ? 10 : 9) * 60;
  const isSummerTime = value('timeZoneName')?.replace(':00', '') === 'GMT+2';
  const eveningStart = (isSummerTime ? 20 : 18) * 60;

  if (minutes < 7 * 60 || minutes >= 23 * 60) return 'night';
  if (minutes < dayStart) return 'dawn';
  if (minutes < eveningStart) return 'day';
  return 'dusk';
}

function weatherCloudCoverage(weather: AdaptiveLightingState | undefined): number | undefined {
  const coverage = finiteNumber(weather?.attributes?.cloud_coverage);
  if (coverage !== undefined) return clamp(coverage, 0, 100);
  const condition = String(weather?.state ?? '').toLowerCase();
  if (/sunny|clear/u.test(condition)) return 0;
  if (/partlycloudy|partly.cloudy/u.test(condition)) return 50;
  if (/cloudy|rain|pouring|snow|fog|hail|lightning/u.test(condition)) return 100;
  return undefined;
}

export function resolveWeatherAdjustment(
  weather: AdaptiveLightingState | undefined,
  config: AdaptiveLightingConfig['weather']
): { brightness: number; colorTemperatureKelvin: number } {
  const cloudCoverage = weatherCloudCoverage(weather);
  if (cloudCoverage === undefined) return { brightness: 0, colorTemperatureKelvin: 0 };
  const daylightFactor = clamp((50 - cloudCoverage) / 50, -1, 1);
  return {
    brightness: Math.round(daylightFactor * config.maxBrightnessAdjustment),
    colorTemperatureKelvin: 0,
  };
}

export function resolveAdaptiveLightingTarget(input: {
  room: AdaptiveLightingRoomConfig;
  mode?: 'on' | 'dimmed';
  weatherConfig: AdaptiveLightingConfig['weather'];
  weather?: AdaptiveLightingState;
  now?: Date;
}): AdaptiveLightingTarget {
  const phase = resolveLightingPhase(input.now);
  const mode = input.mode ?? 'on';
  const adjustment = mode === 'on' && phase === 'day'
    ? resolveWeatherAdjustment(input.weather, input.weatherConfig)
    : { brightness: 0, colorTemperatureKelvin: 0 };
  const base = (mode === 'dimmed' ? input.room.dimmedPhases : input.room.phases)[phase];
  return {
    phase,
    brightnessPercent: Math.round(clamp(base.brightnessPercent + adjustment.brightness, 1, 100)),
    colorTemperatureKelvin: Math.round(clamp(
      base.colorTemperatureKelvin + adjustment.colorTemperatureKelvin,
      2_000,
      6_500
    )),
    weatherBrightnessAdjustment: adjustment.brightness,
    weatherColorTemperatureAdjustmentKelvin: adjustment.colorTemperatureKelvin,
  };
}
