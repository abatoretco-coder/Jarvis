import { afterEach, describe, expect, test } from '@jest/globals';

import type { Env } from '../src/env';
import { planSpotifyActionFromTextWithOpenAi } from '../src/spotify/musicAgentPlanner';
import { buildMusicAgentSystemPrompt } from '../src/spotify/prompts/musicAgentSystemPrompt';
import { buildMusicAgentUserTemplate } from '../src/spotify/prompts/musicAgentUserTemplate';

type MinimalSpotifyApi = {
  isConfigured: () => boolean;
  listDevicesPublic: () => Promise<
    | { ok: true; devices: Array<{ id: string; name: string; type?: string; isActive: boolean }> }
    | { ok: false; error: string; status?: number }
  >;
  getNowPlaying: () => Promise<
    | { ok: true; data: Record<string, unknown> }
    | { ok: false; error: string; status?: number }
  >;
};

function makeEnv(overrides?: Partial<Env>): Env {
  return {
    OPENAI_API_KEY: 'test-key',
    OPENAI_BASE_URL: 'https://api.openai.test/v1',
    OPENAI_TIMEOUT_MS: 3000,
    OPENAI_MODEL_MUSIC_AGENT: 'gpt-4o-mini',
    ...(overrides ?? {}),
  } as unknown as Env;
}

function makeSpotifyApi(): MinimalSpotifyApi {
  return {
    isConfigured: () => true,
    listDevicesPublic: async () => ({
      ok: true,
      devices: [
        { id: 'd1', name: 'Salon', type: 'Speaker', isActive: true },
      ],
    }),
    getNowPlaying: async () => ({
      ok: true,
      data: {
        is_playing: true,
        device: { id: 'd1', name: 'Salon', type: 'Speaker', volume_percent: 55, is_active: true },
        item: { id: 't1', name: 'Around the World', uri: 'spotify:track:t1', duration_ms: 300000 },
      },
    }),
  };
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

afterEach(() => {
  (global as { fetch?: unknown }).fetch = undefined;
});

describe('music agent planner', () => {
  test('returns spotify request when OpenAI emits a valid spotify plan', async () => {
    (global as { fetch: typeof fetch }).fetch = (async () => jsonResponse({
      choices: [
        {
          message: {
            content: JSON.stringify({
              route: 'spotify',
              reason: 'music request detected',
              request: {
                domain: 'spotify',
                action: 'play',
                slots: { device: 'alias:salon' },
                context: { custom: 'x' },
                understanding: {
                  user_goal: 'resume music',
                  intent: 'spotify.play',
                  confidence: 0.91,
                },
                response_contract: { structured: true },
                text: 'relance la musique dans le salon',
              },
            }),
          },
        },
      ],
    })) as unknown as typeof fetch;

    const result = await planSpotifyActionFromTextWithOpenAi({
      env: makeEnv(),
      spotifyWebApi: makeSpotifyApi() as unknown as Parameters<typeof planSpotifyActionFromTextWithOpenAi>[0]['spotifyWebApi'],
      text: 'relance la musique dans le salon',
      correlationId: 'corr-1',
      userId: 'u-1',
    });

    expect(result.route).toBe('spotify');
    if (result.route === 'spotify') {
      expect(result.request?.domain).toBe('spotify');
      expect(result.request?.action).toBe('play');
      expect(result.request?.slots.device).toBe('alias:salon');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((result.request as any)?.context?.planner).toBe('openai_music_agent');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((result.request as any)?.context?.payload_version).toBe('music-agent-v1');
    }
  });

  test('returns none when no OpenAI key is configured', async () => {
    const result = await planSpotifyActionFromTextWithOpenAi({
      env: makeEnv({ OPENAI_API_KEY: undefined }),
      spotifyWebApi: makeSpotifyApi() as unknown as Parameters<typeof planSpotifyActionFromTextWithOpenAi>[0]['spotifyWebApi'],
      text: 'pause spotify',
    });

    expect(result.route).toBe('none');
    expect(result.reason).toBe('openai_api_key_missing');
  });

  test('returns none when model routes request out of spotify', async () => {
    (global as { fetch: typeof fetch }).fetch = (async () => jsonResponse({
      choices: [
        {
          message: {
            content: JSON.stringify({
              route: 'none',
              reason: 'not a music command',
            }),
          },
        },
      ],
    })) as unknown as typeof fetch;

    const result = await planSpotifyActionFromTextWithOpenAi({
      env: makeEnv(),
      spotifyWebApi: makeSpotifyApi() as unknown as Parameters<typeof planSpotifyActionFromTextWithOpenAi>[0]['spotifyWebApi'],
      text: 'allume la lampe',
    });

    expect(result.route).toBe('none');
    expect(result.reason).toBe('not a music command');
  });

  test('normalizes generic resume intent to play when model emits search_and_play without target', async () => {
    (global as { fetch: typeof fetch }).fetch = (async () => jsonResponse({
      choices: [
        {
          message: {
            content: JSON.stringify({
              route: 'spotify',
              reason: 'music request detected',
              request: {
                domain: 'spotify',
                action: 'search_and_play',
                slots: { device: 'alias:pc' },
                text: 'lance la musique sur le pc',
              },
            }),
          },
        },
      ],
    })) as unknown as typeof fetch;

    const result = await planSpotifyActionFromTextWithOpenAi({
      env: makeEnv(),
      spotifyWebApi: makeSpotifyApi() as unknown as Parameters<typeof planSpotifyActionFromTextWithOpenAi>[0]['spotifyWebApi'],
      text: 'lance la musique sur le pc',
      correlationId: 'corr-2',
      userId: 'u-2',
    });

    expect(result.route).toBe('spotify');
    if (result.route === 'spotify') {
      expect(result.request?.action).toBe('play');
      expect(result.request?.slots.device).toBe('alias:pc');
    }
  });
});

describe('music agent prompt templates', () => {
  test('system prompt contains injected action catalog', () => {
    const prompt = buildMusicAgentSystemPrompt('[{"action":"play"}]');
    expect(prompt).toContain('{"action":"play"}');
  });

  test('user prompt replaces named placeholders', () => {
    const prompt = buildMusicAgentUserTemplate({
      userText: 'mets de la musique',
      musicSituation: 'Aucune lecture active.',
      metadataJson: '{"correlation_id":"c1"}',
    });

    expect(prompt).toContain('mets de la musique');
    expect(prompt).toContain('Aucune lecture active.');
    expect(prompt).toContain('{"correlation_id":"c1"}');
    expect(prompt).not.toContain('{{USER_COMMAND}}');
    expect(prompt).not.toContain('{{MUSIC_SITUATION}}');
    expect(prompt).not.toContain('{{REQUEST_METADATA}}');
  });
});
