import type { AdaptiveLightingLevel, AdaptiveLightingPhase, AdaptiveLightingRoomConfig } from './HomeCatalog';

export type AdaptiveLightingTarget = AdaptiveLightingLevel & {
  phase: AdaptiveLightingPhase;
};

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

export function resolveAdaptiveLightingTarget(input: {
  room: AdaptiveLightingRoomConfig;
  mode?: 'on' | 'dimmed';
  now?: Date;
}): AdaptiveLightingTarget {
  const phase = resolveLightingPhase(input.now);
  const mode = input.mode ?? 'on';
  const base = (mode === 'dimmed' ? input.room.dimmedPhases : input.room.phases)[phase];
  return {
    phase,
    brightnessPercent: Math.round(clamp(base.brightnessPercent, 1, 100)),
    colorTemperatureKelvin: Math.round(clamp(base.colorTemperatureKelvin, 2_000, 6_500)),
  };
}
