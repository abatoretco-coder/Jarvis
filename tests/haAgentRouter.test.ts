import { afterEach, describe, expect, test } from '@jest/globals';

import {
  parseAgentMap,
  routeToHaAgent,
  SPOTIFY_AGENT_ID,
} from '../src/conversation/haAgentRouter';
import type { HaAgentEntry, RouterOptions } from '../src/conversation/haAgentRouter';

// ─── Helpers ─────────────────────────────────────────────────────────────────

const AGENTS: HaAgentEntry[] = [
  { agentId: SPOTIFY_AGENT_ID, hint: 'Musique Spotify' },
  { agentId: 'conversation.jarvis_search', hint: 'Recherche internet' },
  { agentId: 'conversation.jarvis_executors', hint: 'Domotique météo calendrier' },
];

const BASE_URL = 'https://api.openai.test/v1';

const DEFAULT_OPTIONS: RouterOptions = {
  openAiApiKey: 'test-key',
  openAiBaseUrl: BASE_URL,
  model: 'gpt-4o-mini',
  timeoutMs: 3000,
  confidenceThreshold: 0.70,
  generalAgentId: 'conversation.jarvis_conversation',
};

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function openAiResponse(content: string, status = 200): Response {
  return jsonResponse(
    { choices: [{ message: { content } }] },
    status,
  );
}

afterEach(() => {
  (global as { fetch?: unknown }).fetch = undefined;
});

// ─── parseAgentMap ────────────────────────────────────────────────────────────

describe('parseAgentMap', () => {
  test('returns empty array for undefined', () => {
    expect(parseAgentMap(undefined)).toEqual([]);
  });

  test('returns empty array for empty string', () => {
    expect(parseAgentMap('')).toEqual([]);
  });

  test('returns empty array for whitespace-only string', () => {
    expect(parseAgentMap('   ')).toEqual([]);
  });

  test('parses a single entry correctly', () => {
    const result = parseAgentMap('search:conversation.jarvis_search:Recherche internet');
    expect(result).toEqual([
      { agentId: 'conversation.jarvis_search', hint: 'Recherche internet' },
    ]);
  });

  test('parses multiple entries separated by pipe', () => {
    const result = parseAgentMap(
      'search:conversation.jarvis_search:Recherche internet|executors:conversation.jarvis_executors:Domotique météo',
    );
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ agentId: 'conversation.jarvis_search', hint: 'Recherche internet' });
    expect(result[1]).toEqual({ agentId: 'conversation.jarvis_executors', hint: 'Domotique météo' });
  });

  test('hint may contain colons (splits on first two only)', () => {
    const result = parseAgentMap('search:conversation.jarvis_search:Recherche: internet et actualités');
    expect(result).toHaveLength(1);
    expect(result[0]?.hint).toBe('Recherche: internet et actualités');
  });

  test('skips malformed entries (missing second colon)', () => {
    const result = parseAgentMap('bad_entry|search:conversation.jarvis_search:Recherche internet');
    expect(result).toHaveLength(1);
    expect(result[0]?.agentId).toBe('conversation.jarvis_search');
  });

  test('skips entries with empty entity_id or hint', () => {
    // entity_id empty
    const r1 = parseAgentMap('k::some hint');
    expect(r1).toHaveLength(0);
    // hint empty
    const r2 = parseAgentMap('k:conversation.jarvis_search:');
    expect(r2).toHaveLength(0);
  });
});

// ─── routeToHaAgent ───────────────────────────────────────────────────────────

