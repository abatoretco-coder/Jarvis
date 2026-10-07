import { afterEach, describe, expect, jest, test } from '@jest/globals';

import {
  executeOpenAiOperation,
  getOpenAiResilienceSnapshot,
  OpenAiHttpError,
  resetOpenAiResilienceForTests,
  retryAfterMsFromHeaders,
} from '../src/openai/resilience';

describe('OpenAI resilience policy', () => {
  afterEach(() => {
    jest.restoreAllMocks();
    resetOpenAiResilienceForTests();
  });

  test('retries a transient response within the configured bound', async () => {
    resetOpenAiResilienceForTests({ maxRetries: 2, retryBaseDelayMs: 10, retryMaxDelayMs: 10 });
    let calls = 0;
    const result = await executeOpenAiOperation({
      capability: 'router',
      model: 'test-model',
      operation: async () => {
        calls += 1;
        if (calls === 1) throw new OpenAiHttpError(429, 1);
        return { value: 'ok', status: 200 };
      },
    });

    expect(result).toBe('ok');
    expect(calls).toBe(2);
    expect(getOpenAiResilienceSnapshot()).toMatchObject({
      requests: 1,
      attempts: 2,
      retries: 1,
      successes: 1,
      capabilities: { router: { status: 'ok' } },
    });
  });

  test('does not retry authentication or validation failures', async () => {
    resetOpenAiResilienceForTests({ maxRetries: 2 });
    const operation = jest.fn(async () => { throw new OpenAiHttpError(401); });

    await expect(executeOpenAiOperation({ capability: 'agent', operation }))
      .rejects.toThrow('openai_http_401');
    expect(operation).toHaveBeenCalledTimes(1);
  });

  test('does not retry before a Retry-After value beyond the local wait ceiling', async () => {
    resetOpenAiResilienceForTests({ maxRetries: 2, retryMaxDelayMs: 100 });
    const operation = jest.fn(async () => { throw new OpenAiHttpError(429, 5_000); });

    await expect(executeOpenAiOperation({ capability: 'agent', operation })).rejects.toThrow('openai_http_429');
    expect(operation).toHaveBeenCalledTimes(1);
  });

  test('records caller cancellation without poisoning the provider circuit', async () => {
    resetOpenAiResilienceForTests({ maxRetries: 0, circuitFailureThreshold: 1 });
    const controller = new AbortController();
    controller.abort();

    await expect(executeOpenAiOperation({
      capability: 'router',
      signal: controller.signal,
      operation: async () => ({ value: 'never' }),
    })).rejects.toBeDefined();
    expect(getOpenAiResilienceSnapshot()).toMatchObject({
      status: 'degraded',
      capabilities: { router: { circuit: 'closed', degradedReasons: ['last_error:aborted'] } },
    });
  });

  test('cancels a pending retry when the runtime is reconfigured', async () => {
    resetOpenAiResilienceForTests({ maxRetries: 2, retryBaseDelayMs: 1_000, retryMaxDelayMs: 1_000 });
    const operation = jest.fn(async () => { throw new TypeError('network down'); });
    const running = executeOpenAiOperation({ capability: 'router', operation });
    await new Promise<void>((resolve) => setImmediate(resolve));

    resetOpenAiResilienceForTests();

    await expect(running).rejects.toBeDefined();
    expect(operation).toHaveBeenCalledTimes(1);
  });

  test('opens the circuit after consecutive failures and fails fast', async () => {
    resetOpenAiResilienceForTests({ maxRetries: 0, circuitFailureThreshold: 2, circuitOpenMs: 30_000 });
    const operation = jest.fn(async () => { throw new OpenAiHttpError(503); });

    await expect(executeOpenAiOperation({ capability: 'summary', operation })).rejects.toThrow('openai_http_503');
    await expect(executeOpenAiOperation({ capability: 'summary', operation })).rejects.toThrow('openai_http_503');
    await expect(executeOpenAiOperation({ capability: 'summary', operation }))
      .rejects.toEqual(expect.objectContaining({ code: 'openai_circuit_open' }));

    expect(operation).toHaveBeenCalledTimes(2);
    expect(getOpenAiResilienceSnapshot()).toMatchObject({
      status: 'degraded',
      capabilities: { summary: { circuit: 'open', rejectedByCircuit: 1 } },
    });
  });

  test('allows one half-open probe and closes the circuit after recovery', async () => {
    let now = 1_000;
    jest.spyOn(Date, 'now').mockImplementation(() => now);
    resetOpenAiResilienceForTests({ maxRetries: 0, circuitFailureThreshold: 1, circuitOpenMs: 1_000 });
    await expect(executeOpenAiOperation({
      capability: 'music',
      operation: async () => { throw new OpenAiHttpError(503); },
    })).rejects.toThrow('openai_http_503');

    now = 2_001;
    await expect(executeOpenAiOperation({
      capability: 'music',
      operation: async () => ({ value: 'recovered', status: 200 }),
    })).resolves.toBe('recovered');
    expect(getOpenAiResilienceSnapshot(now)).toMatchObject({
      status: 'ok',
      capabilities: { music: { circuit: 'closed', status: 'ok' } },
    });
  });

  test('enforces request and token budgets without exposing operation content', async () => {
    resetOpenAiResilienceForTests({ budgetMaxRequests: 2, budgetMaxTokens: 10 });
    await executeOpenAiOperation({
      capability: 'synthesis',
      model: 'private-model-name-is-operational',
      operation: async () => ({
        value: 'private output',
        status: 200,
        usage: { inputTokens: 7, outputTokens: 3, totalTokens: 10 },
      }),
    });
    await expect(executeOpenAiOperation({
      capability: 'synthesis',
      operation: async () => ({ value: 'should not run' }),
    })).rejects.toEqual(expect.objectContaining({ code: 'openai_budget_exhausted' }));

    const snapshot = getOpenAiResilienceSnapshot();
    expect(snapshot).toMatchObject({
      status: 'degraded',
      budget: { requests: 1, tokens: 10, exhausted: true },
      capabilities: { synthesis: { rejectedByBudget: 1 } },
    });
    expect(JSON.stringify(snapshot)).not.toContain('private output');
  });

  test('parses Retry-After seconds and HTTP dates', () => {
    expect(retryAfterMsFromHeaders(new Headers({ 'retry-after': '2' }), 1_000)).toBe(2_000);
    expect(retryAfterMsFromHeaders(new Headers({ 'retry-after': 'Thu, 01 Jan 1970 00:00:05 GMT' }), 1_000)).toBe(4_000);
    expect(retryAfterMsFromHeaders(new Headers({ 'retry-after': 'invalid' }), 1_000)).toBeUndefined();
  });
});
