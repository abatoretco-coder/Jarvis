import { describe, expect, it } from '@jest/globals';

import { SPOTIFY_PAUSE_RESPONSES } from '../../src/routing/deterministic/spotifyResponses';
import { renderSingleExecutionResult } from '../../src/routing/render/renderService';
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

describe('renderSingleExecutionResult', () => {
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
});
