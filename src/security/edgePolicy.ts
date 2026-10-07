import { isIP } from 'node:net';

export function parseTrustedProxyCidrs(raw: string | undefined): string[] {
  if (!raw) return [];
  const values = [
    ...new Set(
      raw
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean)
    ),
  ];
  if (values.length > 16) throw new Error('trusted_proxy_cidrs_invalid');
  for (const value of values) {
    const [address, mask, ...rest] = value.split('/');
    const family = isIP(address ?? '');
    const maxMask = family === 4 ? 32 : family === 6 ? 128 : -1;
    const validMask = mask === undefined || (/^\d{1,3}$/u.test(mask) && Number(mask) <= maxMask);
    if (rest.length > 0 || family === 0 || !validMask) {
      throw new Error('trusted_proxy_cidrs_invalid');
    }
  }
  return values;
}

export function parseAllowedOrigins(raw: string | undefined): Set<string> {
  if (!raw) return new Set();
  return new Set(
    raw
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean)
  );
}
