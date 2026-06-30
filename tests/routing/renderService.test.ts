import { describe, expect, it, jest } from '@jest/globals';

import { SPOTIFY_PAUSE_RESPONSES } from '../../src/routing/deterministic/spotifyResponses';
import { renderMultipleExecutionResults, renderSingleExecutionResult } from '../../src/routing/render/renderService';
import type { ActionExecutionResult } from '../../src/routing/render/types';

function makeResult(overrides: Partial<ActionExecutionResult> = {}): ActionExecutionResult {
  return {
    status: 'success',
    domain: 'general',
    actionKey: 'general.unknown',
    facts: {},
    ...overrides,
  };
}

describe('renderService', () => {
  it('renders deterministic static response for spotify.pause', async () => {
    const text = await renderSingleExecutionResult(
      makeResult({ domain: 'spotify', actionKey: 'spotify.pause' }),
      { timeoutMs: 1000 },
    );

    expect(SPOTIFY_PAUSE_RESPONSES).toContain(text);
  });

  it('renders deterministic template for spotify.now_playing', async () => {
    const text = await renderSingleExecutionResult(
      makeResult({
        domain: 'spotify',
        actionKey: 'spotify.now_playing',
        facts: {
          data: {
            track_name: 'One More Time',
            artist_name: 'Daft Punk',
          },
        },
      }),
      { timeoutMs: 1000 },
    );

    expect(text).toContain('One More Time');
    expect(text).toContain('Daft Punk');
  });

  it('renders deterministic template for spotify.list_devices', async () => {
    const text = await renderSingleExecutionResult(
      makeResult({
        domain: 'spotify',
        actionKey: 'spotify.list_devices',
        facts: {
          data: {
            devices: [{ name: 'Salon' }, { name: 'Bureau' }],
          },
        },
      }),
      { timeoutMs: 1000 },
    );

    expect(text).toContain('Salon');
    expect(text).toContain('Bureau');
  });

  it('falls back to raw text when llm rephrase is configured but deps are missing', async () => {
    const text = await renderSingleExecutionResult(
      makeResult({
        domain: 'search',
        actionKey: 'search.deep.analysis',
        rawText: 'Analyse complete des causes principales.',
      }),
      { timeoutMs: 1000 },
    );

    expect(text).toBe('Analyse complete des causes principales.');
  });

  it('renders deterministic error on need_clarification', async () => {
    const text = await renderSingleExecutionResult(
      makeResult({
        status: 'need_clarification',
        domain: 'executors',
        actionKey: 'executor.lock',
      }),
      { timeoutMs: 1000 },
    );

    expect(text.toLowerCase()).toContain('précision');
  });

  it('renders multiple execution results with deterministic fallback when LLM deps are missing', async () => {
    const text = await renderMultipleExecutionResults([
      makeResult({ domain: 'search', actionKey: 'search.web.quick_lookup', rawText: 'Resultat search.' }),
      makeResult({ domain: 'spotify', actionKey: 'spotify.now_playing', facts: { data: { track_name: 'Aerodynamic', artist_name: 'Daft Punk' } } }),
    ], { timeoutMs: 1000 });

    expect(text).toContain('Resultat search.');
    expect(text).toContain('Aerodynamic');
    expect(text).toContain('Daft Punk');
  });

  it('uses LLM multi synthesis when configured', async () => {
    const originalFetch = global.fetch;
    global.fetch = jest.fn(async () => new Response(JSON.stringify({
      choices: [{ message: { content: 'Synthese courte.' } }],
    }), { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;

    try {
      const text = await renderMultipleExecutionResults([
        makeResult({ domain: 'search', actionKey: 'search.web.quick_lookup', rawText: 'Resultat search.' }),
        makeResult({ domain: 'todo', actionKey: 'todo.list_tasks', rawText: 'Deux taches.' }),
      ], {
        timeoutMs: 1000,
        openAiApiKey: 'test-key',
        openAiBaseUrl: 'https://api.openai.test/v1',
        openAiModel: 'gpt-test',
      });

      expect(text).toBe('Synthese courte.');
      expect(global.fetch).toHaveBeenCalledTimes(1);
    } finally {
      global.fetch = originalFetch;
    }
  });
});

