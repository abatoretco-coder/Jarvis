const PARIS_TIME_ZONE = 'Europe/Paris';

export function getParisLocalDateParts(date = new Date()): { year: number; month: number; day: number } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: PARIS_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const value = (type: string): number => {
    const raw = parts.find((part) => part.type === type)?.value;
    const parsed = raw ? Number.parseInt(raw, 10) : NaN;
    if (!Number.isFinite(parsed)) throw new Error(`invalid_paris_date_part:${type}`);
    return parsed;
  };
  return { year: value('year'), month: value('month'), day: value('day') };
}

export function getParisIsoDate(date = new Date()): string {
  const { year, month, day } = getParisLocalDateParts(date);
  return `${year.toString().padStart(4, '0')}-${month.toString().padStart(2, '0')}-${day.toString().padStart(2, '0')}`;
}

export function formatParisDateTime(date = new Date()): string {
  return date.toLocaleString('fr-FR', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: PARIS_TIME_ZONE,
  });
}

export function formatParisTime(date = new Date()): string {
  return date.toLocaleTimeString('fr-FR', {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: PARIS_TIME_ZONE,
  });
}

function getParisDateTimeParts(date: Date): { year: number; month: number; day: number; hour: number; minute: number; second: number } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: PARIS_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const value = (type: string): number => {
    const raw = parts.find((part) => part.type === type)?.value;
    const parsed = raw ? Number.parseInt(raw, 10) : NaN;
    if (!Number.isFinite(parsed)) throw new Error(`invalid_paris_datetime_part:${type}`);
    return parsed;
  };
  return {
    year: value('year'),
    month: value('month'),
    day: value('day'),
    hour: value('hour'),
    minute: value('minute'),
    second: value('second'),
  };
}

function utcDateFromParisLocalDateTime(year: number, month: number, day: number, hour: number): Date {
  let utcMs = Date.UTC(year, month - 1, day, hour, 0, 0);
  for (let index = 0; index < 3; index += 1) {
    const paris = getParisDateTimeParts(new Date(utcMs));
    const desiredAsUtc = Date.UTC(year, month - 1, day, hour, 0, 0);
    const actualAsUtc = Date.UTC(paris.year, paris.month - 1, paris.day, paris.hour, paris.minute, paris.second);
    const delta = desiredAsUtc - actualAsUtc;
    if (delta === 0) break;
    utcMs += delta;
  }
  return new Date(utcMs);
}

export function getParisStartOfDayUtc(date = new Date(), daysOffset = 0): Date {
  const { year, month, day } = getParisLocalDateParts(date);
  const shifted = new Date(Date.UTC(year, month - 1, day + daysOffset, 12, 0, 0));
  const parts = getParisLocalDateParts(shifted);
  return utcDateFromParisLocalDateTime(parts.year, parts.month, parts.day, 0);
}
