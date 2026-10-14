import { describe, expect, jest, test } from '@jest/globals';
import type { FastifyBaseLogger } from 'fastify';
import type WebSocket from 'ws';

import {
  createConversationDb,
  SqliteMessageRepository,
  SqliteThreadRepository,
} from '../src/conversation/repositories/SqliteRepositories';
import { loadEnv } from '../src/env';
import { LiveContextAdapter } from '../src/voice/live/LiveContextAdapter';
import {
  deriveLiveIdempotencyKey,
  LiveDelegationCoordinator,
} from '../src/voice/live/LiveDelegationCoordinator';
import { LiveEventValidator } from '../src/voice/live/LiveEventValidator';
import { LiveFallbackCoordinator } from '../src/voice/live/LiveFallbackCoordinator';
import { hashLiveDeviceId, LiveSessionRegistry } from '../src/voice/live/LiveSessionRegistry';
import {
  type LiveProviderTransport,
  LiveSessionService,
} from '../src/voice/live/LiveSessionService';
import { LiveTtsAdapter } from '../src/voice/live/LiveTtsAdapter';

function createSession(registry: LiveSessionRegistry, sessionId = 'live_session_a') {
  return registry.create({
    sessionId,
    ownerUserId: 'owner-a',
    deviceHash: hashLiveDeviceId('desktop-installation-a'),
    threadId: 'thread-a',
    client: 'desktop',
    nowMs: 1_000,
    expiresAtMs: 301_000,
  });
}

function liveEnv() {
  return loadEnv({
    REQUIRE_API_KEY: 'false',
    OIDC_ENABLED: 'true',
    OIDC_ISSUER_URL: 'https://issuer.example.test/realms/jarvis',
    OIDC_AUDIENCE: 'jarvis-api',
    OPENAI_API_KEY: 'test-live-key',
    OPENAI_LIVE_ENABLED: 'true',
    OPENAI_LIVE_DESKTOP_ENABLED: 'true',
  });
}

function loggerStub(): FastifyBaseLogger {
  return { warn: jest.fn() } as unknown as FastifyBaseLogger;
}

