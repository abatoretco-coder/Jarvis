import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, test } from '@jest/globals';

import { loadEnv } from '../src/env';
import { initializeRuntime } from '../src/runtime/initializeRuntime';
import { buildApp } from '../src/server';

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('server security wiring', () => {
  test('protects home routes even though they are registered before other feature routes', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'jarvis-server-auth-'));
    directories.push(directory);
    const env = loadEnv({
      REQUIRE_API_KEY: 'true',
      API_KEY: 'local-test-api-key',
      CONVERSATION_DB_PATH: join(directory, 'conversation.sqlite'),
    });
    initializeRuntime(env);
    const app = buildApp(env);

    const response = await app.inject({ method: 'GET', url: '/v1/home' });

    expect(response.statusCode).toBe(401);
    await app.close();
  });

  test('applies the public edge policy to health and readiness routes', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'jarvis-server-edge-'));
    directories.push(directory);
    const env = loadEnv({
      REQUIRE_API_KEY: 'true',
      ALLOW_LEGACY_API_KEYS: 'false',
      OIDC_ENABLED: 'true',
      OIDC_ISSUER_URL: 'https://identity.example.test/realms/jarvis',
      OIDC_AUDIENCE: 'jarvis-api',
      PUBLIC_EDGE_ENABLED: 'true',
      PUBLIC_BASE_URL: 'https://jarvis.example.test',
      TRUSTED_PROXY_CIDRS: '127.0.0.1/32',
      EDGE_PROXY_SECRET: 'edge-secret-with-at-least-32-characters',
      CONVERSATION_DB_PATH: join(directory, 'conversation.sqlite'),
    });
    initializeRuntime(env);
    const app = buildApp(env);

    const health = await app.inject({ method: 'GET', url: '/health' });
    const ready = await app.inject({ method: 'GET', url: '/ready' });

    expect(health.statusCode).toBe(403);
    expect(ready.statusCode).toBe(403);
    await app.close();
  });
});
