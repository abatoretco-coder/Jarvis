import { afterEach, describe, expect, jest, test } from '@jest/globals';

import {
  completeOpenAiResponse,
  getOpenAiTelemetrySnapshot,
  requestOpenAiResponse,
  resetOpenAiTelemetryForTests,
} from '../src/openai/responsesClient';

describe('OpenAI Responses client', () => {
  afterEach(() => {
    jest.restoreAllMocks();
    resetOpenAiTelemetryForTests();
  });

  test('uses the Responses contract with storage disabled and bounded output', async () => {
    const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      status: 'completed',
      output: [{ type: 'message', content: [{ type: 'output_text', text: '{"route":"weather"}' }] }],
      usage: { input_tokens: 17, output_tokens: 5, total_tokens: 22 },
    }), { status: 200 }));

    const result = await completeOpenAiResponse({
      apiKey: 'secret-test-key',
      baseUrl: 'https://api.openai.test/v1/',
      model: 'gpt-6-luna',
      capability: 'router',
      messages: [{ role: 'user', content: 'Quel temps fait-il ?' }],
      maxOutputTokens: 128,
      timeoutMs: 1_000,
      jsonSchema: {
        name: 'route',
        schema: { type: 'object', properties: { route: { type: 'string' } }, required: ['route'], additionalProperties: false },
      },
      reasoningEffort: 'none',
    });

    expect(result).toBe('{"route":"weather"}');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://api.openai.test/v1/responses');
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer secret-test-key');
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    expect(body).toMatchObject({
      model: 'gpt-6-luna',
      store: false,
      max_output_tokens: 128,
      reasoning: { effort: 'none' },
      text: { format: { type: 'json_schema', name: 'route', strict: true } },
    });
    expect(body).not.toHaveProperty('messages');
  });

  test('exposes aggregate operational telemetry without prompts or credentials', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      status: 'completed',
      output_text: 'Résumé prêt.',
      usage: { input_tokens: 12, output_tokens: 4, total_tokens: 16 },
    }), { status: 200 }));

    await completeOpenAiResponse({
      apiKey: 'must-not-leak',
      baseUrl: 'https://api.openai.test/v1',
      model: 'gpt-6-luna',
      capability: 'summary',
      messages: [{ role: 'user', content: 'private prompt' }],
      maxOutputTokens: 64,
      timeoutMs: 1_000,
    });

    const telemetry = getOpenAiTelemetrySnapshot();
    expect(telemetry).toMatchObject({
      requests: 1,
      successes: 1,
      failures: 0,
      inputTokens: 12,
      outputTokens: 4,
      totalTokens: 16,
      capabilities: { summary: { lastModel: 'gpt-6-luna', lastStatus: 200 } },
    });
    expect(JSON.stringify(telemetry)).not.toContain('must-not-leak');
    expect(JSON.stringify(telemetry)).not.toContain('private prompt');
  });

  test('rejects incomplete responses and records a failure', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      status: 'incomplete',
      incomplete_details: { reason: 'max_output_tokens' },
      output: [],
    }), { status: 200 }));

    await expect(completeOpenAiResponse({
      apiKey: 'test-key',
      baseUrl: 'https://api.openai.test/v1',
      model: 'gpt-6-luna',
      capability: 'agent',
      messages: [{ role: 'user', content: 'test' }],
      maxOutputTokens: 16,
      timeoutMs: 1_000,
    })).rejects.toThrow('openai_responses_incomplete_max_output_tokens');
    expect(getOpenAiTelemetrySnapshot()).toMatchObject({ requests: 1, successes: 0, failures: 1 });
  });

  test('requires web search when requested and preserves structured citations', async () => {
    const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      status: 'completed',
      output: [{
        type: 'message',
        content: [{
          type: 'output_text',
          text: 'Résultat sourcé.',
          annotations: [
            { type: 'url_citation', url: 'https://example.test/source', title: 'Source' },
            { type: 'url_citation', url: 'https://example.test/source', title: 'Duplicate' },
          ],
        }],
      }],
    }), { status: 200 }));

    const result = await requestOpenAiResponse({
      apiKey: 'test-key',
      baseUrl: 'https://api.openai.test/v1',
      model: 'gpt-6-luna',
      capability: 'synthesis',
      messages: [{ role: 'user', content: 'actualité' }],
      maxOutputTokens: 128,
      timeoutMs: 1_000,
      tools: [{ type: 'web_search' }],
      toolChoice: 'required',
    });

    expect(result).toEqual({ text: 'Résultat sourcé.', sources: ['https://example.test/source'] });
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as Record<string, unknown>;
    expect(body).toMatchObject({ tools: [{ type: 'web_search' }], tool_choice: 'required', store: false });
  });

  test('rejects a Chat Completions response shape on the Responses endpoint', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { content: 'legacy' } }],
    }), { status: 200 }));

    await expect(completeOpenAiResponse({
      apiKey: 'test-key',
      baseUrl: 'https://api.openai.test/v1',
      model: 'gpt-6-luna',
      capability: 'agent',
      messages: [{ role: 'user', content: 'test' }],
      maxOutputTokens: 32,
      timeoutMs: 1_000,
    })).rejects.toThrow('openai_responses_empty_output');
  });

  test('does not send reasoning options to models that do not support them', async () => {
    const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      status: 'completed', output_text: 'ok',
    }), { status: 200 }));

    await completeOpenAiResponse({
      apiKey: 'test-key',
      baseUrl: 'https://api.openai.test/v1',
      model: 'gpt-4o-mini',
      capability: 'synthesis',
      messages: [{ role: 'user', content: 'test' }],
      maxOutputTokens: 64,
      timeoutMs: 1_000,
      reasoningEffort: 'low',
    });

    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as Record<string, unknown>;
    expect(body).not.toHaveProperty('reasoning');
  });
});