describe('GPT-Live foundations', () => {
  test('stores only a device hash and durable delegation metadata', () => {
    const db = createConversationDb(':memory:');
    const registry = new LiveSessionRegistry(db);
    const session = createSession(registry);
    registry.observeDelegation({ sessionId: session.sessionId, delegationId: 'delegation-a', nowMs: 2_000 });

    expect(session.deviceHash).toHaveLength(64);
    expect(session.deviceHash).not.toContain('desktop-installation-a');
    expect(registry.findDelegation(session.sessionId, 'delegation-a')).toMatchObject({
      state: 'ready_to_delegate',
      operationKey: null,
    });
    expect(db.prepare('PRAGMA table_info(live_voice_sessions)').all()).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'transcript' })])
    );
    db.close();
  });

  test('absorbs the sideband race and binds one stable ingest key', async () => {
    const db = createConversationDb(':memory:');
    const registry = new LiveSessionRegistry(db);
    createSession(registry);
    const coordinator = new LiveDelegationCoordinator(registry, 30);
    const waiting = coordinator.waitUntilObserved('live_session_a', 'delegation-a', 1_000);
    coordinator.observe('live_session_a', 'delegation-a');
    await expect(waiting).resolves.toBe(true);

    const key = deriveLiveIdempotencyKey('live_session_a', 'delegation-a');
    expect(key).toMatch(/^live-[a-f0-9]{32}$/u);
    expect(deriveLiveIdempotencyKey('live_123', 'dlg_456'))
      .toBe('live-d1e56927da837293af14e44955e3a920');
    coordinator.markIngestSent('live_session_a', 'delegation-a', key);
    coordinator.markClientState('live_session_a', 'delegation-a', 'completed');
    expect(() => coordinator.markIngestSent('live_session_a', 'delegation-a', key)).not.toThrow();
    expect(() => coordinator.markClientState('live_session_a', 'delegation-a', 'ingest_running'))
      .toThrow('live_delegation_state_regression');
    expect(() => coordinator.markIngestSent('live_session_a', 'delegation-a', `${key}bad`))
      .toThrow('live_idempotency_key_mismatch');
    db.close();
  });

  test('rejects oversized, unknown, and cross-target sideband events', () => {
    const validator = new LiveEventValidator(512);
    expect(() => validator.parse(Buffer.alloc(513))).toThrow('live_event_too_large');
    expect(() => validator.parse(Buffer.from('{"type":"future.event"}')))
      .toThrow('live_event_not_allowed');
    expect(() => validator.delegationId({
      type: 'session.delegation.created',
      delegation: { id: 'delegation-a', target: 'responses' },
    })).toThrow('live_delegation_target_invalid');
    expect(validator.delegationId({
      type: 'session.delegation.created',
      delegation: { id: 'delegation-a', target: 'client' },
    })).toBe('delegation-a');
  });

  test('does not replay missing or uncertain mutations through fallback', () => {
    const fallback = new LiveFallbackCoordinator();
    expect(fallback.mayStartClassicFallback({ ingestAttempted: false, transcriptFinal: true })).toBe(true);
    expect(fallback.mayStartClassicFallback({ ingestAttempted: true, transcriptFinal: true })).toBe(false);
    expect(fallback.recoveryAction('missing')).toBe('report_uncertain');
    expect(fallback.recoveryAction('uncertain')).toBe('report_uncertain');
  });

  test('bounds seeded context without splitting ownership or persisting the note', async () => {
    const db = createConversationDb(':memory:');
    const threads = new SqliteThreadRepository(db);
    const messages = new SqliteMessageRepository(db);
    await threads.getOrCreate('thread-a');
    for (let index = 0; index < 25; index += 1) {
      await messages.appendMessage({
        threadId: 'thread-a',
        role: index % 2 === 0 ? 'user' : 'assistant',
        content: `${index}-${'é'.repeat(500)}`,
        createdAtMs: index + 1,
      });
    }
    const context = await new LiveContextAdapter(threads, messages).build(
      'thread-a',
      'Contexte visible uniquement'
    );
    expect(context.input.length).toBeLessThanOrEqual(20);
    expect(Buffer.byteLength(context.input.map((item) => item.content).join(''), 'utf8'))
      .toBeLessThanOrEqual(6_000);
    expect(context.contextNote).toBe('Contexte visible uniquement');
    db.close();
  });

  test('redacts obvious credentials from Live seed context', async () => {
    const db = createConversationDb(':memory:');
    const threads = new SqliteThreadRepository(db);
    const messages = new SqliteMessageRepository(db);
    await threads.getOrCreate('thread-secret');
    await messages.appendMessage({
      threadId: 'thread-secret',
      role: 'user',
      content: 'token: abcdefghijklmnopqrstuvwxyz et sk-proj-abcdefghijklmnopqrstuvwxyz',
      createdAtMs: 1,
    });
    const context = await new LiveContextAdapter(threads, messages).build('thread-secret');
    expect(context.input[0]?.content).not.toContain('abcdefghijklmnopqrstuvwxyz');
    expect(context.input[0]?.content).toContain('[secret retiré]');
    db.close();
  });

  test('accepts only complete and faithful HA TTS candidates', () => {
    const tts = new LiveTtsAdapter();
    const base = {
      requestedText: 'Bonjour, la lumière est éteinte.',
      outputTranscript: 'Bonjour, la lumière est éteinte.',
      audio: Buffer.alloc(4_800),
      durationMs: 1_000,
      quietWindowElapsed: true,
    };
    expect(tts.validateCandidate(base)).toEqual({ ok: true });
    expect(tts.validateCandidate({ ...base, outputTranscript: 'Bonjour.' })).toMatchObject({ ok: false });
    expect(tts.validateCandidate({ ...base, quietWindowElapsed: false })).toMatchObject({ ok: false });
    expect(tts.validateCandidate({ ...base, durationMs: 13_000 })).toMatchObject({ ok: false });
  });

  test('does not return a client session before the sideband is attached', async () => {
    const db = createConversationDb(':memory:');
    const registry = new LiveSessionRegistry(db);
    const threads = new SqliteThreadRepository(db);
    const messages = new SqliteMessageRepository(db);
    await threads.getOrCreate('thread-a');
    const events: string[] = [];
    const socket = { readyState: 1 } as WebSocket;
    const transport: LiveProviderTransport = {
      create: async () => {
        events.push('created');
        return { session: { id: 'live_provider_a' }, transport: { type: 'webrtc', sdp: 'answer' } };
      },
      attach: async () => {
        events.push('attached');
        return socket;
      },
      hangup: async () => { events.push('hung_up'); },
    };
    const coordinator = new LiveDelegationCoordinator(registry, 10);
    const service = new LiveSessionService(
      liveEnv(), registry, coordinator, new LiveContextAdapter(threads, messages),
      new LiveEventValidator(65_536), loggerStub(), transport
    );

    await expect(service.create({
      ownerUserId: 'owner-a', threadId: 'thread-a', client: 'desktop',
      deviceId: 'desktop-a', sdp: 'offer',
    })).resolves.toMatchObject({ sessionId: 'live_provider_a', sdp: 'answer' });
    expect(events).toEqual(['created', 'attached']);
    expect(registry.find('live_provider_a')).toMatchObject({ state: 'active', sidebandAttached: true });
    db.close();
  });

  test('hangs up and records an unconfirmed close when sideband attachment fails', async () => {
    const db = createConversationDb(':memory:');
    const registry = new LiveSessionRegistry(db);
    const threads = new SqliteThreadRepository(db);
    const messages = new SqliteMessageRepository(db);
    await threads.getOrCreate('thread-a');
    const hangup = jest.fn<LiveProviderTransport['hangup']>(async () => undefined);
    const transport: LiveProviderTransport = {
      create: async () => ({
        session: { id: 'live_provider_failed' },
        transport: { type: 'webrtc', sdp: 'answer' },
      }),
      attach: async () => { throw new Error('attach_failed'); },
      hangup,
    };
    const coordinator = new LiveDelegationCoordinator(registry, 10);
    const service = new LiveSessionService(
      liveEnv(), registry, coordinator, new LiveContextAdapter(threads, messages),
      new LiveEventValidator(65_536), loggerStub(), transport
    );

    await expect(service.create({
      ownerUserId: 'owner-a', threadId: 'thread-a', client: 'desktop',
      deviceId: 'desktop-a', sdp: 'offer',
    })).rejects.toThrow('attach_failed');
    expect(hangup).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'live_provider_failed' }));
    expect(registry.find('live_provider_failed')).toMatchObject({
      state: 'finalization_unconfirmed',
      lastErrorCode: 'sideband_attach_failed',
    });
    db.close();
  });
});
