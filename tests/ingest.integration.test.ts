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
import { planSpotifyActionFromTextWithOpenAi } from '../src/spotify/musicAgentPlanner';
import { callTodoAgent } from '../src/todo/todoAgent';
import { callMailAgent } from '../src/mail/mailAgent';

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
jest.mock('../src/spotify/musicAgentPlanner', () => {
  const actual = jest.requireActual('../src/spotify/musicAgentPlanner') as Record<string, unknown>;
  return {
    ...actual,
    planSpotifyActionFromTextWithOpenAi: jest.fn(),
  };
});
jest.mock('../src/todo/todoAgent', () => {
  const actual = jest.requireActual('../src/todo/todoAgent') as Record<string, unknown>;
  return {
    ...actual,
    callTodoAgent: jest.fn(),
  };
});
jest.mock('../src/mail/mailAgent', () => {
  const actual = jest.requireActual('../src/mail/mailAgent') as Record<string, unknown>;
  return {
    ...actual,
    callMailAgent: jest.fn(),
  };
});

const mockedRouteUserRequest = routeUserRequest as jest.MockedFunction<typeof routeUserRequest>;
const mockedTrySemanticRouter = trySemanticRouter as jest.MockedFunction<typeof trySemanticRouter>;
const mockedPlanSpotifyAction = planSpotifyActionFromTextWithOpenAi as jest.MockedFunction<typeof planSpotifyActionFromTextWithOpenAi>;
const mockedCallTodoAgent = callTodoAgent as jest.MockedFunction<typeof callTodoAgent>;
const mockedCallMailAgent = callMailAgent as jest.MockedFunction<typeof callMailAgent>;

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
    mockedPlanSpotifyAction.mockReset();
    mockedCallTodoAgent.mockReset();
    mockedCallMailAgent.mockReset();
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

  it('semantic activation: external weather E2 live bypasses LLM router', async () => {
    const searchReply = 'Demain à Paris: 22°C, ciel variable et pluie faible en soirée.';
    mockedTrySemanticRouter.mockResolvedValue({
      accepted: true,
      decision: 'accepted_e2',
      matchedRoute: {
        key: 'search.news.external_weather',
        level: 'E2',
        targetAgentId: 'search',
        plannerRequired: false,
        directRequest: { domain: 'search.news', action: 'external_weather' },
        examples: ['météo à Paris demain'],
      },
      top1Score: 0.96,
      top2Score: 0.72,
      margin: 0.24,
      top1Intent: 'search.news.external_weather',
      top2Intent: 'search.news.current_news',
      confidence: 0.96,
    });
    mockedRouteUserRequest.mockRejectedValue(new Error('llm_router_should_not_be_called'));
    const fetchMock = jest.fn(async () => (
      new Response(
        JSON.stringify({ choices: [{ message: { content: searchReply } }] }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    ));
    (global as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;

    const dbPath = join(tempDir, 'conversation.sqlite');
    const env = makeEnv(dbPath, {
      OPENAI_API_KEY: 'test-openai-key',
      SEMANTIC_ROUTER_ENABLED: true,
      SEMANTIC_ROUTER_SHADOW_MODE: false,
      SEMANTIC_ROUTER_ACTIVATION_ENABLED: true,
      SEMANTIC_ROUTER_ACTIVATED_E2_ROUTES: 'search.news.external_weather',
    });
    registerIngestRoute(app, makeDeps(env, []));

    const res = await app.inject({
      method: 'POST',
      url: '/v1/ingest',
      payload: {
        threadId: 'thread-semantic-search-weather',
        text: 'Météo à Paris demain',
        clientContext: { channel: 'desktop' },
      },
    });

    expect(res.statusCode).toBe(200);
    const payload = res.json() as { responseText: string };
    expect(payload.responseText).toContain('Paris');
    expect(mockedRouteUserRequest).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('semantic activation: definition E2 live bypasses LLM router', async () => {
    const searchReply = 'Une ZTL est une zone à trafic limité réservée à certains véhicules.';
    mockedTrySemanticRouter.mockResolvedValue({
      accepted: true,
      decision: 'accepted_e2',
      matchedRoute: {
        key: 'search.web.definition',
        level: 'E2',
        targetAgentId: 'search',
        plannerRequired: false,
        directRequest: { domain: 'search.web', action: 'definition' },
        examples: ["c'est quoi"],
      },
      top1Score: 0.95,
      top2Score: 0.71,
      margin: 0.24,
      top1Intent: 'search.web.definition',
      top2Intent: 'search.web.quick_lookup',
      confidence: 0.95,
    });
    mockedRouteUserRequest.mockRejectedValue(new Error('llm_router_should_not_be_called'));
    const fetchMock = jest.fn(async () => (
      new Response(
        JSON.stringify({ choices: [{ message: { content: searchReply } }] }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    ));
    (global as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;

    const dbPath = join(tempDir, 'conversation.sqlite');
    const env = makeEnv(dbPath, {
      OPENAI_API_KEY: 'test-openai-key',
      SEMANTIC_ROUTER_ENABLED: true,
      SEMANTIC_ROUTER_SHADOW_MODE: false,
      SEMANTIC_ROUTER_ACTIVATION_ENABLED: true,
      SEMANTIC_ROUTER_ACTIVATED_E2_ROUTES: 'search.web.definition',
    });
    registerIngestRoute(app, makeDeps(env, []));

    const res = await app.inject({
      method: 'POST',
      url: '/v1/ingest',
      payload: {
        threadId: 'thread-semantic-search-definition',
        text: "C'est quoi une ZTL ?",
        clientContext: { channel: 'desktop' },
      },
    });

    expect(res.statusCode).toBe(200);
    const payload = res.json() as { responseText: string };
    expect(payload.responseText).toContain('zone à trafic limité');
    expect(mockedRouteUserRequest).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('semantic activation: search E2 failure falls back to LLM router', async () => {
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
        key: 'search.web.definition',
        level: 'E2',
        targetAgentId: 'search',
        plannerRequired: false,
        directRequest: { domain: 'search.web', action: 'definition' },
        examples: ["c'est quoi"],
      },
      top1Score: 0.95,
      top2Score: 0.71,
      margin: 0.24,
      top1Intent: 'search.web.definition',
      top2Intent: 'search.web.quick_lookup',
      confidence: 0.95,
    });
    mockedRouteUserRequest.mockResolvedValue({
      targets: [{ agentId: 'weather', confidence: 0.99 }],
      reason: 'llm_weather_route',
    });
    const fetchMock = jest.fn(async () => new Response('search_down', { status: 500 }));
    (global as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;

    const dbPath = join(tempDir, 'conversation.sqlite');
    const env = makeEnv(dbPath, {
      OPENAI_API_KEY: 'test-openai-key',
      SEMANTIC_ROUTER_ENABLED: true,
      SEMANTIC_ROUTER_SHADOW_MODE: false,
      SEMANTIC_ROUTER_ACTIVATION_ENABLED: true,
      SEMANTIC_ROUTER_ACTIVATED_E2_ROUTES: 'search.web.definition',
    });
    registerIngestRoute(app, makeDeps(env, weatherStates));

    const res = await app.inject({
      method: 'POST',
      url: '/v1/ingest',
      payload: {
        threadId: 'thread-semantic-search-fallback',
        text: "C'est quoi une ZTL ?",
        clientContext: { channel: 'desktop' },
      },
    });

    expect(res.statusCode).toBe(200);
    expect(mockedRouteUserRequest).toHaveBeenCalledTimes(1);
  });

  it('semantic router receives raw text even when contextNote is provided', async () => {
    mockedTrySemanticRouter.mockResolvedValue({
      accepted: false,
      decision: 'fallback_llm',
      top1Score: 0.6,
      top2Score: 0.55,
      margin: 0.05,
      top1Intent: 'search.web.definition',
      top2Intent: 'search.web.quick_lookup',
      confidence: 0.6,
      fallbackReason: 'low_score',
    });
    mockedRouteUserRequest.mockResolvedValue({
      targets: [{ agentId: 'search.news', confidence: 0.95 }],
      reason: 'external_weather_forecast',
    });
    (global as { fetch: typeof fetch }).fetch = (jest.fn(async () => (
      new Response(
        JSON.stringify({ choices: [{ message: { content: 'Paris: 20 degres demain.' } }] }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    )) as unknown) as typeof fetch;

    const dbPath = join(tempDir, 'conversation.sqlite');
    const env = makeEnv(dbPath, {
      OPENAI_API_KEY: 'test-openai-key',
      SEMANTIC_ROUTER_ENABLED: true,
      SEMANTIC_ROUTER_SHADOW_MODE: false,
      SEMANTIC_ROUTER_ACTIVATION_ENABLED: true,
      SEMANTIC_ROUTER_ACTIVATED_E2_ROUTES: 'search.web.definition',
    });

    registerIngestRoute(app, makeDeps(env, []));

    const res = await app.inject({
      method: 'POST',
      url: '/v1/ingest',
      payload: {
        threadId: 'thread-semantic-raw-text',
        text: 'C est quoi une ZTL ?',
        contextNote: '[Time: 15:45]',
        clientContext: { channel: 'desktop' },
      },
    });

    expect(res.statusCode).toBe(200);
    expect(mockedTrySemanticRouter).toHaveBeenCalledTimes(1);
    expect(mockedTrySemanticRouter.mock.calls[0]?.[0]?.userText).toBe('C est quoi une ZTL ?');
    expect(mockedRouteUserRequest).toHaveBeenCalledTimes(1);
    expect(mockedRouteUserRequest.mock.calls[0]?.[0]?.text).toContain('Time: 15:45');
    expect(mockedRouteUserRequest.mock.calls[0]?.[0]?.text).toContain('Question utilisateur');
  });

  it('semantic activation: search E2 live emits SSE ack before response', async () => {
    const searchReply = 'Une ZTL est une zone a trafic limite reservee a certains vehicules.';
    mockedTrySemanticRouter.mockResolvedValue({
      accepted: true,
      decision: 'accepted_e2',
      matchedRoute: {
        key: 'search.web.definition',
        level: 'E2',
        targetAgentId: 'search',
        plannerRequired: false,
        directRequest: { domain: 'search.web', action: 'definition' },
        examples: ["c'est quoi"],
      },
      top1Score: 0.95,
      top2Score: 0.71,
      margin: 0.24,
      top1Intent: 'search.web.definition',
      top2Intent: 'search.web.quick_lookup',
      confidence: 0.95,
    });
    mockedRouteUserRequest.mockRejectedValue(new Error('llm_router_should_not_be_called'));
    const fetchMock = jest.fn(async () => (
      new Response(
        JSON.stringify({ choices: [{ message: { content: searchReply } }] }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    ));
    (global as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;

    const dbPath = join(tempDir, 'conversation.sqlite');
    const env = makeEnv(dbPath, {
      OPENAI_API_KEY: 'test-openai-key',
      SEMANTIC_ROUTER_ENABLED: true,
      SEMANTIC_ROUTER_SHADOW_MODE: false,
      SEMANTIC_ROUTER_ACTIVATION_ENABLED: true,
      SEMANTIC_ROUTER_ACTIVATED_E2_ROUTES: 'search.web.definition',
    });
    registerIngestRoute(app, makeDeps(env, []));

    const res = await app.inject({
      method: 'POST',
      url: '/v1/ingest?sse=1',
      headers: {
        accept: 'text/event-stream',
      },
      payload: {
        threadId: 'thread-semantic-search-sse',
        text: "C'est quoi une ZTL ?",
        clientContext: { channel: 'desktop' },
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/event-stream');
    const body = res.body;
    const ackPos = body.indexOf('event: ack');
    const responsePos = body.indexOf('event: response');
    expect(ackPos).toBeGreaterThanOrEqual(0);
    expect(responsePos).toBeGreaterThanOrEqual(0);
    expect(ackPos).toBeLessThan(responsePos);
    expect(body).toContain('Je cherche ca, une seconde.');
    expect(body).toContain('zone a trafic limite');
    expect(mockedRouteUserRequest).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('semantic E1 live: search.deep.comparison bypasses LLM router and persists messages', async () => {
    mockedTrySemanticRouter.mockResolvedValue({
      accepted: true,
      decision: 'accepted_e1',
      matchedRoute: {
        key: 'search.deep.comparison',
        level: 'E1',
        targetAgentId: 'search',
        plannerRequired: true,
        directRequest: { domain: 'search.deep', action: 'comparison' },
        examples: ['compare f22 et f35'],
      },
      top1Score: 0.94,
      top2Score: 0.74,
      margin: 0.2,
      top1Intent: 'search.deep.comparison',
      top2Intent: 'search.web.quick_lookup',
      confidence: 0.94,
    });
    mockedRouteUserRequest.mockRejectedValue(new Error('llm_router_should_not_be_called'));
    const fetchMock = jest.fn(async (url: string) => {
      if (url.includes('/chat/completions')) {
        return new Response(
          JSON.stringify({ choices: [{ message: { content: 'F-22: superiorite aerienne. F-35: multirole et fusion capteurs.' } }] }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return haSpeechResponse('Réponse HA');
    });
    (global as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;

    const dbPath = join(tempDir, 'conversation.sqlite');
    const env = makeEnv(dbPath, {
      OPENAI_API_KEY: 'test-openai-key',
      SEMANTIC_ROUTER_ENABLED: true,
      SEMANTIC_ROUTER_SHADOW_MODE: false,
      SEMANTIC_ROUTER_E1_ACTIVATION_ENABLED: true,
      SEMANTIC_ROUTER_ACTIVATED_E1_ROUTES: 'search.deep.comparison',
    });
    registerIngestRoute(app, makeDeps(env, []));

    const res = await app.inject({
      method: 'POST',
      url: '/v1/ingest',
      payload: {
        threadId: 'thread-semantic-e1-search',
        text: 'Compare F-22 et F-35',
        clientContext: { channel: 'desktop' },
      },
    });

    expect(res.statusCode).toBe(200);
    const payload = res.json() as { threadId: string; responseText: string };
    expect(payload.threadId).toBe('thread-semantic-e1-search');
    expect(payload.responseText).toContain('F-22');
    expect(mockedRouteUserRequest).not.toHaveBeenCalled();

    const history = await app.inject({
      method: 'GET',
      url: '/v1/threads/thread-semantic-e1-search/history?limit=10',
    });
    expect(history.statusCode).toBe(200);
    const historyPayload = history.json() as { messages: Array<{ role: string; text: string }> };
    expect(historyPayload.messages.some((m) => m.role === 'user' && m.text.includes('Compare F-22 et F-35'))).toBe(true);
    expect(historyPayload.messages.some((m) => m.role === 'assistant' && m.text.includes('F-22'))).toBe(true);

    mockedTrySemanticRouter.mockResolvedValueOnce({
      accepted: false,
      decision: 'fallback_llm',
      top1Score: 0.5,
      top2Score: 0.45,
      margin: 0.05,
      top1Intent: 'search.web.quick_lookup',
      top2Intent: 'search.news.current_news',
      confidence: 0.5,
      fallbackReason: 'low_score',
    });
    mockedRouteUserRequest.mockResolvedValueOnce({
      targets: [],
      reason: 'none',
    });
    const second = await app.inject({
      method: 'POST',
      url: '/v1/ingest',
      payload: {
        threadId: 'thread-other-id',
        text: 'bonjour',
        clientContext: { channel: 'desktop' },
      },
    });
    expect(second.statusCode).toBe(200);
    const secondPayload = second.json() as { threadId: string };
    expect(secondPayload.threadId).toBe('thread-semantic-e1-search');
  });

  it('semantic E1 live: spotify.search_and_play bypasses LLM router and avoids double planning', async () => {
    mockedTrySemanticRouter.mockResolvedValue({
      accepted: true,
      decision: 'accepted_e1',
      matchedRoute: {
        key: 'spotify.search_and_play',
        level: 'E1',
        targetAgentId: 'spotify',
        plannerRequired: true,
        directRequest: { domain: 'spotify', action: 'search_and_play' },
        examples: ['mets du jazz'],
      },
      top1Score: 0.95,
      top2Score: 0.7,
      margin: 0.25,
      top1Intent: 'spotify.search_and_play',
      top2Intent: 'spotify.search',
      confidence: 0.95,
    });
    mockedRouteUserRequest.mockRejectedValue(new Error('llm_router_should_not_be_called'));
    mockedPlanSpotifyAction.mockResolvedValue({
      route: 'spotify',
      reason: 'planner_ok',
      request: {
        domain: 'spotify',
        action: 'pause',
        slots: {},
        text: 'Mets du jazz au salon',
      },
    });

    const dbPath = join(tempDir, 'conversation.sqlite');
    const env = makeEnv(dbPath, {
      OPENAI_API_KEY: 'test-openai-key',
      SEMANTIC_ROUTER_ENABLED: true,
      SEMANTIC_ROUTER_SHADOW_MODE: false,
      SEMANTIC_ROUTER_E1_ACTIVATION_ENABLED: true,
      SEMANTIC_ROUTER_ACTIVATED_E1_ROUTES: 'spotify.search_and_play',
    });
    const deps = makeDeps(env, []);
    deps.spotifyWebApi = {
      isConfigured: () => true,
      getNowPlaying: async () => ({ ok: false, status: 204, error: 'no_active_playback' }),
      scheduleSituationRefresh: jest.fn(),
    } as unknown as AppDeps['spotifyWebApi'];
    registerIngestRoute(app, deps);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/ingest',
      payload: {
        threadId: 'thread-semantic-e1-spotify',
        text: 'Mets du jazz au salon',
        clientContext: { channel: 'desktop' },
      },
    });

    expect(res.statusCode).toBe(200);
    const payload = res.json() as { responseText: string; planner?: { source?: string; route?: string } };
    expect(payload.responseText).toContain('Rien ne joue actuellement');
    expect(payload.planner?.source).toBe('openai_music_agent');
    expect(payload.planner?.route).toBe('spotify');
    expect(mockedPlanSpotifyAction).toHaveBeenCalledTimes(1);
    expect(mockedRouteUserRequest).not.toHaveBeenCalled();
  });

  it('semantic E1 accepted but not allowlisted falls back to LLM router', async () => {
    mockedTrySemanticRouter.mockResolvedValue({
      accepted: true,
      decision: 'accepted_e1',
      matchedRoute: {
        key: 'spotify.transfer',
        level: 'E1',
        targetAgentId: 'spotify',
        plannerRequired: true,
        directRequest: { domain: 'spotify', action: 'transfer' },
        examples: ['mets la musique au salon'],
      },
      top1Score: 0.93,
      top2Score: 0.68,
      margin: 0.25,
      top1Intent: 'spotify.transfer',
      top2Intent: 'spotify.search_and_play',
      confidence: 0.93,
    });
    mockedRouteUserRequest.mockResolvedValue({
      targets: [{ agentId: 'search.news', confidence: 0.95 }],
      reason: 'external_weather_forecast',
    });
    const fetchMock = jest.fn(async () => (
      new Response(
        JSON.stringify({ choices: [{ message: { content: 'Fallback LLM ok.' } }] }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    ));
    (global as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;

    const dbPath = join(tempDir, 'conversation.sqlite');
    const env = makeEnv(dbPath, {
      OPENAI_API_KEY: 'test-openai-key',
      SEMANTIC_ROUTER_ENABLED: true,
      SEMANTIC_ROUTER_SHADOW_MODE: false,
      SEMANTIC_ROUTER_E1_ACTIVATION_ENABLED: true,
      SEMANTIC_ROUTER_ACTIVATED_E1_ROUTES: '',
    });
    registerIngestRoute(app, makeDeps(env, []));

    const res = await app.inject({
      method: 'POST',
      url: '/v1/ingest',
      payload: {
        threadId: 'thread-semantic-e1-not-allowlisted',
        text: 'Mets la musique sur le salon',
        clientContext: { channel: 'desktop' },
      },
    });

    expect(res.statusCode).toBe(200);
    expect(mockedRouteUserRequest).toHaveBeenCalledTimes(1);
    expect(mockedPlanSpotifyAction).not.toHaveBeenCalled();
  });

  it('semantic E1 search.deep error falls back to LLM router', async () => {
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
      decision: 'accepted_e1',
      matchedRoute: {
        key: 'search.deep.analysis',
        level: 'E1',
        targetAgentId: 'search',
        plannerRequired: true,
        directRequest: { domain: 'search.deep', action: 'analysis' },
        examples: ['analyse ce sujet'],
      },
      top1Score: 0.94,
      top2Score: 0.7,
      margin: 0.24,
      top1Intent: 'search.deep.analysis',
      top2Intent: 'search.web.quick_lookup',
      confidence: 0.94,
    });
    mockedRouteUserRequest.mockResolvedValue({
      targets: [{ agentId: 'weather', confidence: 0.99 }],
      reason: 'llm_weather_route',
    });
    const fetchMock = jest.fn(async () => new Response('search_down', { status: 500 }));
    (global as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;

    const dbPath = join(tempDir, 'conversation.sqlite');
    const env = makeEnv(dbPath, {
      OPENAI_API_KEY: 'test-openai-key',
      SEMANTIC_ROUTER_ENABLED: true,
      SEMANTIC_ROUTER_SHADOW_MODE: false,
      SEMANTIC_ROUTER_E1_ACTIVATION_ENABLED: true,
      SEMANTIC_ROUTER_ACTIVATED_E1_ROUTES: 'search.deep.analysis',
    });
    registerIngestRoute(app, makeDeps(env, weatherStates));

    const res = await app.inject({
      method: 'POST',
      url: '/v1/ingest',
      payload: {
        threadId: 'thread-semantic-e1-search-error',
        text: 'Analyse ce sujet',
        clientContext: { channel: 'desktop' },
      },
    });

    expect(res.statusCode).toBe(200);
    const payload = res.json() as { responseText: string };
    expect(payload.responseText).toContain('Je n’ai pas pu joindre l’agent Home Assistant');
    expect(mockedRouteUserRequest).toHaveBeenCalledTimes(1);
  });

  it('semantic E1 live: todo.list_tasks.today bypasses LLM router and keeps normal persistence/window', async () => {
    mockedTrySemanticRouter.mockResolvedValue({
      accepted: true,
      decision: 'accepted_e1',
      matchedRoute: {
        key: 'todo.list_tasks.today',
        level: 'E1',
        targetAgentId: 'todo',
        plannerRequired: true,
        directRequest: { domain: 'todo', action: 'list_tasks.today' },
        examples: ['mes taches aujourd hui'],
      },
      top1Score: 0.95,
      top2Score: 0.72,
      margin: 0.23,
      top1Intent: 'todo.list_tasks.today',
      top2Intent: 'todo.list_tasks',
      confidence: 0.95,
    });
    mockedRouteUserRequest.mockRejectedValue(new Error('llm_router_should_not_be_called'));
    mockedCallTodoAgent.mockResolvedValue('Tu as 3 taches prevues aujourd hui.');

    const dbPath = join(tempDir, 'conversation.sqlite');
    const env = makeEnv(dbPath, {
      OPENAI_API_KEY: 'test-openai-key',
      SEMANTIC_ROUTER_ENABLED: true,
      SEMANTIC_ROUTER_SHADOW_MODE: false,
      SEMANTIC_ROUTER_E1_ACTIVATION_ENABLED: true,
      SEMANTIC_ROUTER_ACTIVATED_E1_ROUTES: 'todo.list_tasks.today',
    });
    registerIngestRoute(app, makeDeps(env, []));

    const res = await app.inject({
      method: 'POST',
      url: '/v1/ingest',
      payload: {
        threadId: 'thread-semantic-e1-todo-live',
        text: "Quelles sont mes taches d'aujourd'hui ?",
        clientContext: { channel: 'desktop' },
      },
    });

    expect(res.statusCode).toBe(200);
    const payload = res.json() as { threadId: string; responseText: string };
    expect(payload.threadId).toBe('thread-semantic-e1-todo-live');
    expect(payload.responseText).toContain('3 taches');
    expect(mockedCallTodoAgent).toHaveBeenCalledTimes(1);
    expect(mockedRouteUserRequest).not.toHaveBeenCalled();

    const history = await app.inject({
      method: 'GET',
      url: '/v1/threads/thread-semantic-e1-todo-live/history?limit=10',
    });
    expect(history.statusCode).toBe(200);
    const historyPayload = history.json() as { messages: Array<{ role: string; text: string }> };
    expect(historyPayload.messages.some((m) => m.role === 'assistant' && m.text.includes('3 taches'))).toBe(true);

    (global as { fetch: typeof fetch }).fetch = (async () => haSpeechResponse('Réponse HA')) as unknown as typeof fetch;
    mockedTrySemanticRouter.mockResolvedValueOnce({
      accepted: false,
      decision: 'fallback_llm',
      top1Score: 0.5,
      top2Score: 0.45,
      margin: 0.05,
      top1Intent: 'search.news.current_news',
      top2Intent: 'search.web.quick_lookup',
      confidence: 0.5,
      fallbackReason: 'low_score',
    });
    mockedRouteUserRequest.mockResolvedValueOnce({
      targets: [],
      reason: 'none',
    });
    const second = await app.inject({
      method: 'POST',
      url: '/v1/ingest',
      payload: {
        threadId: 'thread-other-after-todo',
        text: 'bonjour',
        clientContext: { channel: 'desktop' },
      },
    });
    expect(second.statusCode).toBe(200);
    const secondPayload = second.json() as { threadId: string };
    expect(secondPayload.threadId).toBe('thread-semantic-e1-todo-live');
  });

  it('semantic E1 live: mail.list_inbox.unread bypasses LLM router', async () => {
    mockedTrySemanticRouter.mockResolvedValue({
      accepted: true,
      decision: 'accepted_e1',
      matchedRoute: {
        key: 'mail.list_inbox.unread',
        level: 'E1',
        targetAgentId: 'mail',
        plannerRequired: true,
        directRequest: { domain: 'mail', action: 'list_inbox.unread' },
        examples: ['mails non lus'],
      },
      top1Score: 0.95,
      top2Score: 0.71,
      margin: 0.24,
      top1Intent: 'mail.list_inbox.unread',
      top2Intent: 'mail.list_inbox',
      confidence: 0.95,
    });
    mockedRouteUserRequest.mockRejectedValue(new Error('llm_router_should_not_be_called'));
    mockedCallMailAgent.mockResolvedValue('Tu as 2 mails non lus.');

    const dbPath = join(tempDir, 'conversation.sqlite');
    const env = makeEnv(dbPath, {
      OPENAI_API_KEY: 'test-openai-key',
      SEMANTIC_ROUTER_ENABLED: true,
      SEMANTIC_ROUTER_SHADOW_MODE: false,
      SEMANTIC_ROUTER_E1_ACTIVATION_ENABLED: true,
      SEMANTIC_ROUTER_ACTIVATED_E1_ROUTES: 'mail.list_inbox.unread',
    });
    registerIngestRoute(app, makeDeps(env, []));

    const res = await app.inject({
      method: 'POST',
      url: '/v1/ingest',
      payload: {
        threadId: 'thread-semantic-e1-mail-unread',
        text: 'J ai des mails non lus ?',
        clientContext: { channel: 'desktop' },
      },
    });

    expect(res.statusCode).toBe(200);
    const payload = res.json() as { responseText: string };
    expect(payload.responseText).toContain('2 mails non lus');
    expect(mockedCallMailAgent).toHaveBeenCalledTimes(1);
    expect(mockedRouteUserRequest).not.toHaveBeenCalled();
  });

  it('semantic E1 live: mail.search_emails bypasses LLM router', async () => {
    mockedTrySemanticRouter.mockResolvedValue({
      accepted: true,
      decision: 'accepted_e1',
      matchedRoute: {
        key: 'mail.search_emails',
        level: 'E1',
        targetAgentId: 'mail',
        plannerRequired: true,
        directRequest: { domain: 'mail', action: 'search_emails' },
        examples: ['trouve les mails de thomas'],
      },
      top1Score: 0.94,
      top2Score: 0.7,
      margin: 0.24,
      top1Intent: 'mail.search_emails',
      top2Intent: 'mail.list_inbox',
      confidence: 0.94,
    });
    mockedRouteUserRequest.mockRejectedValue(new Error('llm_router_should_not_be_called'));
    mockedCallMailAgent.mockResolvedValue('J ai retrouve 1 mail de Thomas au sujet du devis.');

    const dbPath = join(tempDir, 'conversation.sqlite');
    const env = makeEnv(dbPath, {
      OPENAI_API_KEY: 'test-openai-key',
      SEMANTIC_ROUTER_ENABLED: true,
      SEMANTIC_ROUTER_SHADOW_MODE: false,
      SEMANTIC_ROUTER_E1_ACTIVATION_ENABLED: true,
      SEMANTIC_ROUTER_ACTIVATED_E1_ROUTES: 'mail.search_emails',
    });
    registerIngestRoute(app, makeDeps(env, []));

    const res = await app.inject({
      method: 'POST',
      url: '/v1/ingest',
      payload: {
        threadId: 'thread-semantic-e1-mail-search',
        text: 'Retrouve mes mails de Thomas sur le devis.',
        clientContext: { channel: 'desktop' },
      },
    });

    expect(res.statusCode).toBe(200);
    const payload = res.json() as { responseText: string };
    expect(payload.responseText).toContain('Thomas');
    expect(mockedCallMailAgent).toHaveBeenCalledTimes(1);
    expect(mockedRouteUserRequest).not.toHaveBeenCalled();
  });

  it('semantic E1 write route todo.add_task is not activated when not allowlisted', async () => {
    mockedTrySemanticRouter.mockResolvedValue({
      accepted: true,
      decision: 'accepted_e1',
      matchedRoute: {
        key: 'todo.add_task',
        level: 'E1',
        targetAgentId: 'todo',
        plannerRequired: true,
        directRequest: { domain: 'todo', action: 'add_task' },
        examples: ['ajoute une tache'],
      },
      top1Score: 0.92,
      top2Score: 0.69,
      margin: 0.23,
      top1Intent: 'todo.add_task',
      top2Intent: 'todo.list_tasks',
      confidence: 0.92,
    });
    mockedRouteUserRequest.mockResolvedValue({
      targets: [{ agentId: 'search.news', confidence: 0.95 }],
      reason: 'external_weather_forecast',
    });
    (global as { fetch: typeof fetch }).fetch = (jest.fn(async () => (
      new Response(
        JSON.stringify({ choices: [{ message: { content: 'Fallback LLM ok.' } }] }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    )) as unknown) as typeof fetch;

    const dbPath = join(tempDir, 'conversation.sqlite');
    const env = makeEnv(dbPath, {
      OPENAI_API_KEY: 'test-openai-key',
      SEMANTIC_ROUTER_ENABLED: true,
      SEMANTIC_ROUTER_SHADOW_MODE: false,
      SEMANTIC_ROUTER_E1_ACTIVATION_ENABLED: true,
      SEMANTIC_ROUTER_ACTIVATED_E1_ROUTES: '',
    });
    registerIngestRoute(app, makeDeps(env, []));

    const res = await app.inject({
      method: 'POST',
      url: '/v1/ingest',
      payload: {
        threadId: 'thread-semantic-e1-todo-write-not-allowlisted',
        text: 'Ajoute acheter du pain',
        clientContext: { channel: 'desktop' },
      },
    });

    expect(res.statusCode).toBe(200);
    expect(mockedRouteUserRequest).toHaveBeenCalledTimes(1);
    expect(mockedCallTodoAgent).not.toHaveBeenCalled();
  });

  it('semantic E1 todo/mail agent error falls back to LLM router', async () => {
    mockedTrySemanticRouter.mockResolvedValue({
      accepted: true,
      decision: 'accepted_e1',
      matchedRoute: {
        key: 'mail.search_emails',
        level: 'E1',
        targetAgentId: 'mail',
        plannerRequired: true,
        directRequest: { domain: 'mail', action: 'search_emails' },
        examples: ['cherche mes mails'],
      },
      top1Score: 0.94,
      top2Score: 0.7,
      margin: 0.24,
      top1Intent: 'mail.search_emails',
      top2Intent: 'mail.list_inbox',
      confidence: 0.94,
    });
    mockedCallMailAgent.mockRejectedValue(new Error('mail_unavailable'));
    mockedRouteUserRequest.mockResolvedValue({
      targets: [{ agentId: 'search.news', confidence: 0.95 }],
      reason: 'external_weather_forecast',
    });
    (global as { fetch: typeof fetch }).fetch = (jest.fn(async () => (
      new Response(
        JSON.stringify({ choices: [{ message: { content: 'Fallback LLM après erreur mail.' } }] }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    )) as unknown) as typeof fetch;

    const dbPath = join(tempDir, 'conversation.sqlite');
    const env = makeEnv(dbPath, {
      OPENAI_API_KEY: 'test-openai-key',
      SEMANTIC_ROUTER_ENABLED: true,
      SEMANTIC_ROUTER_SHADOW_MODE: false,
      SEMANTIC_ROUTER_E1_ACTIVATION_ENABLED: true,
      SEMANTIC_ROUTER_ACTIVATED_E1_ROUTES: 'mail.search_emails',
    });
    registerIngestRoute(app, makeDeps(env, []));

    const res = await app.inject({
      method: 'POST',
      url: '/v1/ingest',
      payload: {
        threadId: 'thread-semantic-e1-mail-error-fallback',
        text: 'Cherche mes mails de Thomas',
        clientContext: { channel: 'desktop' },
      },
    });

    expect(res.statusCode).toBe(200);
    expect(mockedRouteUserRequest).toHaveBeenCalledTimes(1);
  });

  it('semantic E1 live mail.search_emails emits SSE ack before response', async () => {
    mockedTrySemanticRouter.mockResolvedValue({
      accepted: true,
      decision: 'accepted_e1',
      matchedRoute: {
        key: 'mail.search_emails',
        level: 'E1',
        targetAgentId: 'mail',
        plannerRequired: true,
        directRequest: { domain: 'mail', action: 'search_emails' },
        examples: ['cherche mail'],
      },
      top1Score: 0.95,
      top2Score: 0.72,
      margin: 0.23,
      top1Intent: 'mail.search_emails',
      top2Intent: 'mail.list_inbox',
      confidence: 0.95,
    });
    mockedRouteUserRequest.mockRejectedValue(new Error('llm_router_should_not_be_called'));
    mockedCallMailAgent.mockResolvedValue('J ai trouve 2 emails sur le devis.');

    const dbPath = join(tempDir, 'conversation.sqlite');
    const env = makeEnv(dbPath, {
      OPENAI_API_KEY: 'test-openai-key',
      SEMANTIC_ROUTER_ENABLED: true,
      SEMANTIC_ROUTER_SHADOW_MODE: false,
      SEMANTIC_ROUTER_E1_ACTIVATION_ENABLED: true,
      SEMANTIC_ROUTER_ACTIVATED_E1_ROUTES: 'mail.search_emails',
    });
    registerIngestRoute(app, makeDeps(env, []));

    const res = await app.inject({
      method: 'POST',
      url: '/v1/ingest?sse=1',
      headers: {
        accept: 'text/event-stream',
      },
      payload: {
        threadId: 'thread-semantic-e1-mail-sse',
        text: 'Retrouve mes mails de Thomas sur le devis.',
        clientContext: { channel: 'desktop' },
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/event-stream');
    const body = res.body;
    const ackPos = body.indexOf('event: ack');
    const responsePos = body.indexOf('event: response');
    expect(ackPos).toBeGreaterThanOrEqual(0);
    expect(responsePos).toBeGreaterThanOrEqual(0);
    expect(ackPos).toBeLessThan(responsePos);
    expect(body).toContain('Deux secondes, je consulte tes emails.');
    expect(body).toContain('2 emails');
    expect(mockedRouteUserRequest).not.toHaveBeenCalled();
  });

  it('semantic E1 live: todo.add_task bypasses LLM router and keeps persistence/window', async () => {
    mockedTrySemanticRouter.mockResolvedValue({
      accepted: true,
      decision: 'accepted_e1',
      matchedRoute: {
        key: 'todo.add_task',
        level: 'E1',
        targetAgentId: 'todo',
        plannerRequired: true,
        directRequest: { domain: 'todo', action: 'add_task' },
        examples: ['ajoute une tache'],
      },
      top1Score: 0.95,
      top2Score: 0.7,
      margin: 0.25,
      top1Intent: 'todo.add_task',
      top2Intent: 'todo.list_tasks',
      confidence: 0.95,
    });
    mockedRouteUserRequest.mockRejectedValue(new Error('llm_router_should_not_be_called'));
    mockedCallTodoAgent.mockResolvedValue('C est fait, tache ajoutee pour demain.');

    const dbPath = join(tempDir, 'conversation.sqlite');
    const env = makeEnv(dbPath, {
      OPENAI_API_KEY: 'test-openai-key',
      SEMANTIC_ROUTER_ENABLED: true,
      SEMANTIC_ROUTER_SHADOW_MODE: false,
      SEMANTIC_ROUTER_E1_ACTIVATION_ENABLED: true,
      SEMANTIC_ROUTER_ACTIVATED_E1_ROUTES: 'todo.add_task',
    });
    registerIngestRoute(app, makeDeps(env, []));

    const res = await app.inject({
      method: 'POST',
      url: '/v1/ingest',
      payload: {
        threadId: 'thread-semantic-e1-todo-add-live',
        text: 'Ajoute appeler Arthur demain dans mes taches.',
        clientContext: { channel: 'desktop' },
      },
    });

    expect(res.statusCode).toBe(200);
    const payload = res.json() as { threadId: string; responseText: string };
    expect(payload.threadId).toBe('thread-semantic-e1-todo-add-live');
    expect(payload.responseText).toContain('tache ajoutee');
    expect(mockedCallTodoAgent).toHaveBeenCalledTimes(1);
    expect(mockedRouteUserRequest).not.toHaveBeenCalled();

    const history = await app.inject({
      method: 'GET',
      url: '/v1/threads/thread-semantic-e1-todo-add-live/history?limit=10',
    });
    expect(history.statusCode).toBe(200);
    const historyPayload = history.json() as { messages: Array<{ role: string; text: string }> };
    expect(historyPayload.messages.some((m) => m.role === 'assistant' && m.text.includes('tache ajoutee'))).toBe(true);

    (global as { fetch: typeof fetch }).fetch = (async () => haSpeechResponse('Réponse HA')) as unknown as typeof fetch;
    mockedTrySemanticRouter.mockResolvedValueOnce({
      accepted: false,
      decision: 'fallback_llm',
      top1Score: 0.5,
      top2Score: 0.45,
      margin: 0.05,
      top1Intent: 'search.news.current_news',
      top2Intent: 'search.web.quick_lookup',
      confidence: 0.5,
      fallbackReason: 'low_score',
    });
    mockedRouteUserRequest.mockResolvedValueOnce({
      targets: [],
      reason: 'none',
    });
    const second = await app.inject({
      method: 'POST',
      url: '/v1/ingest',
      payload: {
        threadId: 'thread-after-todo-add',
        text: 'bonjour',
        clientContext: { channel: 'desktop' },
      },
    });
    expect(second.statusCode).toBe(200);
    const secondPayload = second.json() as { threadId: string };
    expect(secondPayload.threadId).toBe('thread-semantic-e1-todo-add-live');
  });

  it('semantic E1 live: todo.complete_task bypasses LLM router', async () => {
    mockedTrySemanticRouter.mockResolvedValue({
      accepted: true,
      decision: 'accepted_e1',
      matchedRoute: {
        key: 'todo.complete_task',
        level: 'E1',
        targetAgentId: 'todo',
        plannerRequired: true,
        directRequest: { domain: 'todo', action: 'complete_task' },
        examples: ['marque la tache comme faite'],
      },
      top1Score: 0.94,
      top2Score: 0.71,
      margin: 0.23,
      top1Intent: 'todo.complete_task',
      top2Intent: 'todo.list_tasks',
      confidence: 0.94,
    });
    mockedRouteUserRequest.mockRejectedValue(new Error('llm_router_should_not_be_called'));
    mockedCallTodoAgent.mockResolvedValue('C est fait, la tache est marquee comme faite.');

    const dbPath = join(tempDir, 'conversation.sqlite');
    const env = makeEnv(dbPath, {
      OPENAI_API_KEY: 'test-openai-key',
      SEMANTIC_ROUTER_ENABLED: true,
      SEMANTIC_ROUTER_SHADOW_MODE: false,
      SEMANTIC_ROUTER_E1_ACTIVATION_ENABLED: true,
      SEMANTIC_ROUTER_ACTIVATED_E1_ROUTES: 'todo.complete_task',
    });
    registerIngestRoute(app, makeDeps(env, []));

    const res = await app.inject({
      method: 'POST',
      url: '/v1/ingest',
      payload: {
        threadId: 'thread-semantic-e1-todo-complete-live',
        text: 'Marque envoyer le devis comme fait.',
        clientContext: { channel: 'desktop' },
      },
    });

    expect(res.statusCode).toBe(200);
    const payload = res.json() as { responseText: string };
    expect(payload.responseText).toContain('marquee comme faite');
    expect(mockedCallTodoAgent).toHaveBeenCalledTimes(1);
    expect(mockedRouteUserRequest).not.toHaveBeenCalled();
  });

  it('semantic E1 live: mail.mark_read bypasses LLM router', async () => {
    mockedTrySemanticRouter.mockResolvedValue({
      accepted: true,
      decision: 'accepted_e1',
      matchedRoute: {
        key: 'mail.mark_read',
        level: 'E1',
        targetAgentId: 'mail',
        plannerRequired: true,
        directRequest: { domain: 'mail', action: 'mark_read' },
        examples: ['marque ce mail comme lu'],
      },
      top1Score: 0.95,
      top2Score: 0.7,
      margin: 0.25,
      top1Intent: 'mail.mark_read',
      top2Intent: 'mail.list_inbox.unread',
      confidence: 0.95,
    });
    mockedRouteUserRequest.mockRejectedValue(new Error('llm_router_should_not_be_called'));
    mockedCallMailAgent.mockResolvedValue('C est fait, le mail est marque comme lu.');

    const dbPath = join(tempDir, 'conversation.sqlite');
    const env = makeEnv(dbPath, {
      OPENAI_API_KEY: 'test-openai-key',
      SEMANTIC_ROUTER_ENABLED: true,
      SEMANTIC_ROUTER_SHADOW_MODE: false,
      SEMANTIC_ROUTER_E1_ACTIVATION_ENABLED: true,
      SEMANTIC_ROUTER_ACTIVATED_E1_ROUTES: 'mail.mark_read',
    });
    registerIngestRoute(app, makeDeps(env, []));

    const res = await app.inject({
      method: 'POST',
      url: '/v1/ingest',
      payload: {
        threadId: 'thread-semantic-e1-mail-mark-read-live',
        text: 'Marque le dernier mail de Thomas comme lu.',
        clientContext: { channel: 'desktop' },
      },
    });

    expect(res.statusCode).toBe(200);
    const payload = res.json() as { responseText: string };
    expect(payload.responseText).toContain('mail est marque comme lu');
    expect(mockedCallMailAgent).toHaveBeenCalledTimes(1);
    expect(mockedRouteUserRequest).not.toHaveBeenCalled();
  });

  it('semantic E1 live: mail.mark_unread bypasses LLM router', async () => {
    mockedTrySemanticRouter.mockResolvedValue({
      accepted: true,
      decision: 'accepted_e1',
      matchedRoute: {
        key: 'mail.mark_unread',
        level: 'E1',
        targetAgentId: 'mail',
        plannerRequired: true,
        directRequest: { domain: 'mail', action: 'mark_unread' },
        examples: ['remets ce mail en non lu'],
      },
      top1Score: 0.94,
      top2Score: 0.7,
      margin: 0.24,
      top1Intent: 'mail.mark_unread',
      top2Intent: 'mail.list_inbox.unread',
      confidence: 0.94,
    });
    mockedRouteUserRequest.mockRejectedValue(new Error('llm_router_should_not_be_called'));
    mockedCallMailAgent.mockResolvedValue('C est fait, le mail est repasse en non lu.');

    const dbPath = join(tempDir, 'conversation.sqlite');
    const env = makeEnv(dbPath, {
      OPENAI_API_KEY: 'test-openai-key',
      SEMANTIC_ROUTER_ENABLED: true,
      SEMANTIC_ROUTER_SHADOW_MODE: false,
      SEMANTIC_ROUTER_E1_ACTIVATION_ENABLED: true,
      SEMANTIC_ROUTER_ACTIVATED_E1_ROUTES: 'mail.mark_unread',
    });
    registerIngestRoute(app, makeDeps(env, []));

    const res = await app.inject({
      method: 'POST',
      url: '/v1/ingest',
      payload: {
        threadId: 'thread-semantic-e1-mail-mark-unread-live',
        text: 'Remets le mail de Marie en non lu.',
        clientContext: { channel: 'desktop' },
      },
    });

    expect(res.statusCode).toBe(200);
    const payload = res.json() as { responseText: string };
    expect(payload.responseText).toContain('non lu');
    expect(mockedCallMailAgent).toHaveBeenCalledTimes(1);
    expect(mockedRouteUserRequest).not.toHaveBeenCalled();
  });

  it('semantic E1 sensitive route mail.send_email is not activated when not allowlisted', async () => {
    mockedTrySemanticRouter.mockResolvedValue({
      accepted: true,
      decision: 'accepted_e1',
      matchedRoute: {
        key: 'mail.send_email',
        level: 'E1',
        targetAgentId: 'mail',
        plannerRequired: true,
        directRequest: { domain: 'mail', action: 'send_email' },
        examples: ['envoie un mail'],
      },
      top1Score: 0.93,
      top2Score: 0.7,
      margin: 0.23,
      top1Intent: 'mail.send_email',
      top2Intent: 'mail.search_emails',
      confidence: 0.93,
    });
    mockedRouteUserRequest.mockResolvedValue({
      targets: [{ agentId: 'search.news', confidence: 0.95 }],
      reason: 'external_weather_forecast',
    });
    (global as { fetch: typeof fetch }).fetch = (jest.fn(async () => (
      new Response(
        JSON.stringify({ choices: [{ message: { content: 'Fallback LLM ok.' } }] }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    )) as unknown) as typeof fetch;

    const dbPath = join(tempDir, 'conversation.sqlite');
    const env = makeEnv(dbPath, {
      OPENAI_API_KEY: 'test-openai-key',
      SEMANTIC_ROUTER_ENABLED: true,
      SEMANTIC_ROUTER_SHADOW_MODE: false,
      SEMANTIC_ROUTER_E1_ACTIVATION_ENABLED: true,
      SEMANTIC_ROUTER_ACTIVATED_E1_ROUTES: '',
    });
    registerIngestRoute(app, makeDeps(env, []));

    const res = await app.inject({
      method: 'POST',
      url: '/v1/ingest',
      payload: {
        threadId: 'thread-semantic-e1-mail-sensitive-not-allowlisted',
        text: 'Envoie un email a Thomas',
        clientContext: { channel: 'desktop' },
      },
    });

    expect(res.statusCode).toBe(200);
    expect(mockedRouteUserRequest).toHaveBeenCalledTimes(1);
    expect(mockedCallMailAgent).not.toHaveBeenCalled();
  });

  it('semantic E1 todo/mail mutation agent error falls back to LLM router', async () => {
    mockedTrySemanticRouter.mockResolvedValue({
      accepted: true,
      decision: 'accepted_e1',
      matchedRoute: {
        key: 'todo.add_task',
        level: 'E1',
        targetAgentId: 'todo',
        plannerRequired: true,
        directRequest: { domain: 'todo', action: 'add_task' },
        examples: ['ajoute une tache'],
      },
      top1Score: 0.95,
      top2Score: 0.7,
      margin: 0.25,
      top1Intent: 'todo.add_task',
      top2Intent: 'todo.list_tasks',
      confidence: 0.95,
    });
    mockedCallTodoAgent.mockRejectedValue(new Error('todo_unavailable'));
    mockedRouteUserRequest.mockResolvedValue({
      targets: [{ agentId: 'search.news', confidence: 0.95 }],
      reason: 'external_weather_forecast',
    });
    (global as { fetch: typeof fetch }).fetch = (jest.fn(async () => (
      new Response(
        JSON.stringify({ choices: [{ message: { content: 'Fallback LLM après erreur todo.' } }] }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    )) as unknown) as typeof fetch;

    const dbPath = join(tempDir, 'conversation.sqlite');
    const env = makeEnv(dbPath, {
      OPENAI_API_KEY: 'test-openai-key',
      SEMANTIC_ROUTER_ENABLED: true,
      SEMANTIC_ROUTER_SHADOW_MODE: false,
      SEMANTIC_ROUTER_E1_ACTIVATION_ENABLED: true,
      SEMANTIC_ROUTER_ACTIVATED_E1_ROUTES: 'todo.add_task',
    });
    registerIngestRoute(app, makeDeps(env, []));

    const res = await app.inject({
      method: 'POST',
      url: '/v1/ingest',
      payload: {
        threadId: 'thread-semantic-e1-todo-mutation-error-fallback',
        text: 'Ajoute appeler Arthur demain',
        clientContext: { channel: 'desktop' },
      },
    });

    expect(res.statusCode).toBe(200);
    expect(mockedRouteUserRequest).toHaveBeenCalledTimes(1);
  });

  it('semantic E1 live todo.add_task emits SSE ack before response', async () => {
    mockedTrySemanticRouter.mockResolvedValue({
      accepted: true,
      decision: 'accepted_e1',
      matchedRoute: {
        key: 'todo.add_task',
        level: 'E1',
        targetAgentId: 'todo',
        plannerRequired: true,
        directRequest: { domain: 'todo', action: 'add_task' },
        examples: ['ajoute une tache'],
      },
      top1Score: 0.95,
      top2Score: 0.7,
      margin: 0.25,
      top1Intent: 'todo.add_task',
      top2Intent: 'todo.list_tasks',
      confidence: 0.95,
    });
    mockedRouteUserRequest.mockRejectedValue(new Error('llm_router_should_not_be_called'));
    mockedCallTodoAgent.mockResolvedValue('C est fait, tache ajoutee.');

    const dbPath = join(tempDir, 'conversation.sqlite');
    const env = makeEnv(dbPath, {
      OPENAI_API_KEY: 'test-openai-key',
      SEMANTIC_ROUTER_ENABLED: true,
      SEMANTIC_ROUTER_SHADOW_MODE: false,
      SEMANTIC_ROUTER_E1_ACTIVATION_ENABLED: true,
      SEMANTIC_ROUTER_ACTIVATED_E1_ROUTES: 'todo.add_task',
    });
    registerIngestRoute(app, makeDeps(env, []));

    const res = await app.inject({
      method: 'POST',
      url: '/v1/ingest?sse=1',
      headers: {
        accept: 'text/event-stream',
      },
      payload: {
        threadId: 'thread-semantic-e1-todo-add-sse',
        text: 'Ajoute appeler Arthur demain dans mes taches.',
        clientContext: { channel: 'desktop' },
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/event-stream');
    const body = res.body;
    const ackPos = body.indexOf('event: ack');
    const responsePos = body.indexOf('event: response');
    expect(ackPos).toBeGreaterThanOrEqual(0);
    expect(responsePos).toBeGreaterThanOrEqual(0);
    expect(ackPos).toBeLessThan(responsePos);
    expect(body).toContain('Deux secondes, je regarde tes taches.');
    expect(body).toContain('tache ajoutee');
    expect(mockedRouteUserRequest).not.toHaveBeenCalled();
  });

  it('semantic E1 live: todo.update_task bypasses LLM router', async () => {
    mockedTrySemanticRouter.mockResolvedValue({
      accepted: true,
      decision: 'accepted_e1',
      matchedRoute: {
        key: 'todo.update_task',
        level: 'E1',
        targetAgentId: 'todo',
        plannerRequired: true,
        directRequest: { domain: 'todo', action: 'update_task' },
        examples: ['decale la tache'],
      },
      top1Score: 0.95,
      top2Score: 0.72,
      margin: 0.23,
      top1Intent: 'todo.update_task',
      top2Intent: 'todo.list_tasks',
      confidence: 0.95,
    });
    mockedRouteUserRequest.mockRejectedValue(new Error('llm_router_should_not_be_called'));
    mockedCallTodoAgent.mockResolvedValue('C est fait, la tache est decalee a vendredi.');

    const dbPath = join(tempDir, 'conversation.sqlite');
    const env = makeEnv(dbPath, {
      OPENAI_API_KEY: 'test-openai-key',
      SEMANTIC_ROUTER_ENABLED: true,
      SEMANTIC_ROUTER_SHADOW_MODE: false,
      SEMANTIC_ROUTER_E1_ACTIVATION_ENABLED: true,
      SEMANTIC_ROUTER_ACTIVATED_E1_ROUTES: 'todo.update_task',
    });
    registerIngestRoute(app, makeDeps(env, []));

    const res = await app.inject({
      method: 'POST',
      url: '/v1/ingest',
      payload: {
        threadId: 'thread-semantic-e1-todo-update-live',
        text: 'Decale la tache envoyer le devis a vendredi.',
        clientContext: { channel: 'desktop' },
      },
    });

    expect(res.statusCode).toBe(200);
    const payload = res.json() as { responseText: string };
    expect(payload.responseText).toContain('decalee');
    expect(mockedCallTodoAgent).toHaveBeenCalledTimes(1);
    expect(mockedRouteUserRequest).not.toHaveBeenCalled();
  });

  it('semantic E1 live: todo.delete_task bypasses LLM router', async () => {
    mockedTrySemanticRouter.mockResolvedValue({
      accepted: true,
      decision: 'accepted_e1',
      matchedRoute: {
        key: 'todo.delete_task',
        level: 'E1',
        targetAgentId: 'todo',
        plannerRequired: true,
        directRequest: { domain: 'todo', action: 'delete_task' },
        examples: ['supprime la tache'],
      },
      top1Score: 0.94,
      top2Score: 0.71,
      margin: 0.23,
      top1Intent: 'todo.delete_task',
      top2Intent: 'todo.list_tasks',
      confidence: 0.94,
    });
    mockedRouteUserRequest.mockRejectedValue(new Error('llm_router_should_not_be_called'));
    mockedCallTodoAgent.mockResolvedValue('C est fait, la tache est supprimee.');

    const dbPath = join(tempDir, 'conversation.sqlite');
    const env = makeEnv(dbPath, {
      OPENAI_API_KEY: 'test-openai-key',
      SEMANTIC_ROUTER_ENABLED: true,
      SEMANTIC_ROUTER_SHADOW_MODE: false,
      SEMANTIC_ROUTER_E1_ACTIVATION_ENABLED: true,
      SEMANTIC_ROUTER_ACTIVATED_E1_ROUTES: 'todo.delete_task',
    });
    registerIngestRoute(app, makeDeps(env, []));

    const res = await app.inject({
      method: 'POST',
      url: '/v1/ingest',
      payload: {
        threadId: 'thread-semantic-e1-todo-delete-live',
        text: 'Supprime la tache acheter du lait.',
        clientContext: { channel: 'desktop' },
      },
    });

    expect(res.statusCode).toBe(200);
    const payload = res.json() as { responseText: string };
    expect(payload.responseText).toContain('supprimee');
    expect(mockedCallTodoAgent).toHaveBeenCalledTimes(1);
    expect(mockedRouteUserRequest).not.toHaveBeenCalled();
  });

  it('semantic E1 live: todo.create_list bypasses LLM router', async () => {
    mockedTrySemanticRouter.mockResolvedValue({
      accepted: true,
      decision: 'accepted_e1',
      matchedRoute: {
        key: 'todo.create_list',
        level: 'E1',
        targetAgentId: 'todo',
        plannerRequired: true,
        directRequest: { domain: 'todo', action: 'create_list' },
        examples: ['cree une liste'],
      },
      top1Score: 0.94,
      top2Score: 0.7,
      margin: 0.24,
      top1Intent: 'todo.create_list',
      top2Intent: 'todo.list_lists',
      confidence: 0.94,
    });
    mockedRouteUserRequest.mockRejectedValue(new Error('llm_router_should_not_be_called'));
    mockedCallTodoAgent.mockResolvedValue('C est fait, la liste est creee.');

    const dbPath = join(tempDir, 'conversation.sqlite');
    const env = makeEnv(dbPath, {
      OPENAI_API_KEY: 'test-openai-key',
      SEMANTIC_ROUTER_ENABLED: true,
      SEMANTIC_ROUTER_SHADOW_MODE: false,
      SEMANTIC_ROUTER_E1_ACTIVATION_ENABLED: true,
      SEMANTIC_ROUTER_ACTIVATED_E1_ROUTES: 'todo.create_list',
    });
    registerIngestRoute(app, makeDeps(env, []));

    const res = await app.inject({
      method: 'POST',
      url: '/v1/ingest',
      payload: {
        threadId: 'thread-semantic-e1-todo-create-list-live',
        text: 'Cree une liste vacances.',
        clientContext: { channel: 'desktop' },
      },
    });

    expect(res.statusCode).toBe(200);
    const payload = res.json() as { responseText: string };
    expect(payload.responseText).toContain('liste est creee');
    expect(mockedCallTodoAgent).toHaveBeenCalledTimes(1);
    expect(mockedRouteUserRequest).not.toHaveBeenCalled();
  });

  it('semantic E1 live: todo.add_checklist_item bypasses LLM router', async () => {
    mockedTrySemanticRouter.mockResolvedValue({
      accepted: true,
      decision: 'accepted_e1',
      matchedRoute: {
        key: 'todo.add_checklist_item',
        level: 'E1',
        targetAgentId: 'todo',
        plannerRequired: true,
        directRequest: { domain: 'todo', action: 'add_checklist_item' },
        examples: ['ajoute un element checklist'],
      },
      top1Score: 0.94,
      top2Score: 0.7,
      margin: 0.24,
      top1Intent: 'todo.add_checklist_item',
      top2Intent: 'todo.list_tasks',
      confidence: 0.94,
    });
    mockedRouteUserRequest.mockRejectedValue(new Error('llm_router_should_not_be_called'));
    mockedCallTodoAgent.mockResolvedValue('C est fait, element de checklist ajoute.');

    const dbPath = join(tempDir, 'conversation.sqlite');
    const env = makeEnv(dbPath, {
      OPENAI_API_KEY: 'test-openai-key',
      SEMANTIC_ROUTER_ENABLED: true,
      SEMANTIC_ROUTER_SHADOW_MODE: false,
      SEMANTIC_ROUTER_E1_ACTIVATION_ENABLED: true,
      SEMANTIC_ROUTER_ACTIVATED_E1_ROUTES: 'todo.add_checklist_item',
    });
    registerIngestRoute(app, makeDeps(env, []));

    const res = await app.inject({
      method: 'POST',
      url: '/v1/ingest',
      payload: {
        threadId: 'thread-semantic-e1-todo-add-checklist-live',
        text: 'Ajoute preparer les documents a la checklist.',
        clientContext: { channel: 'desktop' },
      },
    });

    expect(res.statusCode).toBe(200);
    const payload = res.json() as { responseText: string };
    expect(payload.responseText).toContain('checklist ajoute');
    expect(mockedCallTodoAgent).toHaveBeenCalledTimes(1);
    expect(mockedRouteUserRequest).not.toHaveBeenCalled();
  });

  it('semantic E1 live: mail.flag_email bypasses LLM router', async () => {
    mockedTrySemanticRouter.mockResolvedValue({
      accepted: true,
      decision: 'accepted_e1',
      matchedRoute: {
        key: 'mail.flag_email',
        level: 'E1',
        targetAgentId: 'mail',
        plannerRequired: true,
        directRequest: { domain: 'mail', action: 'flag_email' },
        examples: ['marque ce mail important'],
      },
      top1Score: 0.94,
      top2Score: 0.7,
      margin: 0.24,
      top1Intent: 'mail.flag_email',
      top2Intent: 'mail.search_emails',
      confidence: 0.94,
    });
    mockedRouteUserRequest.mockRejectedValue(new Error('llm_router_should_not_be_called'));
    mockedCallMailAgent.mockResolvedValue('C est fait, le mail est marque comme important.');

    const dbPath = join(tempDir, 'conversation.sqlite');
    const env = makeEnv(dbPath, {
      OPENAI_API_KEY: 'test-openai-key',
      SEMANTIC_ROUTER_ENABLED: true,
      SEMANTIC_ROUTER_SHADOW_MODE: false,
      SEMANTIC_ROUTER_E1_ACTIVATION_ENABLED: true,
      SEMANTIC_ROUTER_ACTIVATED_E1_ROUTES: 'mail.flag_email',
    });
    registerIngestRoute(app, makeDeps(env, []));

    const res = await app.inject({
      method: 'POST',
      url: '/v1/ingest',
      payload: {
        threadId: 'thread-semantic-e1-mail-flag-live',
        text: 'Marque le dernier mail de Thomas comme important.',
        clientContext: { channel: 'desktop' },
      },
    });

    expect(res.statusCode).toBe(200);
    const payload = res.json() as { responseText: string };
    expect(payload.responseText).toContain('marque comme important');
    expect(mockedCallMailAgent).toHaveBeenCalledTimes(1);
    expect(mockedRouteUserRequest).not.toHaveBeenCalled();
  });

  it('semantic E1 route mail.flag_email falls back to LLM router when not allowlisted', async () => {
    mockedTrySemanticRouter.mockResolvedValue({
      accepted: true,
      decision: 'accepted_e1',
      matchedRoute: {
        key: 'mail.flag_email',
        level: 'E1',
        targetAgentId: 'mail',
        plannerRequired: true,
        directRequest: { domain: 'mail', action: 'flag_email' },
        examples: ['marque ce mail important'],
      },
      top1Score: 0.94,
      top2Score: 0.7,
      margin: 0.24,
      top1Intent: 'mail.flag_email',
      top2Intent: 'mail.search_emails',
      confidence: 0.94,
    });
    mockedRouteUserRequest.mockResolvedValue({
      targets: [{ agentId: 'search.news', confidence: 0.95 }],
      reason: 'external_weather_forecast',
    });
    (global as { fetch: typeof fetch }).fetch = (jest.fn(async () => (
      new Response(
        JSON.stringify({ choices: [{ message: { content: 'Fallback LLM ok.' } }] }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    )) as unknown) as typeof fetch;

    const dbPath = join(tempDir, 'conversation.sqlite');
    const env = makeEnv(dbPath, {
      OPENAI_API_KEY: 'test-openai-key',
      SEMANTIC_ROUTER_ENABLED: true,
      SEMANTIC_ROUTER_SHADOW_MODE: false,
      SEMANTIC_ROUTER_E1_ACTIVATION_ENABLED: true,
      SEMANTIC_ROUTER_ACTIVATED_E1_ROUTES: '',
    });
    registerIngestRoute(app, makeDeps(env, []));

    const res = await app.inject({
      method: 'POST',
      url: '/v1/ingest',
      payload: {
        threadId: 'thread-semantic-e1-mail-flag-not-allowlisted',
        text: 'Marque le dernier mail de Thomas comme important.',
        clientContext: { channel: 'desktop' },
      },
    });

    expect(res.statusCode).toBe(200);
    expect(mockedRouteUserRequest).toHaveBeenCalledTimes(1);
    expect(mockedCallMailAgent).not.toHaveBeenCalled();
  });

  it('semantic E1 live mail.flag_email emits SSE ack before response', async () => {
    mockedTrySemanticRouter.mockResolvedValue({
      accepted: true,
      decision: 'accepted_e1',
      matchedRoute: {
        key: 'mail.flag_email',
        level: 'E1',
        targetAgentId: 'mail',
        plannerRequired: true,
        directRequest: { domain: 'mail', action: 'flag_email' },
        examples: ['marque ce mail important'],
      },
      top1Score: 0.95,
      top2Score: 0.72,
      margin: 0.23,
      top1Intent: 'mail.flag_email',
      top2Intent: 'mail.search_emails',
      confidence: 0.95,
    });
    mockedRouteUserRequest.mockRejectedValue(new Error('llm_router_should_not_be_called'));
    mockedCallMailAgent.mockResolvedValue('C est fait, mail marque important.');

    const dbPath = join(tempDir, 'conversation.sqlite');
    const env = makeEnv(dbPath, {
      OPENAI_API_KEY: 'test-openai-key',
      SEMANTIC_ROUTER_ENABLED: true,
      SEMANTIC_ROUTER_SHADOW_MODE: false,
      SEMANTIC_ROUTER_E1_ACTIVATION_ENABLED: true,
      SEMANTIC_ROUTER_ACTIVATED_E1_ROUTES: 'mail.flag_email',
    });
    registerIngestRoute(app, makeDeps(env, []));

    const res = await app.inject({
      method: 'POST',
      url: '/v1/ingest?sse=1',
      headers: {
        accept: 'text/event-stream',
      },
      payload: {
        threadId: 'thread-semantic-e1-mail-flag-sse',
        text: 'Marque le dernier mail de Thomas comme important.',
        clientContext: { channel: 'desktop' },
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/event-stream');
    const body = res.body;
    const ackPos = body.indexOf('event: ack');
    const responsePos = body.indexOf('event: response');
    expect(ackPos).toBeGreaterThanOrEqual(0);
    expect(responsePos).toBeGreaterThanOrEqual(0);
    expect(ackPos).toBeLessThan(responsePos);
    expect(body).toContain('Deux secondes, je consulte tes emails.');
    expect(body).toContain('marque important');
    expect(mockedRouteUserRequest).not.toHaveBeenCalled();
  });

  it('semantic E1 high-risk mail.send_email falls back when dedicated high-risk activation is disabled', async () => {
    mockedTrySemanticRouter.mockResolvedValue({
      accepted: true,
      decision: 'accepted_e1',
      matchedRoute: {
        key: 'mail.send_email',
        level: 'E1',
        targetAgentId: 'mail',
        plannerRequired: true,
        highRisk: true,
        directRequest: { domain: 'mail', action: 'send_email' },
        examples: ['envoie un mail a marie'],
      },
      top1Score: 0.96,
      top2Score: 0.72,
      margin: 0.24,
      top1Intent: 'mail.send_email',
      top2Intent: 'mail.search_emails',
      confidence: 0.96,
    });
    mockedRouteUserRequest.mockResolvedValue({
      targets: [{ agentId: 'search.news', confidence: 0.95 }],
      reason: 'external_weather_forecast',
    });
    (global as { fetch: typeof fetch }).fetch = (jest.fn(async () => (
      new Response(
        JSON.stringify({ choices: [{ message: { content: 'Fallback LLM ok.' } }] }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    )) as unknown) as typeof fetch;

    const dbPath = join(tempDir, 'conversation.sqlite');
    const env = makeEnv(dbPath, {
      OPENAI_API_KEY: 'test-openai-key',
      SEMANTIC_ROUTER_ENABLED: true,
      SEMANTIC_ROUTER_SHADOW_MODE: false,
      SEMANTIC_ROUTER_E1_ACTIVATION_ENABLED: true,
      SEMANTIC_ROUTER_ACTIVATED_E1_ROUTES: 'mail.send_email',
      SEMANTIC_ROUTER_E1_HIGH_RISK_ACTIVATION_ENABLED: false,
      SEMANTIC_ROUTER_ACTIVATED_E1_HIGH_RISK_ROUTES: 'mail.send_email',
      SEMANTIC_ROUTER_HIGH_RISK_ACCEPT_SCORE: 0.9,
      SEMANTIC_ROUTER_HIGH_RISK_MIN_MARGIN: 0.12,
    });
    registerIngestRoute(app, makeDeps(env, []));

    const res = await app.inject({
      method: 'POST',
      url: '/v1/ingest',
      payload: {
        threadId: 'thread-semantic-e1-mail-send-hr-disabled',
        text: 'Envoie un mail a Marie pour confirmer le rendez-vous.',
        clientContext: { channel: 'desktop' },
      },
    });

    expect(res.statusCode).toBe(200);
    expect(mockedCallMailAgent).not.toHaveBeenCalled();
    expect(mockedRouteUserRequest).toHaveBeenCalledTimes(1);
  });

  it('semantic E1 high-risk mail.send_email falls back when stricter thresholds are not met', async () => {
    mockedTrySemanticRouter.mockResolvedValue({
      accepted: true,
      decision: 'accepted_e1',
      matchedRoute: {
        key: 'mail.send_email',
        level: 'E1',
        targetAgentId: 'mail',
        plannerRequired: true,
        highRisk: true,
        directRequest: { domain: 'mail', action: 'send_email' },
        examples: ['envoie un mail a marie'],
      },
      top1Score: 0.89,
      top2Score: 0.72,
      margin: 0.1,
      top1Intent: 'mail.send_email',
      top2Intent: 'mail.search_emails',
      confidence: 0.89,
    });
    mockedRouteUserRequest.mockResolvedValue({
      targets: [{ agentId: 'search.news', confidence: 0.95 }],
      reason: 'external_weather_forecast',
    });
    (global as { fetch: typeof fetch }).fetch = (jest.fn(async () => (
      new Response(
        JSON.stringify({ choices: [{ message: { content: 'Fallback LLM ok.' } }] }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    )) as unknown) as typeof fetch;

    const dbPath = join(tempDir, 'conversation.sqlite');
    const env = makeEnv(dbPath, {
      OPENAI_API_KEY: 'test-openai-key',
      SEMANTIC_ROUTER_ENABLED: true,
      SEMANTIC_ROUTER_SHADOW_MODE: false,
      SEMANTIC_ROUTER_E1_ACTIVATION_ENABLED: true,
      SEMANTIC_ROUTER_ACTIVATED_E1_ROUTES: 'mail.send_email',
      SEMANTIC_ROUTER_E1_HIGH_RISK_ACTIVATION_ENABLED: true,
      SEMANTIC_ROUTER_ACTIVATED_E1_HIGH_RISK_ROUTES: 'mail.send_email',
      SEMANTIC_ROUTER_HIGH_RISK_ACCEPT_SCORE: 0.9,
      SEMANTIC_ROUTER_HIGH_RISK_MIN_MARGIN: 0.12,
    });
    registerIngestRoute(app, makeDeps(env, []));

    const res = await app.inject({
      method: 'POST',
      url: '/v1/ingest',
      payload: {
        threadId: 'thread-semantic-e1-mail-send-hr-threshold',
        text: 'Envoie un mail a Marie pour confirmer le rendez-vous.',
        clientContext: { channel: 'desktop' },
      },
    });

    expect(res.statusCode).toBe(200);
    expect(mockedCallMailAgent).not.toHaveBeenCalled();
    expect(mockedRouteUserRequest).toHaveBeenCalledTimes(1);
  });

  it('semantic E1 high-risk mail.send_email bypasses LLM router when dedicated guard is satisfied', async () => {
    mockedTrySemanticRouter.mockResolvedValue({
      accepted: true,
      decision: 'accepted_e1',
      matchedRoute: {
        key: 'mail.send_email',
        level: 'E1',
        targetAgentId: 'mail',
        plannerRequired: true,
        highRisk: true,
        directRequest: { domain: 'mail', action: 'send_email' },
        examples: ['envoie un mail a marie'],
      },
      top1Score: 0.96,
      top2Score: 0.72,
      margin: 0.24,
      top1Intent: 'mail.send_email',
      top2Intent: 'mail.search_emails',
      confidence: 0.96,
    });
    mockedRouteUserRequest.mockRejectedValue(new Error('llm_router_should_not_be_called'));
    mockedCallMailAgent.mockResolvedValue('Mail envoye.');

    const dbPath = join(tempDir, 'conversation.sqlite');
    const env = makeEnv(dbPath, {
      OPENAI_API_KEY: 'test-openai-key',
      SEMANTIC_ROUTER_ENABLED: true,
      SEMANTIC_ROUTER_SHADOW_MODE: false,
      SEMANTIC_ROUTER_E1_ACTIVATION_ENABLED: true,
      SEMANTIC_ROUTER_ACTIVATED_E1_ROUTES: 'mail.send_email',
      SEMANTIC_ROUTER_E1_HIGH_RISK_ACTIVATION_ENABLED: true,
      SEMANTIC_ROUTER_ACTIVATED_E1_HIGH_RISK_ROUTES: 'mail.send_email',
      SEMANTIC_ROUTER_HIGH_RISK_ACCEPT_SCORE: 0.9,
      SEMANTIC_ROUTER_HIGH_RISK_MIN_MARGIN: 0.12,
    });
    registerIngestRoute(app, makeDeps(env, []));

    const res = await app.inject({
      method: 'POST',
      url: '/v1/ingest',
      payload: {
        threadId: 'thread-semantic-e1-mail-send-hr-live',
        text: 'Envoie un mail a Marie pour confirmer le rendez-vous.',
        clientContext: { channel: 'desktop' },
      },
    });

    expect(res.statusCode).toBe(200);
    const payload = res.json() as { responseText: string };
    expect(payload.responseText).toContain('Mail envoye');
    expect(mockedCallMailAgent).toHaveBeenCalledTimes(1);
    expect(mockedRouteUserRequest).not.toHaveBeenCalled();
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
