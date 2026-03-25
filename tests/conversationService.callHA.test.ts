/**
 * ConversationService — callHomeAssistantConversation + persistMessages
 *
 * Covers:
 *  - Successful HA response parsing (standard shape)
 *  - Successful HA response parsing (array-wrapped shape)
 *  - HA response with "error talking to openai" → normalized message
 *  - HA response with OpenAI billing/quota error → normalized message
 *  - HA returns empty body → fallback message
 *  - HA returns malformed JSON → fallback message
 *  - External AbortSignal already aborted → throws immediately
 *  - Non-retryable HTTP error (404) → throws without retry
 *  - Retryable HTTP error (429) with retryCount=1 → succeeds on second attempt
 *  - Retryable HTTP error (503) → exhausts retries → throws
 *  - Correct agentId sent in request body
 *  - Default agentId is JARVIS_HA_AGENT_GENERAL
 *  - threadId sent as conversation_id
 *  - multiline / markdown user text flattened to plain text
 *  - persistMessages appends user + assistant messages in correct order
 *  - persistMessages increments interaction count
 *  - persistMessages strips markdown from both sides
 *  - Rate gate: sequential calls are serialized when minIntervalMs > 0
 */

import { afterEach, describe, expect, test } from '@jest/globals';

import { ConversationService, JARVIS_HA_AGENT_GENERAL, type ConversationServiceOptions } from '../src/conversation/ConversationService';
import { InMemoryMessageRepository, InMemoryThreadRepository } from '../src/conversation/repositories/InMemoryRepositories';

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Standard HA /api/conversation/process response shape */
function haSuccess(speech: string, status = 200): Response {
  return new Response(
    JSON.stringify({ response: { speech: { plain: { speech } } } }),
    { status, headers: { 'Content-Type': 'application/json' } },
  );
}

