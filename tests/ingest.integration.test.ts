import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import Fastify, { type FastifyInstance } from 'fastify';

import type { Env } from '../src/env';
import { registerIngestRoute } from '../src/routes/ingest';
import type { AppDeps } from '../src/server';
import { routeUserRequest } from '../src/conversation/orchestratorRouter';
import { trySemanticRouter } from '../src/routing/semanticRouter';

jest.mock('../src/conversation/orchestratorRouter', () => {
  const actual = jest.requireActual('../src/conversation/orchestratorRouter') as Record<string, unknown>;
  return {
    ...actual,
    routeUserRequest: jest.fn(),
  };
});
jest.mock('../src/routing/semanticRouter', () => ({
  trySemanticRouter: jest.fn(),
}));

const mockedRouteUserRequest = routeUserRequest as jest.MockedFunction<typeof routeUserRequest>;
const mockedTrySemanticRouter = trySemanticRouter as jest.MockedFunction<typeof trySemanticRouter>;

function makeEnv(dbPath: string, overrides: Partial<Env> = {}): Env {
  const base = {
    HA_BASE_URL: 'http://ha.test:8123',
    HA_TOKEN: 'ha-token',
    HA_TIMEOUT_MS: 300,
    HA_CONVERSATION_MIN_INTERVAL_MS: 0,
    HA_CONVERSATION_RETRY_COUNT: 0,
    HA_CONVERSATION_RETRY_DELAY_MS: 0,
    OPENAI_API_KEY: undefined,
    OPENAI_BASE_URL: 'https://api.openai.com/v1',
    OPENAI_MODEL_ROUTER: 'gpt-4o-mini',
    OPENAI_MODEL_SUMMARY: 'gpt-4o-mini',
    OPENAI_TIMEOUT_MS: 1000,
    ROUTER_TIMEOUT_MS: 500,
    ROUTER_CONFIDENCE_THRESHOLD: 0.7,
    HA_AGENT_GENERAL: 'conversation.openai_conversation',
    HA_AGENT_MAP: 'search.news:search.news:Recherche internet',
    PERPLEXITY_API_KEY: undefined,
    PERPLEXITY_BASE_URL: 'https://api.perplexity.ai',
    LIMIT_K: 10,
    LIMIT_M: 20,
    CONVERSATION_DB_PATH: dbPath,
    CONVERSATION_RECENT_MESSAGES: 10,
    OAUTH_REFRESH_TOKEN_STORE_PATH: join(tmpdir(), 'jarvis-oauth-test.json'),
    MICROSOFT_CLIENT_ID: undefined,
    MICROSOFT_CLIENT_SECRET: undefined,
    MICROSOFT_REFRESH_TOKEN: undefined,
    MICROSOFT_TENANT_ID: 'common',
    GOOGLE_CLIENT_ID: undefined,
    GOOGLE_CLIENT_SECRET: undefined,
    GOOGLE_REFRESH_TOKEN: undefined,
    MAIL_ACCOUNTS_JSON: undefined,
    MAIL_PROVIDER: undefined,
  } as unknown as Env;

  return { ...base, ...overrides } as Env;
}

function makeDeps(env: Env, haStates: unknown[] = []): AppDeps {
  return {
    env,
    ha: {
      getStates: async () => haStates,
    } as AppDeps['ha'],
    spotifyWebApi: {
      isConfigured: () => false,
    } as AppDeps['spotifyWebApi'],
  };
}

