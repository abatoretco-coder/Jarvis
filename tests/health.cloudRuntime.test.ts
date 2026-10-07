import { describe, expect, test } from '@jest/globals';
import Fastify from 'fastify';

import { loadEnv } from '../src/env';
import { registerHealthRoute } from '../src/routes/health';
import type { AppDeps } from '../src/server';

describe('Phase 1 cloud runtime health contract', () => {
  test('reports cloud providers without exposing credentials or a local fallback', async () => {
    const app = Fastify({ logger: false });
    const env = loadEnv({ REQUIRE_API_KEY: 'false', OPENAI_API_KEY: 'must-not-leak' });
    registerHealthRoute(app, {
      env,
      spotifyWebApi: { isConfigured: () => false },
    } as AppDeps);

    const response = await app.inject({ method: 'GET', url: '/health' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      dependencies: {
        llm: { provider: 'openai', api: 'responses', configured: true },
        voice: { sttProvider: 'openai', ttsProvider: 'openai', configured: true },
      },
    });
    expect(response.json().dependencies.llm).not.toHaveProperty('models');
    expect(response.json().dependencies.llm).not.toHaveProperty('baseUrl');
    expect(response.json().dependencies.llm).not.toHaveProperty('telemetry');
    expect(response.body).not.toContain('must-not-leak');
    expect(response.body).not.toContain('ollama');
    await app.close();
  });
});
