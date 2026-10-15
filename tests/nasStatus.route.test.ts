import { describe, expect, it } from '@jest/globals';
import Fastify from 'fastify';

import type { NasStatus } from '../src/nas/NasStatusClient';
import { registerNasStatusRoute } from '../src/routes/nasStatus';
import type { AppDeps } from '../src/server';

function staleSnapshot(): NasStatus {
  return {
    hostname: 'nas-test',
    generatedAt: '2026-10-15T08:00:00.000Z',
    uptimeSeconds: 3_600,
    load: { one: 0.2, five: 0.3, fifteen: 0.4 },
    memory: { totalBytes: 100, availableBytes: 40, usedPercent: 60 },
    swap: { totalBytes: 0, freeBytes: 0, usedPercent: 0 },
    filesystems: [{ mount: '/', totalBytes: 100, availableBytes: 55, usedPercent: 45 }],
    temperatures: [{ label: 'CPU', celsius: 41 }],
    protocols: [],
    freshness: { state: 'stale', fetchedAt: '2026-10-15T08:01:00.000Z' },
  };
}

describe('GET /v1/nas/status', () => {
  it('preserves the historical payload while exposing stale source freshness', async () => {
    const app = Fastify({ logger: false });
    registerNasStatusRoute(app, {
      nasStatus: {
        isConfigured: () => true,
        getStatus: async () => staleSnapshot(),
      } as AppDeps['nasStatus'],
    } as AppDeps);

    const response = await app.inject({ method: 'GET', url: '/v1/nas/status' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      status: 'ok',
      freshness: { state: 'stale', fetchedAt: '2026-10-15T08:01:00.000Z' },
      nas: {
        hostname: 'nas-test',
        generatedAt: '2026-10-15T08:00:00.000Z',
        disks: [{ mount: '/', totalBytes: 100, availableBytes: 55, usedPercent: 45 }],
      },
    });
    await app.close();
  });
});
