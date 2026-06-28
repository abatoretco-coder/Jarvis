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