function haSpeechResponse(speech: string): Response {
  return new Response(
    JSON.stringify({ response: { speech: { plain: { speech } } } }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

describe('/v1/ingest integration', () => {
  let tempDir: string;
  let app: FastifyInstance;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'jarvis-ingest-test-'));
    app = Fastify({ logger: false });
    mockedRouteUserRequest.mockReset();
    mockedTrySemanticRouter.mockReset();
  });

  afterEach(async () => {
    await app.close();
    (global as { fetch?: unknown }).fetch = undefined;
  });

  it('HA general fallback reuses active thread id in conversation window', async () => {
    const calls: Array<{ conversation_id?: string }> = [];
    (global as { fetch: typeof fetch }).fetch = (async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as { conversation_id?: string };
      calls.push({ conversation_id: body.conversation_id });
      return haSpeechResponse('Réponse HA');
    }) as unknown as typeof fetch;

    const dbPath = join(tempDir, 'conversation.sqlite');
    const env = makeEnv(dbPath, {
      OPENAI_API_KEY: undefined,
      HA_AGENT_MAP: undefined,
    });

    registerIngestRoute(app, makeDeps(env));

    const first = await app.inject({
      method: 'POST',
      url: '/v1/ingest',
      payload: {
        threadId: 'thread-a',
        text: 'bonjour',
        clientContext: { channel: 'desktop' },
      },
    });

    expect(first.statusCode).toBe(200);

    const second = await app.inject({
      method: 'POST',
      url: '/v1/ingest',
      payload: {
        threadId: 'thread-b',
        text: 'quel temps fait-il',
        clientContext: { channel: 'desktop' },
      },
    });

    expect(second.statusCode).toBe(200);

    const secondPayload = second.json() as { threadId: string };
    expect(secondPayload.threadId).toBe('thread-a');
    expect(calls).toHaveLength(2);
    expect(calls[1]?.conversation_id).toBe('thread-a');
  });

  it('weather direct: simple local weather question is deterministic without OpenAI call', async () => {
    const weatherStates = [
      {
        entity_id: 'weather.maison',
        state: 'partiel-nuageux',
        attributes: {
          friendly_name: 'Maison',
          temperature: 18.5,
          humidity: 64,
          precipitation_probability: 15,
        },
      },
    ];

    (global as { fetch: typeof fetch }).fetch = jest.fn() as unknown as typeof fetch;
    mockedRouteUserRequest.mockResolvedValue({
      targets: [{ agentId: 'weather', confidence: 0.99 }],
      reason: 'weather_current_local',
    });

    const dbPath = join(tempDir, 'conversation.sqlite');
    const env = makeEnv(dbPath, {
      OPENAI_API_KEY: 'test-openai-key',
    });

    registerIngestRoute(app, makeDeps(env, weatherStates));

    const res = await app.inject({
      method: 'POST',
      url: '/v1/ingest',
      payload: {
        threadId: 'thread-weather-1',
        text: 'Quelle température chez moi ?',
        clientContext: { channel: 'desktop' },
      },
    });

    expect(res.statusCode).toBe(200);
    const payload = res.json() as { responseText: string };
    expect(payload.responseText).toContain('Il fait actuellement');
    expect(mockedRouteUserRequest).toHaveBeenCalledTimes(1);
    expect((global.fetch as jest.Mock)).not.toHaveBeenCalled();
  });

  it('weather direct: complex query falls back to OpenAI synthesis', async () => {
    const weatherStates = [
      {
        entity_id: 'weather.maison',
        state: 'nuageux',
        attributes: {
          friendly_name: 'Maison',
          temperature: 12,
          humidity: 80,
          precipitation_probability: 60,
          forecast: [{ datetime: '2026-05-18T00:00:00', condition: 'pluie', temperature: 10 }],
        },
      },
    ];

    (global as { fetch: typeof fetch }).fetch = (jest.fn(async (url: string) => {
      expect(url).toContain('/chat/completions');
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: 'Demain prends une veste imperméable et des chaussures fermées.' } }],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as unknown) as typeof fetch;

    mockedRouteUserRequest.mockResolvedValue({
      targets: [{ agentId: 'weather', confidence: 0.99 }],
      reason: 'weather_complex',
    });

    const dbPath = join(tempDir, 'conversation.sqlite');
    const env = makeEnv(dbPath, {
      OPENAI_API_KEY: 'test-openai-key',
    });

    registerIngestRoute(app, makeDeps(env, weatherStates));

    const res = await app.inject({
      method: 'POST',
      url: '/v1/ingest',
      payload: {
        threadId: 'thread-weather-2',
        text: 'Il va pleuvoir demain ?',
        clientContext: { channel: 'desktop' },
      },
    });

    expect(res.statusCode).toBe(200);
    const payload = res.json() as { responseText: string };
    expect(payload.responseText).toContain('veste imperméable');
    expect(mockedRouteUserRequest).toHaveBeenCalledTimes(1);
    expect((global.fetch as jest.Mock)).toHaveBeenCalledTimes(1);
  });

  it('semantic activation: allowed E2 weather route bypasses LLM router', async () => {
    const weatherStates = [
      {
        entity_id: 'weather.maison',
        state: 'partiel-nuageux',
        attributes: {
          friendly_name: 'Maison',
          temperature: 18.5,
          humidity: 64,
          precipitation_probability: 15,
        },
      },
    ];

    mockedTrySemanticRouter.mockResolvedValue({
      accepted: true,
      decision: 'accepted_e2',
      matchedRoute: {
        key: 'weather.current_temperature',
        level: 'E2',
        targetAgentId: 'weather',
        plannerRequired: false,
        directRequest: { domain: 'weather', action: 'current_temperature' },
        examples: ['quelle température chez moi'],
      },
      top1Score: 0.95,
      top2Score: 0.70,
      margin: 0.25,
      top1Intent: 'weather.current_temperature',
      top2Intent: 'weather.current_conditions',
      confidence: 0.95,
    });
    mockedRouteUserRequest.mockRejectedValue(new Error('llm_router_should_not_be_called'));
    (global as { fetch: typeof fetch }).fetch = jest.fn() as unknown as typeof fetch;

    const dbPath = join(tempDir, 'conversation.sqlite');
    const env = makeEnv(dbPath, {
      OPENAI_API_KEY: 'test-openai-key',
      SEMANTIC_ROUTER_ENABLED: true,
      SEMANTIC_ROUTER_SHADOW_MODE: false,
      SEMANTIC_ROUTER_ACTIVATION_ENABLED: true,
      SEMANTIC_ROUTER_ACTIVATED_E2_ROUTES: 'weather.current_temperature',
    });

    registerIngestRoute(app, makeDeps(env, weatherStates));

    const res = await app.inject({
      method: 'POST',
      url: '/v1/ingest',
      payload: {
        threadId: 'thread-semantic-allowed',
        text: 'Quelle température chez moi ?',
        clientContext: { channel: 'desktop' },
      },
    });

    expect(res.statusCode).toBe(200);
    const payload = res.json() as { responseText: string };
    expect(payload.responseText).toContain('Il fait actuellement');
    expect(mockedTrySemanticRouter).toHaveBeenCalledTimes(1);
    expect(mockedRouteUserRequest).not.toHaveBeenCalled();
  });

  it('semantic activation: non-allowlisted E2 route falls back to LLM router', async () => {
    const weatherStates = [
      {
        entity_id: 'weather.maison',
        state: 'partiel-nuageux',
        attributes: {
          friendly_name: 'Maison',
          temperature: 18.5,
          humidity: 64,
          precipitation_probability: 15,
        },
      },
    ];

    mockedTrySemanticRouter.mockResolvedValue({
      accepted: true,
      decision: 'accepted_e2',
      matchedRoute: {
        key: 'weather.current_temperature',
        level: 'E2',
        targetAgentId: 'weather',
        plannerRequired: false,
        directRequest: { domain: 'weather', action: 'current_temperature' },
        examples: ['quelle température chez moi'],
      },
      top1Score: 0.95,
      top2Score: 0.70,
      margin: 0.25,
      top1Intent: 'weather.current_temperature',
      top2Intent: 'weather.current_conditions',
      confidence: 0.95,
    });
    mockedRouteUserRequest.mockResolvedValue({
      targets: [{ agentId: 'weather', confidence: 0.99 }],
      reason: 'llm_weather_route',
    });
    (global as { fetch: typeof fetch }).fetch = jest.fn() as unknown as typeof fetch;

    const dbPath = join(tempDir, 'conversation.sqlite');
    const env = makeEnv(dbPath, {
      OPENAI_API_KEY: 'test-openai-key',
      SEMANTIC_ROUTER_ENABLED: true,
      SEMANTIC_ROUTER_SHADOW_MODE: false,
      SEMANTIC_ROUTER_ACTIVATION_ENABLED: true,
      SEMANTIC_ROUTER_ACTIVATED_E2_ROUTES: 'spotify.pause',
    });

    registerIngestRoute(app, makeDeps(env, weatherStates));

    const res = await app.inject({
      method: 'POST',
      url: '/v1/ingest',
      payload: {
        threadId: 'thread-semantic-not-allowlisted',
        text: 'Quelle température chez moi ?',
        clientContext: { channel: 'desktop' },
      },
    });

    expect(res.statusCode).toBe(200);
    expect(mockedTrySemanticRouter).toHaveBeenCalledTimes(1);
    expect(mockedRouteUserRequest).toHaveBeenCalledTimes(1);
  });

  it('semantic activation: semantic errors fall back to LLM router', async () => {
    mockedTrySemanticRouter.mockRejectedValue(new Error('semantic_router_down'));
    mockedRouteUserRequest.mockResolvedValue({
      targets: [{ agentId: 'search.news', confidence: 0.95 }],
      reason: 'external_weather_forecast',
    });
    (global as { fetch: typeof fetch }).fetch = jest.fn(async () => (
      new Response(
        JSON.stringify({ choices: [{ message: { content: 'Prévision fallback.' } }] }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    )) as unknown as typeof fetch;

    const dbPath = join(tempDir, 'conversation.sqlite');
    const env = makeEnv(dbPath, {
      OPENAI_API_KEY: 'test-openai-key',
      SEMANTIC_ROUTER_ENABLED: true,
      SEMANTIC_ROUTER_SHADOW_MODE: false,
      SEMANTIC_ROUTER_ACTIVATION_ENABLED: true,
      SEMANTIC_ROUTER_ACTIVATED_E2_ROUTES: 'weather.current_temperature',
    });

    registerIngestRoute(app, makeDeps(env, []));

    const res = await app.inject({
      method: 'POST',
      url: '/v1/ingest',
      payload: {
        threadId: 'thread-semantic-error',
        text: 'Meteo a Paris demain',
        clientContext: { channel: 'desktop' },
      },
    });

    expect(res.statusCode).toBe(200);
    expect(mockedTrySemanticRouter).toHaveBeenCalledTimes(1);
    expect(mockedRouteUserRequest).toHaveBeenCalledTimes(1);
  });

  it('structured spotify uses effective thread id and keeps conversation window active', async () => {
    const calls: Array<{ conversation_id?: string }> = [];
    (global as { fetch: typeof fetch }).fetch = (async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as { conversation_id?: string };
      calls.push({ conversation_id: body.conversation_id });
      return haSpeechResponse('Réponse HA après Spotify');
    }) as unknown as typeof fetch;

    const dbPath = join(tempDir, 'conversation.sqlite');
    const env = makeEnv(dbPath, {
      OPENAI_API_KEY: undefined,
      HA_AGENT_MAP: undefined,
    });
    const deps = makeDeps(env);
    deps.spotifyWebApi = {
      isConfigured: () => true,
      getNowPlaying: async () => ({ ok: false, status: 204, error: 'no_active_playback' }),
      scheduleSituationRefresh: jest.fn(),
    } as unknown as AppDeps['spotifyWebApi'];

    registerIngestRoute(app, deps);

    const spotify = await app.inject({
      method: 'POST',
      url: '/v1/ingest',
      payload: {
        threadId: 'thread-spotify-1',
        domain: 'spotify',
        action: 'pause',
        clientContext: { channel: 'desktop' },
      },
    });

    expect(spotify.statusCode).toBe(200);
    const spotifyPayload = spotify.json() as { threadId: string; responseText: string };
    expect(spotifyPayload.threadId).toBe('thread-spotify-1');
    expect(spotifyPayload.responseText).toContain('Rien ne joue actuellement');

    const afterSpotify = await app.inject({
      method: 'POST',
      url: '/v1/ingest',
      payload: {
        threadId: 'thread-after-spotify',
        text: 'bonjour',
        clientContext: { channel: 'desktop' },
      },
    });

    expect(afterSpotify.statusCode).toBe(200);
    const afterSpotifyPayload = afterSpotify.json() as { threadId: string };
    expect(afterSpotifyPayload.threadId).toBe('thread-spotify-1');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.conversation_id).toBe('thread-spotify-1');
  });

  it('search external weather: routes to search.news without HA fallback', async () => {
    const searchReply = 'Demain a Paris, prevois 22 degres avec un risque de pluie en fin de journee.';
    const fetchMock = jest.fn(async (url: string) => {
      expect(url).toContain('/chat/completions');
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: searchReply } }],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });
    (global as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;

    mockedRouteUserRequest.mockResolvedValue({
      targets: [{ agentId: 'search.news', confidence: 0.95 }],
      reason: 'external_weather_forecast',
    });

    const dbPath = join(tempDir, 'conversation.sqlite');
    const env = makeEnv(dbPath, {
      OPENAI_API_KEY: 'test-openai-key',
    });

    registerIngestRoute(app, makeDeps(env, []));

    const res = await app.inject({
      method: 'POST',
      url: '/v1/ingest',
      payload: {
        threadId: 'thread-weather-external',
        text: 'Meteo a Paris demain',
        clientContext: { channel: 'desktop' },
      },
    });

    expect(res.statusCode).toBe(200);
    const payload = res.json() as { responseText: string };
    expect(payload.responseText).toContain('Paris');
    expect(payload.responseText).toContain('22');
    expect(mockedRouteUserRequest).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
