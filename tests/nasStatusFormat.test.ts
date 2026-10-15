import { describe, expect, it } from '@jest/globals';

import type { NasStatus } from '../src/nas/NasStatusClient';
import { formatNasStatus, isNasStatusQuery } from '../src/nas/nasStatusFormat';

const status: NasStatus = {
  hostname: 'nas-test',
  generatedAt: '2026-10-13T10:00:00Z',
  uptimeSeconds: 90_000,
  load: { one: 0.12, five: 0.2, fifteen: 0.3 },
  memory: { totalBytes: 16 * 1024 ** 3, availableBytes: 8 * 1024 ** 3, usedPercent: 50 },
  swap: { totalBytes: 2 * 1024 ** 3, freeBytes: 2 * 1024 ** 3, usedPercent: 0 },
  filesystems: [
    { mount: '/', totalBytes: 100 * 1024 ** 3, availableBytes: 40 * 1024 ** 3, usedPercent: 60 },
    {
      mount: '/tank',
      totalBytes: 1000 * 1024 ** 3,
      availableBytes: 700 * 1024 ** 3,
      usedPercent: 30,
    },
  ],
  temperatures: [{ label: 'CPU', celsius: 48 }],
  protocols: [{ name: 'Plex', available: true }],
};

describe('formatNasStatus', () => {
  it('recognizes plural NAS diagnostic questions', () => {
    expect(isNasStatusQuery('Quels services sont disponibles sur le NAS ?')).toBe(true);
    expect(isNasStatusQuery('Quel est le statut des protocoles du NAS ?')).toBe(true);
  });

  it('answers a temperature question with temperature first and only', () => {
    expect(formatNasStatus(status, 'Quelle est la température du NAS ?')).toBe(
      'Température : CPU 48°C.'
    );
  });

  it('answers a storage question with the relevant filesystems', () => {
    const response = formatNasStatus(status, 'Combien reste-t-il sur les disques du NAS ?');
    expect(response).toContain('Disque système');
    expect(response).toContain('Stockage tank');
    expect(response).not.toContain('uptime');
  });

  it('does not describe a tank-only snapshot twice', () => {
    const response = formatNasStatus(
      { ...status, filesystems: [status.filesystems[1]!] },
      'Combien reste-t-il sur les disques du NAS ?'
    );

    expect(response).toBe('Stockage tank 30% utilisé, 700 Go libres.');
  });

  it('does not invent disk or temperature measurements when collections are empty', () => {
    const partial = { ...status, filesystems: [], temperatures: [] };

    expect(formatNasStatus(partial, 'Quel espace reste sur les disques ?')).toBe(
      'Aucune mesure de disque disponible.'
    );
    expect(formatNasStatus(partial, 'Quelle température ?')).toBe(
      'Température non mesurée par le NAS.'
    );
  });

  it('distinguishes unprobed protocols from protocols confirmed unavailable', () => {
    expect(formatNasStatus({ ...status, protocols: [] }, 'Quels services ?')).toBe(
      'Aucun service sondé par le NAS.'
    );
    expect(
      formatNasStatus(
        {
          ...status,
          protocols: [{ name: 'Plex', available: false }],
        },
        'Quels services ?'
      )
    ).toBe('Services sondés mais indisponibles : Plex.');
  });

  it('marks stale measurements in concise French', () => {
    const stale: NasStatus = {
      ...status,
      freshness: { state: 'stale', fetchedAt: '2026-10-15T08:00:00.000Z' },
    };

    expect(formatNasStatus(stale, 'Quelle est la RAM ?')).toBe(
      'Mesure NAS ancienne. RAM utilisée 50% (8 Go sur 16 Go), swap 0%.'
    );
  });
});
