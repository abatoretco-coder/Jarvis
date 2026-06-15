import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import Fastify, { type FastifyInstance } from 'fastify';

import { routeUserRequest } from '../src/conversation/orchestratorRouter';
import type { Env } from '../src/env';
import { registerIngestRoute } from '../src/routes/ingest';
import { trySemanticRouter } from '../src/routing/semanticRouter';
import type { AppDeps } from '../src/server';
import { planSpotifyActionFromTextWithOpenAi } from '../src/spotify/musicAgentPlanner';

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

const mockedRouteUserRequest = routeUserRequest as jest.MockedFunction<typeof routeUserRequest>;
const mockedTrySemanticRouter = trySemanticRouter as jest.MockedFunction<typeof trySemanticRouter>;
const mockedPlanSpotifyAction = planSpotifyActionFromTextWithOpenAi as jest.MockedFunction<typeof planSpotifyActionFromTextWithOpenAi>;

type MusicResponse = {
  responseText: string;
  status: 'success' | 'need_clarification' | 'error';
  replyMeta?: { kind?: string; source?: string; routeKey?: string; fallbackReason?: string };
  music?: {
    routing?: { domain?: string; path?: string; action?: string };
    execution?: { status?: string };
  };
  planner?: { source?: string; route?: string; reason?: string };
};

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
    HA_AGENT_MAP: undefined,
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

function makeDeps(env: Env): AppDeps {
  return {
    env,
    ha: {
      getStates: async () => [],
    } as AppDeps['ha'],
    spotifyWebApi: {
      isConfigured: () => true,
      scheduleSituationRefresh: jest.fn(),
    } as unknown as AppDeps['spotifyWebApi'],
  };
}

describe('music routing business tests', () => {
  let tempDir: string;
  let app: FastifyInstance;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'jarvis-music-routing-business-'));
    app = Fastify({ logger: false });
    mockedRouteUserRequest.mockReset();
    mockedTrySemanticRouter.mockReset();
    mockedPlanSpotifyAction.mockReset();
    (global as { fetch?: unknown }).fetch = undefined;
  });

  afterEach(async () => {
    await app.close();
  });

  it('routing explicite Spotify: pause sans lecture active => erreur execution claire', async () => {
    const env = makeEnv(join(tempDir, 'conversation.sqlite'));
    const deps = makeDeps(env);
    deps.spotifyWebApi = {
      ...deps.spotifyWebApi,
      getNowPlaying: async () => ({ ok: false, status: 204, error: 'spotify_no_active_playback' }),
    } as AppDeps['spotifyWebApi'];

    registerIngestRoute(app, deps);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/ingest',
      payload: {
        threadId: 'music-explicit-pause',
        domain: 'spotify',
        action: 'pause',
      },
    });

    expect(res.statusCode).toBe(200);
    const payload = res.json() as MusicResponse;
    expect(payload.responseText).toContain('Rien ne joue actuellement');
    expect(payload.status).toBe('success');
    expect(payload.replyMeta?.kind).toBe('spotify');
    expect(payload.replyMeta?.routeKey).toBe('spotify.pause');
    expect(payload.replyMeta?.fallbackReason).toBeUndefined();
    expect(payload.music?.routing?.path).toBe('explicit_contract');
    expect(payload.music?.execution?.status).toBe('success');
  });

  it('routing agent direct: play avec slot device => action executee sans planner', async () => {
    mockedRouteUserRequest.mockResolvedValue({
      targets: [{ agentId: 'spotify', confidence: 0.99, action: 'play', slots: { device: 'alias:pc' } }],
      reason: 'router_direct_play',
    });

    const play = jest.fn(async () => ({ ok: true }));

    const env = makeEnv(join(tempDir, 'conversation.sqlite'), {
      OPENAI_API_KEY: 'test-openai-key',
      SEMANTIC_ROUTER_ENABLED: false,
    });
    const deps = makeDeps(env);
    deps.spotifyWebApi = {
      ...deps.spotifyWebApi,
      play,
    } as unknown as AppDeps['spotifyWebApi'];

    registerIngestRoute(app, deps);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/ingest',
      payload: {
        threadId: 'music-semantic-direct-transfer',
        text: 'Transfere la musique sur mon telephone',
      },
    });

    expect(res.statusCode).toBe(200);
    const payload = res.json() as MusicResponse;
    expect(payload.responseText).toContain('Lecture reprise');
    expect(payload.status).toBe('success');
    expect(payload.replyMeta?.routeKey).toBe('spotify.play');
    expect(payload.music?.routing?.path).toBe('router_direct');
    expect(payload.music?.routing?.action).toBe('play');
    expect(payload.music?.execution?.status).toBe('success');
    expect(play).toHaveBeenCalledTimes(1);
    expect(play).toHaveBeenCalledWith('alias:pc');
    expect(mockedRouteUserRequest).toHaveBeenCalledTimes(1);
    expect(mockedPlanSpotifyAction).not.toHaveBeenCalled();
  });

  it('routing semantic planner: search_and_play sans query => planner puis action play', async () => {
    mockedTrySemanticRouter.mockResolvedValue({
      accepted: true,
      decision: 'accepted_e1',
      matchedRoute: {
        key: 'spotify.search_and_play',
        level: 'E1',
        targetAgentId: 'spotify',
        plannerRequired: true,
        directRequest: { domain: 'spotify', action: 'search_and_play' },
        examples: ['mets de la musique'],
      },
      top1Score: 0.95,
      top2Score: 0.66,
      margin: 0.29,
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
        action: 'play',
        slots: { device: 'alias:pc' },
      },
    });

    const play = jest.fn(async () => ({ ok: true }));

    const env = makeEnv(join(tempDir, 'conversation.sqlite'), {
      OPENAI_API_KEY: 'test-openai-key',
      SEMANTIC_ROUTER_ENABLED: true,
      SEMANTIC_ROUTER_SHADOW_MODE: false,
      SEMANTIC_ROUTER_E1_ACTIVATION_ENABLED: true,
      SEMANTIC_ROUTER_ACTIVATED_E1_ROUTES: 'spotify.search_and_play',
    });
    const deps = makeDeps(env);
    deps.spotifyWebApi = {
      ...deps.spotifyWebApi,
      play,
    } as unknown as AppDeps['spotifyWebApi'];

    registerIngestRoute(app, deps);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/ingest',
      payload: {
        threadId: 'music-semantic-planner-play',
        text: 'Mets de la musique sur le pc',
      },
    });

    expect(res.statusCode).toBe(200);
    const payload = res.json() as MusicResponse;
    expect(payload.responseText).toContain('Lecture reprise');
    expect(payload.status).toBe('success');
    expect(payload.replyMeta?.routeKey).toBe('spotify.play');
    expect(payload.music?.routing?.path).toBe('music_planner');
    expect(payload.music?.routing?.action).toBe('play');
    expect(payload.music?.execution?.status).toBe('success');
    expect(payload.planner?.source).toBe('openai_music_agent');
    expect(payload.planner?.route).toBe('spotify');
    expect(mockedPlanSpotifyAction).toHaveBeenCalledTimes(1);
    expect(play).toHaveBeenCalledTimes(1);
    expect(play).toHaveBeenCalledWith('alias:pc');
  });
});
