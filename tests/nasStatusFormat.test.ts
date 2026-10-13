import { describe, expect, it } from '@jest/globals';

import type { NasStatus } from '../src/nas/NasStatusClient';
import { formatNasStatus } from '../src/nas/nasStatusFormat';

const status: NasStatus = {
  hostname: 'nas-test',
  generatedAt: '2026-10-13T10:00:00Z',
  uptimeSeconds: 90_000,
  load: { one: 0.12, five: 0.2, fifteen: 0.3 },
  memory: { totalBytes: 16 * 1024 ** 3, availableBytes: 8 * 1024 ** 3, usedPercent: 50 },
  swap: { totalBytes: 2 * 1024 ** 3, freeBytes: 2 * 1024 ** 3, usedPercent: 0 },
  filesystems: [
    { mount: '/', totalBytes: 100 * 1024 ** 3, availableBytes: 40 * 1024 ** 3, usedPercent: 60 },
    { mount: '/tank', totalBytes: 1000 * 1024 ** 3, availableBytes: 700 * 1024 ** 3, usedPercent: 30 },
  ],
  temperatures: [{ label: 'CPU', celsius: 48 }],
  protocols: [{ name: 'Plex', available: true }],
};

describe('formatNasStatus', () => {
  it('answers a temperature question with temperature first and only', () => {
    expect(formatNasStatus(status, 'Quelle est la température du NAS ?')).toBe('Température : CPU 48°C.');
  });

  it('answers a storage question with the relevant filesystems', () => {
    const response = formatNasStatus(status, 'Combien reste-t-il sur les disques du NAS ?');
    expect(response).toContain('Disque système');
    expect(response).toContain('Stockage tank');
    expect(response).not.toContain('uptime');
  });
});
