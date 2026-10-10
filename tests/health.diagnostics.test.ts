import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, jest, test } from '@jest/globals';
import Fastify from 'fastify';

import { loadEnv } from '../src/env';
import { registerHealthRoute } from '../src/routes/health';
import { initializeRuntime } from '../src/runtime/initializeRuntime';
import type { AppDeps } from '../src/server';

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function createDatabasePath(initialized: boolean): string {
  const directory = mkdtempSync(join(tmpdir(), 'jarvis-health-'));
  directories.push(directory);
  const databasePath = join(directory, 'conversation.sqlite');
  if (initialized) {
    initializeRuntime(
      loadEnv({ REQUIRE_API_KEY: 'false', CONVERSATION_DB_PATH: databasePath })
    );
  }
  return databasePath;
}

function createDeps(input: {
  databasePath: string;
  homeAssistantProbe?: () => Promise<'ok' | 'unauthorized' | 'unreachable'>;
  spotifyConfigured?: boolean;
  secretMarker?: string;
}): AppDeps {
  const env = loadEnv({
    REQUIRE_API_KEY: 'false',
    CONVERSATION_DB_PATH: input.databasePath,
    HA_BASE_URL: input.homeAssistantProbe ? 'http://homeassistant.test:8123' : undefined,
    HA_TOKEN: input.homeAssistantProbe ? (input.secretMarker ?? 'ha-secret-marker') : undefined,
  });
  return {
    env,
    ...(input.homeAssistantProbe
      ? { ha: { probeHealth: input.homeAssistantProbe } as AppDeps['ha'] }
      : {}),
    spotifyWebApi: {
      isConfigured: () => input.spotifyConfigured ?? false,
    } as AppDeps['spotifyWebApi'],
  };
}

describe('health diagnostics contract', () => {
  test('keeps /health compatible while reporting unavailable Home Assistant', async () => {
    const probeHealth = jest.fn(async () => 'unreachable' as const);
    let nowMs = Date.UTC(2026, 9, 10, 12, 0, 0);
    const databasePath = createDatabasePath(true);
    const app = Fastify({ logger: false });
    registerHealthRoute(
      app,
      createDeps({ databasePath, homeAssistantProbe: probeHealth, secretMarker: 'never-expose-me' }),
      { homeAssistantCacheTtlMs: 100, now: () => nowMs }
    );

    const first = await app.inject({ method: 'GET', url: '/health' });
    const second = await app.inject({ method: 'GET', url: '/health' });

    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({
      status: 'ok',
      contractVersion: '1.0',
      dependencies: { homeassistant: { status: 'unreachable' } },
      diagnostics: {
        status: 'degraded',
        liveness: { status: 'healthy' },
        readiness: { status: 'healthy' },
        dependencies: {
          homeAssistant: {
            status: 'unavailable',
            configured: true,
            reason: 'unreachable',
          },
        },
      },
    });
    expect(second.json().diagnostics.dependencies.homeAssistant.cached).toBe(true);
    expect(probeHealth).toHaveBeenCalledTimes(1);
    nowMs += 101;
    const afterTtl = await app.inject({ method: 'GET', url: '/health' });
    expect(afterTtl.json().diagnostics.dependencies.homeAssistant.cached).toBe(false);
    expect(probeHealth).toHaveBeenCalledTimes(2);
    expect(first.body).not.toContain('never-expose-me');
    expect(first.body).not.toContain(databasePath);
    await app.close();
  });

  test('reports the conversation database as unavailable and makes /ready fail', async () => {
    const app = Fastify({ logger: false });
    registerHealthRoute(app, createDeps({ databasePath: createDatabasePath(false) }));

    const health = await app.inject({ method: 'GET', url: '/health' });
    const ready = await app.inject({ method: 'GET', url: '/ready' });

    expect(health.statusCode).toBe(200);
    expect(health.json().diagnostics).toMatchObject({
      status: 'unavailable',
      readiness: { status: 'unavailable' },
      dependencies: {
        conversationDatabase: {
          status: 'unavailable',
          reason: 'integrity_check_failed',
        },
      },
    });
    expect(ready.statusCode).toBe(503);
    expect(ready.json()).toMatchObject({
      status: 'not_ready',
      dependency: 'database',
      readiness: { status: 'unavailable' },
    });
    await app.close();
  });

  test('distinguishes Spotify configuration from live availability', async () => {
    const app = Fastify({ logger: false });
    registerHealthRoute(app, createDeps({ databasePath: createDatabasePath(true) }));

    const health = await app.inject({ method: 'GET', url: '/health' });

    expect(health.json()).toMatchObject({
      dependencies: { spotifyWebApi: { status: 'not_configured' } },
      diagnostics: {
        dependencies: {
          spotifyWebApi: {
            status: 'not_configured',
            configured: false,
            observedAt: null,
            reason: 'configuration_missing',
          },
        },
      },
    });
    await app.close();
  });

  test('bounds a stalled Home Assistant probe and keeps liveness independent', async () => {
    const probeHealth = jest.fn(() => new Promise<'ok'>(() => undefined));
    const app = Fastify({ logger: false });
    registerHealthRoute(
      app,
      createDeps({ databasePath: createDatabasePath(true), homeAssistantProbe: probeHealth }),
      { homeAssistantTimeoutMs: 10 }
    );

    const live = await app.inject({ method: 'GET', url: '/live' });
    expect(live.statusCode).toBe(200);
    expect(live.json()).toMatchObject({ status: 'healthy', contractVersion: '1.0' });
    expect(probeHealth).not.toHaveBeenCalled();

    const health = await app.inject({ method: 'GET', url: '/health' });
    expect(health.statusCode).toBe(200);
    expect(health.json().diagnostics.dependencies.homeAssistant).toMatchObject({
      status: 'unavailable',
      reason: 'unreachable',
    });
    expect(probeHealth).toHaveBeenCalledTimes(1);
    await app.close();
  });
});
