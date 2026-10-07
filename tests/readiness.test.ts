import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, test } from '@jest/globals';
import Fastify from 'fastify';

import { loadEnv } from '../src/env';
import { registerHealthRoute } from '../src/routes/health';
import { initializeRuntime } from '../src/runtime/initializeRuntime';
import type { AppDeps } from '../src/server';

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('runtime readiness', () => {
  test('reports ready only after the local database is initialized', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'jarvis-readiness-'));
    directories.push(directory);
    const env = loadEnv({
      REQUIRE_API_KEY: 'false',
      CONVERSATION_DB_PATH: join(directory, 'conversation.sqlite'),
    });
    const app = Fastify({ logger: false });
    registerHealthRoute(app, {
      env,
      spotifyWebApi: { isConfigured: () => false },
    } as AppDeps);

    const before = await app.inject({ method: 'GET', url: '/ready' });
    expect(before.statusCode).toBe(503);

    initializeRuntime(env);
    const after = await app.inject({ method: 'GET', url: '/ready' });
    expect(after.statusCode).toBe(200);
    expect(after.json()).toMatchObject({ status: 'ready', schemaVersion: expect.any(Number) });
    await app.close();
  });
});