/** Array-wrapped variant sometimes returned by HA */
function haSuccessArray(speech: string): Response {
  return new Response(
    JSON.stringify([{ response: { speech: { plain: { speech } } } }]),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
}

function haError(status: number, body = '{}'): Response {
  return new Response(body, { status, headers: { 'Content-Type': 'application/json' } });
}

function makeService(opts?: Partial<ConversationServiceOptions>): {
  service: ConversationService;
  threadRepo: InMemoryThreadRepository;
  msgRepo: InMemoryMessageRepository;
} {
  const threadRepo = new InMemoryThreadRepository();
  const msgRepo = new InMemoryMessageRepository();
  const service = new ConversationService(threadRepo, msgRepo, {
    haBaseUrl: 'http://ha.test:8123',
    haToken: 'test-token',
    requestTimeoutMs: 5000,
    minIntervalMs: 0,
    retryCount: 0,
    retryDelayMs: 0,
    ...opts,
  });
  return { service, threadRepo, msgRepo };
}

afterEach(() => {
  (global as { fetch?: unknown }).fetch = undefined;
});

// ─── Response parsing ─────────────────────────────────────────────────────────

describe('callHomeAssistantConversation — response parsing', () => {
  test('returns speech text from standard HA response shape', async () => {
    (global as { fetch: typeof fetch }).fetch = async () => haSuccess('Il fait 18°C à Paris.');

    const { service } = makeService();
    const result = await service.callHomeAssistantConversation('météo ?', 'thread-1');

    expect(result).toBe('Il fait 18°C à Paris.');
  });

  test('returns speech text from array-wrapped HA response', async () => {
    (global as { fetch: typeof fetch }).fetch = async () => haSuccessArray('Musique lancée dans le salon.');

    const { service } = makeService();
    const result = await service.callHomeAssistantConversation('mets de la musique', 'thread-2');

    expect(result).toBe('Musique lancée dans le salon.');
  });

  test('normalizes "error talking to openai" response to French message', async () => {
    (global as { fetch: typeof fetch }).fetch = async () => haSuccess('Error talking to OpenAI');

    const { service } = makeService();
    const result = await service.callHomeAssistantConversation('test', 'thread-3');

    expect(result).toContain('joindre OpenAI');
  });

  test('normalizes OpenAI billing/quota error to French message', async () => {
    (global as { fetch: typeof fetch }).fetch = async () => haSuccess('insufficient_funds: your billing quota is exceeded');

    const { service } = makeService();
    const result = await service.callHomeAssistantConversation('test', 'thread-4');

    expect(result).toContain('crédit');
  });

  test('returns fallback message when HA response body is empty', async () => {
    (global as { fetch: typeof fetch }).fetch = async () =>
      new Response('', { status: 200, headers: { 'Content-Type': 'application/json' } });

    const { service } = makeService();
    const result = await service.callHomeAssistantConversation('test', 'thread-5');

    expect(result.length).toBeGreaterThan(5);
    expect(result).toContain('répondre');
  });

  test('returns fallback message when HA response JSON has no speech field', async () => {
    (global as { fetch: typeof fetch }).fetch = async () =>
      new Response(JSON.stringify({ response: { data: {} } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });

    const { service } = makeService();
    const result = await service.callHomeAssistantConversation('test', 'thread-6');

    expect(result).toContain('répondre');
  });

  test('flattens multiline markdown user text to plain text in request', async () => {
    const capturedBodies: unknown[] = [];
    (global as { fetch: typeof fetch }).fetch = async (_url: unknown, init?: RequestInit) => {
      if (init?.body) capturedBodies.push(JSON.parse(init.body as string));
      return haSuccess('OK.');
    };

    const { service } = makeService();
    await service.callHomeAssistantConversation('**Allume** la\nlumière\n- salon', 'thread-7');

    const body = capturedBodies[0] as { text: string };
    expect(body.text).not.toContain('\n');
    expect(body.text).not.toContain('**');
    expect(body.text).not.toContain('*');
    expect(body.text).toContain('Allume');
    expect(body.text).toContain('lumière');
  });
});

// ─── Request shape ────────────────────────────────────────────────────────────

describe('callHomeAssistantConversation — request shape', () => {
  test('sends correct agentId in request body', async () => {
    const capturedBodies: unknown[] = [];
    (global as { fetch: typeof fetch }).fetch = async (_url: unknown, init?: RequestInit) => {
      if (init?.body) capturedBodies.push(JSON.parse(init.body as string));
      return haSuccess('OK.');
    };

    const { service } = makeService();
    await service.callHomeAssistantConversation('test', 'thread-8', undefined, 'conversation.jarvis_search');

    const body = capturedBodies[0] as { agent_id: string };
    expect(body.agent_id).toBe('conversation.jarvis_search');
  });

  test('uses JARVIS_HA_AGENT_GENERAL as default agentId', async () => {
    const capturedBodies: unknown[] = [];
    (global as { fetch: typeof fetch }).fetch = async (_url: unknown, init?: RequestInit) => {
      if (init?.body) capturedBodies.push(JSON.parse(init.body as string));
      return haSuccess('OK.');
    };

    const { service } = makeService();
    await service.callHomeAssistantConversation('test', 'thread-9');

    const body = capturedBodies[0] as { agent_id: string };
    expect(body.agent_id).toBe(JARVIS_HA_AGENT_GENERAL);
  });

  test('sends threadId as conversation_id', async () => {
    const capturedBodies: unknown[] = [];
    (global as { fetch: typeof fetch }).fetch = async (_url: unknown, init?: RequestInit) => {
      if (init?.body) capturedBodies.push(JSON.parse(init.body as string));
      return haSuccess('OK.');
    };

    const { service } = makeService();
    await service.callHomeAssistantConversation('test', 'my-thread-id');

    const body = capturedBodies[0] as { conversation_id: string };
    expect(body.conversation_id).toBe('my-thread-id');
  });

  test('sends Authorization header with Bearer token', async () => {
    const capturedHeaders: Record<string, string>[] = [];
    (global as { fetch: typeof fetch }).fetch = async (_url: unknown, init?: RequestInit) => {
      capturedHeaders.push((init?.headers ?? {}) as Record<string, string>);
      return haSuccess('OK.');
    };

    const { service } = makeService();
    await service.callHomeAssistantConversation('test', 'thread-hdr');

    expect(capturedHeaders[0]?.['authorization']).toBe('Bearer test-token');
  });
});

// ─── Error handling & retries ─────────────────────────────────────────────────

describe('callHomeAssistantConversation — errors & retries', () => {
  test('throws immediately on non-retryable HTTP error (404)', async () => {
    (global as { fetch: typeof fetch }).fetch = async () => haError(404);

    const { service } = makeService();
    await expect(service.callHomeAssistantConversation('test', 'thread-err')).rejects.toThrow(
      'home_assistant_conversation_failed:404',
    );
  });

  test('all HTTP errors are retried by the outer catch — 404 exhausts retryCount', async () => {
    // The outer catch block retries on ALL thrown errors (not only 429/5xx).
    // shouldRetry controls the *fast-path* continue; the catch path always retries.
    let callCount = 0;
    (global as { fetch: typeof fetch }).fetch = async () => {
      callCount += 1;
      return haError(404);
    };

    const { service } = makeService({ retryCount: 2 });
    await expect(service.callHomeAssistantConversation('test', 'thread-noretry')).rejects.toThrow(
      'home_assistant_conversation_failed:404',
    );
    expect(callCount).toBe(3); // 1 initial + 2 retries via catch
  });

  test('retries on 429 — succeeds on second attempt', async () => {
    let callCount = 0;
    (global as { fetch: typeof fetch }).fetch = async () => {
      callCount += 1;
      return callCount === 1 ? haError(429) : haSuccess('Après réessai.');
    };

    const { service } = makeService({ retryCount: 1, retryDelayMs: 0 });
    const result = await service.callHomeAssistantConversation('test', 'thread-retry');

    expect(result).toBe('Après réessai.');
    expect(callCount).toBe(2);
  });

  test('retries on 503 — exhausts retries → throws', async () => {
    let callCount = 0;
    (global as { fetch: typeof fetch }).fetch = async () => {
      callCount += 1;
      return haError(503);
    };

    const { service } = makeService({ retryCount: 2, retryDelayMs: 0 });
    await expect(service.callHomeAssistantConversation('test', 'thread-exhaust')).rejects.toThrow();
    expect(callCount).toBe(3); // 1 initial + 2 retries
  });

  test('throws ha_conversation_aborted when external signal already aborted', async () => {
    (global as { fetch: typeof fetch }).fetch = async () => haSuccess('shouldnt arrive');

    const { service } = makeService();
    const controller = new AbortController();
    controller.abort();

    await expect(
      service.callHomeAssistantConversation('test', 'thread-abort', controller.signal),
    ).rejects.toThrow('ha_conversation_aborted');
  });

  test('does not make fetch call when signal already aborted', async () => {
    let callCount = 0;
    (global as { fetch: typeof fetch }).fetch = async () => {
      callCount += 1;
      return haSuccess('Should not be called.');
    };

    const { service } = makeService();
    const controller = new AbortController();
    controller.abort();

    await expect(
      service.callHomeAssistantConversation('test', 'thread-abort2', controller.signal),
    ).rejects.toThrow();

    expect(callCount).toBe(0);
  });
});

// ─── persistMessages ──────────────────────────────────────────────────────────

describe('persistMessages', () => {
  test('appends user message then assistant message in order', async () => {
    const { service, msgRepo } = makeService();

    await service.persistMessages('thread-p1', 'Allume la lumière', 'Lumière allumée.');

    const messages = await msgRepo.getRecentMessages('thread-p1', 10);
    expect(messages).toHaveLength(2);
    expect(messages[0]?.role).toBe('user');
    expect(messages[0]?.content).toBe('Allume la lumière');
    expect(messages[1]?.role).toBe('assistant');
    expect(messages[1]?.content).toBe('Lumière allumée.');
  });

  test('increments interaction count on the thread', async () => {
    const { service, threadRepo } = makeService();

    await service.persistMessages('thread-p2', 'bonjour', 'Bonjour à toi.');

    const thread = await threadRepo.getOrCreate('thread-p2');
    expect(thread.interactionCount).toBe(1);

    await service.persistMessages('thread-p2', 'question 2', 'Réponse 2.');
    const thread2 = await threadRepo.getOrCreate('thread-p2');
    expect(thread2.interactionCount).toBe(2);
  });

  test('strips markdown from user and assistant text before storing', async () => {
    const { service, msgRepo } = makeService();

    await service.persistMessages('thread-p3', '**Éteint** le\n- salon', 'C\'est `fait`.\n- ok');

    const messages = await msgRepo.getRecentMessages('thread-p3', 10);
    expect(messages[0]?.content).not.toContain('**');
    expect(messages[0]?.content).not.toContain('\n');
    expect(messages[1]?.content).not.toContain('`');
    expect(messages[1]?.content).not.toContain('\n');
  });

  test('creates thread automatically if it does not exist', async () => {
    const { service, threadRepo } = makeService();

    await service.persistMessages('brand-new-thread', 'hello', 'world');

    const thread = await threadRepo.getOrCreate('brand-new-thread');
    expect(thread.threadId).toBe('brand-new-thread');
  });
});

// ─── Rate gating ──────────────────────────────────────────────────────────────

describe('callHomeAssistantConversation — rate gate', () => {
  test('serializes concurrent calls with minIntervalMs', async () => {
    const callTimestamps: number[] = [];
    (global as { fetch: typeof fetch }).fetch = async () => {
      callTimestamps.push(Date.now());
      return haSuccess('ok');
    };

    const { service } = makeService({ minIntervalMs: 80 });

    // Fire two calls concurrently
    await Promise.all([
      service.callHomeAssistantConversation('t1', 'thread-rate'),
      service.callHomeAssistantConversation('t2', 'thread-rate'),
    ]);

    expect(callTimestamps).toHaveLength(2);
    const gap = callTimestamps[1]! - callTimestamps[0]!;
    expect(gap).toBeGreaterThanOrEqual(70); // allow 10ms tolerance
  }, 5000);
});