describe('routeToHaAgent', () => {
  test('returns single spotify target when LLM picks spotify', async () => {
    (global as { fetch: typeof fetch }).fetch = (async () =>
      openAiResponse(
        JSON.stringify({ targets: [{ agentId: SPOTIFY_AGENT_ID, confidence: 0.95 }], reason: 'music request' }),
      )) as unknown as typeof fetch;

    const result = await routeToHaAgent({
      text: 'lance une playlist jazz',
      agents: AGENTS,
      recentMessages: [],
      options: DEFAULT_OPTIONS,
    });

    expect(result.targets).toHaveLength(1);
    expect(result.targets[0]?.agentId).toBe(SPOTIFY_AGENT_ID);
    expect(result.targets[0]?.confidence).toBe(0.95);
    expect(result.reason).toBe('music request');
  });

  test('returns multi-target for mixed music + weather request', async () => {
    (global as { fetch: typeof fetch }).fetch = (async () =>
      openAiResponse(
        JSON.stringify({
          targets: [
            { agentId: SPOTIFY_AGENT_ID, confidence: 0.92 },
            { agentId: 'conversation.jarvis_executors', confidence: 0.88 },
          ],
          reason: 'music and weather',
        }),
      )) as unknown as typeof fetch;

    const result = await routeToHaAgent({
      text: 'lance de la musique et dis-moi la météo',
      agents: AGENTS,
      recentMessages: [],
      options: DEFAULT_OPTIONS,
    });

    expect(result.targets).toHaveLength(2);
    const agentIds = result.targets.map((t) => t.agentId);
    expect(agentIds).toContain(SPOTIFY_AGENT_ID);
    expect(agentIds).toContain('conversation.jarvis_executors');
  });

  test('returns search target for an internet query', async () => {
    (global as { fetch: typeof fetch }).fetch = (async () =>
      openAiResponse(
        JSON.stringify({
          targets: [{ agentId: 'conversation.jarvis_search', confidence: 0.91 }],
          reason: 'web search needed',
        }),
      )) as unknown as typeof fetch;

    const result = await routeToHaAgent({
      text: "qui a gagné le GP de F1 hier",
      agents: AGENTS,
      recentMessages: [],
      options: DEFAULT_OPTIONS,
    });

    expect(result.targets[0]?.agentId).toBe('conversation.jarvis_search');
  });

  test('filters out unknown agentIds returned by LLM', async () => {
    (global as { fetch: typeof fetch }).fetch = (async () =>
      openAiResponse(
        JSON.stringify({
          targets: [
            { agentId: 'conversation.invented_agent', confidence: 0.9 },
            { agentId: 'conversation.jarvis_search', confidence: 0.85 },
          ],
          reason: 'mixed',
        }),
      )) as unknown as typeof fetch;

    const result = await routeToHaAgent({
      text: 'test',
      agents: AGENTS,
      recentMessages: [],
      options: DEFAULT_OPTIONS,
    });

    // invented_agent filtered out, only jarvis_search remains
    expect(result.targets).toHaveLength(1);
    expect(result.targets[0]?.agentId).toBe('conversation.jarvis_search');
  });

  test('throws when all returned agentIds are unknown', async () => {
    (global as { fetch: typeof fetch }).fetch = (async () =>
      openAiResponse(
        JSON.stringify({
          targets: [{ agentId: 'conversation.ghost', confidence: 0.99 }],
          reason: 'unknown',
        }),
      )) as unknown as typeof fetch;

    await expect(
      routeToHaAgent({ text: 'test', agents: AGENTS, recentMessages: [], options: DEFAULT_OPTIONS }),
    ).rejects.toThrow('router_no_valid_targets');
  });

  test('throws on OpenAI HTTP error', async () => {
    (global as { fetch: typeof fetch }).fetch = (async () =>
      jsonResponse({ error: 'unauthorized' }, 401)) as unknown as typeof fetch;

    await expect(
      routeToHaAgent({ text: 'test', agents: AGENTS, recentMessages: [], options: DEFAULT_OPTIONS }),
    ).rejects.toThrow('router_openai_http_401');
  });

  test('throws on invalid JSON in LLM response', async () => {
    (global as { fetch: typeof fetch }).fetch = (async () =>
      openAiResponse('not json at all')) as unknown as typeof fetch;

    await expect(
      routeToHaAgent({ text: 'test', agents: AGENTS, recentMessages: [], options: DEFAULT_OPTIONS }),
    ).rejects.toThrow('router_invalid_json');
  });

  test('throws when targets array is missing from LLM response', async () => {
    (global as { fetch: typeof fetch }).fetch = (async () =>
      openAiResponse(JSON.stringify({ reason: 'forgot targets' }))) as unknown as typeof fetch;

    await expect(
      routeToHaAgent({ text: 'test', agents: AGENTS, recentMessages: [], options: DEFAULT_OPTIONS }),
    ).rejects.toThrow('router_no_valid_targets');
  });

  test('includes summary and recent messages in user prompt (smoke test)', async () => {
    const capturedBodies: unknown[] = [];

    (global as { fetch: typeof fetch }).fetch = (async (_url: unknown, init?: RequestInit) => {
      if (init?.body) capturedBodies.push(JSON.parse(init.body as string));
      return openAiResponse(
        JSON.stringify({ targets: [{ agentId: SPOTIFY_AGENT_ID, confidence: 0.9 }], reason: 'music' }),
      );
    }) as unknown as typeof fetch;

    await routeToHaAgent({
      text: 'mets de la musique',
      agents: AGENTS,
      summary: 'Utilisateur au salon.',
      recentMessages: [
        { threadId: 't1', role: 'user', content: 'bonjour', createdAtMs: Date.now(), seq: 1 },
        { threadId: 't1', role: 'assistant', content: 'Bonjour.', createdAtMs: Date.now(), seq: 2 },
      ],
      options: DEFAULT_OPTIONS,
    });

    expect(capturedBodies).toHaveLength(1);
    const body = capturedBodies[0] as { messages: Array<{ role: string; content: string }> };
    const userMessage = body.messages.find((m) => m.role === 'user')?.content ?? '';
    expect(userMessage).toContain('Utilisateur au salon.');
    expect(userMessage).toContain('bonjour');
    expect(userMessage).toContain('mets de la musique');
  });

  test('times out when fetch hangs beyond timeoutMs', async () => {
    (global as { fetch: typeof fetch }).fetch = (async () =>
      new Promise<Response>((resolve) => setTimeout(() => resolve(jsonResponse({})), 5000))) as unknown as typeof fetch;

    await expect(
      routeToHaAgent({
        text: 'test',
        agents: AGENTS,
        recentMessages: [],
        options: { ...DEFAULT_OPTIONS, timeoutMs: 50 },
      }),
    ).rejects.toThrow();
  }, 10000);
});

// ─── OUT_OF_SCOPE detection (regex contract) ──────────────────────────────────

describe('OUT_OF_SCOPE contract', () => {
  const outOfScopePattern = /^\s*OUT_OF_SCOPE\s*$/i;

  test('detects exact OUT_OF_SCOPE', () => {
    expect(outOfScopePattern.test('OUT_OF_SCOPE')).toBe(true);
  });

  test('detects with surrounding whitespace', () => {
    expect(outOfScopePattern.test('  OUT_OF_SCOPE  \n')).toBe(true);
  });

  test('detects lowercase variant', () => {
    expect(outOfScopePattern.test('out_of_scope')).toBe(true);
  });

  test('does NOT match when preceded by other text', () => {
    expect(outOfScopePattern.test('Sorry, OUT_OF_SCOPE for me')).toBe(false);
  });

  test('does NOT match partial word', () => {
    expect(outOfScopePattern.test('OUT_OF_SCOPE_EXTRA')).toBe(false);
  });
});
