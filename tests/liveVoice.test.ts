import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, jest, test } from '@jest/globals';
import Fastify, { type FastifyBaseLogger, type FastifyRequest } from 'fastify';
import type WebSocket from 'ws';

import {
  createConversationDb,
  SqliteMessageRepository,
  SqliteThreadRepository,
} from '../src/conversation/repositories/SqliteRepositories';
import { loadEnv } from '../src/env';
import { MutationIdempotencyCoordinator } from '../src/idempotency/MutationIdempotencyCoordinator';
import type { UserPrincipal } from '../src/identity/IdentityService';
import {
  runWithRequestIdentityContext,
  setRequestPrincipal,
} from '../src/identity/requestIdentity';
import { registerLiveIngestValidationHook } from '../src/routes/liveVoice';
import { registerMutationIdempotencyHooks } from '../src/routes/mutationIdempotency';
import { canUseLivePilot } from '../src/voice/live/LiveAccessPolicy';
import { LiveContextAdapter } from '../src/voice/live/LiveContextAdapter';
import {
  deriveLiveIdempotencyKey,
  LiveDelegationCoordinator,
} from '../src/voice/live/LiveDelegationCoordinator';
import { LiveEventValidator } from '../src/voice/live/LiveEventValidator';
import { LiveFallbackCoordinator } from '../src/voice/live/LiveFallbackCoordinator';
import { buildLivePilotReport } from '../src/voice/live/LivePilotReport';
import { hashLiveDeviceId, LiveSessionRegistry } from '../src/voice/live/LiveSessionRegistry';
import {
  type LiveProviderTransport,
  LiveSessionService,
} from '../src/voice/live/LiveSessionService';
import { LiveTtsAdapter } from '../src/voice/live/LiveTtsAdapter';

function createSession(registry: LiveSessionRegistry, sessionId = 'live_session_a') {
  const nowMs = Date.now();
  return registry.create({
    sessionId,
    ownerUserId: 'owner-a',
    deviceHash: hashLiveDeviceId('desktop-installation-a'),
    threadId: 'thread-a',
    client: 'desktop',
    nowMs,
    expiresAtMs: nowMs + 300_000,
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

const ownerPrincipal: UserPrincipal = {
  kind: 'user' as const,
  userId: 'owner-a',
  email: 'owner-a@example.test',
  displayName: 'Owner A',
  roles: ['owner'],
  permissions: ['chat' as const],
  status: 'active' as const,
  sessionId: 'identity-session-a',
};

async function createOwnedThread(db: ReturnType<typeof createConversationDb>, threadId: string) {
  await runWithRequestIdentityContext(async () => {
    const request = {} as FastifyRequest;
    setRequestPrincipal(request, ownerPrincipal);
    await new SqliteThreadRepository(db).getOrCreate(threadId);
  });
}

async function createLiveIngestHarness() {
  const db = createConversationDb(':memory:');
  db.prepare(
    `INSERT INTO users(user_id,email_normalized,display_name,status,created_at_ms,updated_at_ms)
     VALUES (?,?,?,?,?,?)`
  ).run('owner-a', 'owner-a@example.test', 'Owner A', 'active', 1, 1);
  await createOwnedThread(db, 'thread-a');
  await createOwnedThread(db, 'thread-b');
  const registry = new LiveSessionRegistry(db);
  const nowMs = Date.now();
  for (const [sessionId, threadId] of [
    ['live_session_a', 'thread-a'],
    ['live_session_b', 'thread-a'],
  ] as const) {
    registry.create({
      sessionId,
      ownerUserId: 'owner-a',
      deviceHash: hashLiveDeviceId(`device-${sessionId}`),
      threadId,
      client: 'desktop',
      nowMs,
      expiresAtMs: nowMs + 300_000,
    });
  }
  const delegations = new LiveDelegationCoordinator(registry, 30);
  delegations.observe('live_session_a', 'delegation-a');
  delegations.observe('live_session_b', 'delegation-b');
  const live = {
    sessions: { pilotOwnerOnly: true },
    registry,
    delegations,
    fallback: new LiveFallbackCoordinator(),
    tts: new LiveTtsAdapter(),
  } as unknown as Parameters<typeof registerLiveIngestValidationHook>[1];
  const app = Fastify();
  app.addHook('onRequest', (_request, _reply, done) => runWithRequestIdentityContext(done));
  app.addHook('preHandler', async (request) => setRequestPrincipal(request, ownerPrincipal));
  registerLiveIngestValidationHook(app, live, db);
  const idempotency = new MutationIdempotencyCoordinator();
  registerMutationIdempotencyHooks(app, idempotency);
  return { app, db, registry, delegations };
}

afterEach(() => {
  jest.useRealTimers();
});

describe('GPT-Live foundations', () => {
  test('keeps the pilot owner-only until the explicit rollout switch is disabled', () => {
    const owner = { kind: 'user', roles: ['owner'] } as Parameters<typeof canUseLivePilot>[0];
    const resident = { kind: 'user', roles: ['resident'] } as Parameters<typeof canUseLivePilot>[0];
    const service = { kind: 'service', permissions: ['chat'] } as Parameters<typeof canUseLivePilot>[0];
    expect(canUseLivePilot(owner, true)).toBe(true);
    expect(canUseLivePilot(resident, true)).toBe(false);
    expect(canUseLivePilot(service, true)).toBe(false);
    expect(canUseLivePilot(resident, false)).toBe(true);
    expect(liveEnv().OPENAI_LIVE_PILOT_OWNER_ONLY).toBe(true);
    expect(liveEnv().OPENAI_LIVE_IDLE_TIMEOUT_MS).toBe(3_000);
    expect(liveEnv().OPENAI_LIVE_VOICE).toBe('sillage');
  });

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

  test('persists only bounded technical telemetry and builds pilot gates', () => {
    const db = createConversationDb(':memory:');
    const registry = new LiveSessionRegistry(db);
    const session = createSession(registry);
    registry.observeDelegation({ sessionId: session.sessionId, delegationId: 'delegation-a', nowMs: 2_000 });
    registry.recordTelemetry({
      sessionId: session.sessionId,
      eventType: 'client_connected',
      elapsedMs: 420,
      nowMs: 1_500,
    });
    registry.recordTelemetry({
      sessionId: session.sessionId,
      delegationId: 'delegation-a',
      eventType: 'ingest_completed',
      elapsedMs: 1_250,
      nowMs: 3_000,
    });

    expect(db.prepare('SELECT * FROM live_voice_telemetry ORDER BY id').all()).toEqual([
      expect.objectContaining({
        session_id: session.sessionId,
        delegation_id: null,
        event_type: 'client_connected',
        elapsed_ms: 420,
      }),
      expect.objectContaining({
        session_id: session.sessionId,
        delegation_id: 'delegation-a',
        event_type: 'ingest_completed',
        elapsed_ms: 1_250,
      }),
    ]);
    expect(db.prepare('PRAGMA table_info(live_voice_telemetry)').all()).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'transcript' }),
        expect.objectContaining({ name: 'audio' }),
      ])
    );
    expect(buildLivePilotReport(db, 0)).toMatchObject({
      sessions: 1,
      connectedSessions: 1,
      connectionSuccessRate: 1,
      latenciesMsP95: { connection: 420, ingest: 1_250, firstAudio: null },
      gates: { sampleComplete: false, connectionRateAtLeast95Percent: true },
    });
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
      .not.toThrow();
    expect(registry.requireDelegation('live_session_a', 'delegation-a').state).toBe('completed');
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
    let createBody: unknown;
    const transport: LiveProviderTransport = {
      create: async (input) => {
        createBody = input.body;
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
    expect(JSON.stringify(createBody)).toContain('reste silencieux si aucune réponse n\'est utile');
    expect(JSON.stringify(createBody)).toContain('aucun raisonnement, plan, étape');
    expect(JSON.stringify(createBody)).toContain('seulement la réponse finale fournie par le client');
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

  test('contains cleanup failures and retries on the next scheduled cycle', async () => {
    jest.useFakeTimers();
    const db = createConversationDb(':memory:');
    const registry = new LiveSessionRegistry(db);
    const listOpen = jest.spyOn(registry, 'listOpen')
      .mockImplementationOnce(() => { throw new Error('sqlite_busy'); })
      .mockReturnValue([]);
    const threads = new SqliteThreadRepository(db);
    const messages = new SqliteMessageRepository(db);
    const log = loggerStub();
    const service = new LiveSessionService(
      liveEnv(), registry, new LiveDelegationCoordinator(registry, 10),
      new LiveContextAdapter(threads, messages), new LiveEventValidator(65_536), log,
      {
        create: jest.fn(), attach: jest.fn(), hangup: jest.fn(),
      } as unknown as LiveProviderTransport
    );

    service.start();
    await jest.advanceTimersByTimeAsync(10_000);
    expect(log.warn).toHaveBeenCalledWith(
      { errorCode: 'sqlite_busy' },
      'live session cleanup failed'
    );
    await jest.advanceTimersByTimeAsync(10_000);
    expect(listOpen).toHaveBeenCalledTimes(2);
    await service.stop();
    db.close();
  });

  test('closes persisted open sessions on shutdown even without an in-memory sideband', async () => {
    const db = createConversationDb(':memory:');
    const registry = new LiveSessionRegistry(db);
    createSession(registry);
    const hangup = jest.fn<LiveProviderTransport['hangup']>(async () => undefined);
    const service = new LiveSessionService(
      liveEnv(), registry, new LiveDelegationCoordinator(registry, 10),
      new LiveContextAdapter(new SqliteThreadRepository(db), new SqliteMessageRepository(db)),
      new LiveEventValidator(65_536), loggerStub(),
      { create: jest.fn(), attach: jest.fn(), hangup } as unknown as LiveProviderTransport
    );

    await service.stop();

    expect(hangup).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'live_session_a' }));
    expect(registry.require('live_session_a')).toMatchObject({
      state: 'finalization_unconfirmed',
      lastErrorCode: 'close_unconfirmed',
    });
    db.close();
  });

  test('releases an attached socket if persisting the attachment fails', async () => {
    const db = createConversationDb(':memory:');
    const registry = new LiveSessionRegistry(db);
    const threads = new SqliteThreadRepository(db);
    const messages = new SqliteMessageRepository(db);
    await threads.getOrCreate('thread-a');
    const terminate = jest.fn();
    const socket = { readyState: 1, terminate } as unknown as WebSocket;
    const hangup = jest.fn<LiveProviderTransport['hangup']>(async () => undefined);
    const transport: LiveProviderTransport = {
      create: async () => ({
        session: { id: 'live_provider_registry_failure' },
        transport: { type: 'webrtc', sdp: 'answer' },
      }),
      attach: async () => socket,
      hangup,
    };
    jest.spyOn(registry, 'markSidebandAttached').mockImplementationOnce(() => {
      throw new Error('sqlite_write_failed');
    });
    const service = new LiveSessionService(
      liveEnv(), registry, new LiveDelegationCoordinator(registry, 10),
      new LiveContextAdapter(threads, messages), new LiveEventValidator(65_536),
      loggerStub(), transport
    );

    await expect(service.create({
      ownerUserId: 'owner-a', threadId: 'thread-a', client: 'desktop',
      deviceId: 'desktop-a', sdp: 'offer',
    })).rejects.toThrow('sqlite_write_failed');
    expect(terminate).toHaveBeenCalledTimes(1);
    expect(hangup).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'live_provider_registry_failure',
    }));
    db.close();
  });

  test('does not close an existing registry row when provider creation returns a duplicate id', async () => {
    const db = createConversationDb(':memory:');
    const registry = new LiveSessionRegistry(db);
    createSession(registry, 'live_duplicate_id');
    const threads = new SqliteThreadRepository(db);
    const messages = new SqliteMessageRepository(db);
    await threads.getOrCreate('thread-a');
    jest.spyOn(registry, 'create').mockImplementationOnce(() => {
      throw new Error('sqlite_unique_constraint');
    });
    const hangup = jest.fn<LiveProviderTransport['hangup']>(async () => undefined);
    const service = new LiveSessionService(
      liveEnv(), registry, new LiveDelegationCoordinator(registry, 10),
      new LiveContextAdapter(threads, messages), new LiveEventValidator(65_536),
      loggerStub(), {
        create: async () => ({
          session: { id: 'live_duplicate_id' },
          transport: { type: 'webrtc', sdp: 'answer' },
        }),
        attach: jest.fn(),
        hangup,
      } as LiveProviderTransport
    );

    await expect(service.create({
      ownerUserId: 'owner-b', threadId: 'thread-a', client: 'desktop',
      deviceId: 'desktop-b', sdp: 'offer',
    })).rejects.toThrow();
    expect(registry.require('live_duplicate_id').state).toBe('active');
    expect(hangup).toHaveBeenCalledTimes(1);
    db.close();
  });
});

describe('GPT-Live ingest integrity', () => {
  test('rejects a Live session used with another owned thread before mutation execution', async () => {
    const { app, db } = await createLiveIngestHarness();
    const mutation = jest.fn(async () => ({ operationStatus: 'succeeded' }));
    app.post('/v1/ingest', mutation);
    const key = deriveLiveIdempotencyKey('live_session_a', 'delegation-a');

    const response = await app.inject({
      method: 'POST',
      url: '/v1/ingest',
      headers: { 'idempotency-key': key },
      payload: {
        threadId: 'thread-b',
        text: 'Éteins le salon',
        clientContext: {
          voiceTransport: 'gpt-live',
          liveSessionId: 'live_session_a',
          liveDelegationId: 'delegation-a',
          deviceType: 'desktop',
        },
      },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: 'live_thread_mismatch' });
    expect(mutation).not.toHaveBeenCalled();
    const recovery = await app.inject({ method: 'GET', url: `/v1/mutation-results/${key}` });
    expect(recovery.statusCode).toBe(404);
    await app.close();
    db.close();
  });

  test('revalidates thread ownership before accepting a Live ingest', async () => {
    const { app, db } = await createLiveIngestHarness();
    db.prepare(
      `INSERT INTO users(user_id,email_normalized,display_name,status,created_at_ms,updated_at_ms)
       VALUES (?,?,?,?,?,?)`
    ).run('owner-b', 'owner-b@example.test', 'Owner B', 'active', 1, 1);
    db.prepare('UPDATE conversation_threads SET owner_user_id=? WHERE thread_id=?')
      .run('owner-b', 'thread-a');
    const mutation = jest.fn(async () => ({ operationStatus: 'succeeded' }));
    app.post('/v1/ingest', mutation);
    const key = deriveLiveIdempotencyKey('live_session_a', 'delegation-a');

    const response = await app.inject({
      method: 'POST',
      url: '/v1/ingest',
      headers: { 'idempotency-key': key },
      payload: {
        threadId: 'thread-a',
        text: 'Éteins le salon',
        clientContext: {
          voiceTransport: 'gpt-live', liveSessionId: 'live_session_a',
          liveDelegationId: 'delegation-a', deviceType: 'desktop',
        },
      },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ error: 'thread_forbidden' });
    expect(mutation).not.toHaveBeenCalled();
    const recovery = await app.inject({ method: 'GET', url: `/v1/mutation-results/${key}` });
    expect(recovery.statusCode).toBe(404);
    await app.close();
    db.close();
  });

  test('rejects a foreign delegation, wrong client, and wrong operation key', async () => {
    const { app, db } = await createLiveIngestHarness();
    const mutation = jest.fn(async () => ({ operationStatus: 'succeeded' }));
    app.post('/v1/ingest', mutation);
    const base = {
      threadId: 'thread-a',
      text: 'Éteins le salon',
      clientContext: {
        voiceTransport: 'gpt-live',
        liveSessionId: 'live_session_a',
        liveDelegationId: 'delegation-a',
        deviceType: 'desktop',
      },
    };

    const foreign = await app.inject({
      method: 'POST',
      url: '/v1/ingest',
      headers: { 'idempotency-key': deriveLiveIdempotencyKey('live_session_a', 'delegation-b') },
      payload: {
        ...base,
        clientContext: { ...base.clientContext, liveDelegationId: 'delegation-b' },
      },
    });
    expect(foreign.statusCode).toBe(409);
    expect(foreign.json()).toEqual({ error: 'live_delegation_not_observed' });

    const wrongClient = await app.inject({
      method: 'POST',
      url: '/v1/ingest',
      headers: { 'idempotency-key': deriveLiveIdempotencyKey('live_session_a', 'delegation-a') },
      payload: {
        ...base,
        clientContext: { ...base.clientContext, deviceType: 'android' },
      },
    });
    expect(wrongClient.statusCode).toBe(409);
    expect(wrongClient.json()).toEqual({ error: 'live_client_mismatch' });

    const wrongKey = await app.inject({
      method: 'POST',
      url: '/v1/ingest',
      headers: { 'idempotency-key': 'live-00000000000000000000000000000000' },
      payload: base,
    });
    expect(wrongKey.statusCode).toBe(409);
    expect(wrongKey.json()).toEqual({ error: 'live_idempotency_key_mismatch' });
    expect(mutation).not.toHaveBeenCalled();
    await app.close();
    db.close();
  });

  test('coalesces two Live ingests with the same key into one mutation', async () => {
    const { app, db } = await createLiveIngestHarness();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const mutation = jest.fn(async () => {
      await gate;
      return { operationStatus: 'accepted' };
    });
    app.post('/v1/ingest', mutation);
    const key = deriveLiveIdempotencyKey('live_session_a', 'delegation-a');
    const request = {
      method: 'POST' as const,
      url: '/v1/ingest',
      headers: { 'idempotency-key': key },
      payload: {
        threadId: 'thread-a',
        text: 'Éteins le salon',
        clientContext: {
          voiceTransport: 'gpt-live',
          liveSessionId: 'live_session_a',
          liveDelegationId: 'delegation-a',
          deviceType: 'desktop',
        },
      },
    };
    const first = app.inject(request);
    const second = app.inject(request);
    for (let attempt = 0; attempt < 10 && mutation.mock.calls.length === 0; attempt += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    expect(mutation).toHaveBeenCalledTimes(1);
    release();
    const [firstResponse, secondResponse] = await Promise.all([first, second]);
    expect(secondResponse.json()).toEqual(firstResponse.json());
    expect(secondResponse.headers['idempotent-replay']).toBe('true');
    expect(mutation).toHaveBeenCalledTimes(1);
    await app.close();
    db.close();
  });

  test('rejects closure before ingest but preserves recovery after business transmission', async () => {
    const { app, db, registry } = await createLiveIngestHarness();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const mutation = jest.fn(async () => {
      await gate;
      return { operationStatus: 'uncertain' };
    });
    app.post('/v1/ingest', mutation);
    const keyA = deriveLiveIdempotencyKey('live_session_a', 'delegation-a');
    const payloadA = {
      threadId: 'thread-a',
      text: 'Éteins le salon',
      clientContext: {
        voiceTransport: 'gpt-live', liveSessionId: 'live_session_a',
        liveDelegationId: 'delegation-a', deviceType: 'desktop',
      },
    };
    const inFlight = app.inject({
      method: 'POST', url: '/v1/ingest', headers: { 'idempotency-key': keyA }, payload: payloadA,
    });
    for (let attempt = 0; attempt < 10 && mutation.mock.calls.length === 0; attempt += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    registry.markClosed({ sessionId: 'live_session_a', confirmed: true });
    release();
    await expect(inFlight.then((response) => response.json())).resolves.toEqual({
      operationStatus: 'uncertain',
    });
    const recovery = await app.inject({ method: 'GET', url: `/v1/mutation-results/${keyA}` });
    expect(recovery.statusCode).toBe(200);
    expect(Buffer.from(recovery.json().payloadBase64, 'base64').toString('utf8'))
      .toContain('"operationStatus":"uncertain"');

    registry.markClosed({ sessionId: 'live_session_b', confirmed: true });
    const keyB = deriveLiveIdempotencyKey('live_session_b', 'delegation-b');
    const before = await app.inject({
      method: 'POST',
      url: '/v1/ingest',
      headers: { 'idempotency-key': keyB },
      payload: {
        ...payloadA,
        clientContext: {
          ...payloadA.clientContext,
          liveSessionId: 'live_session_b',
          liveDelegationId: 'delegation-b',
        },
      },
    });
    expect(before.statusCode).toBe(403);
    expect(mutation).toHaveBeenCalledTimes(1);
    await app.close();
    db.close();
  });

  test('does not admit a delegation when the session closes during sideband correlation', async () => {
    const { app, db, registry, delegations } = await createLiveIngestHarness();
    const waitUntilObserved = jest.spyOn(delegations, 'waitUntilObserved');
    const mutation = jest.fn(async () => ({ operationStatus: 'succeeded' }));
    app.post('/v1/ingest', mutation);
    const delegationId = 'delegation-late';
    const key = deriveLiveIdempotencyKey('live_session_a', delegationId);
    const pending = app.inject({
      method: 'POST',
      url: '/v1/ingest',
      headers: { 'idempotency-key': key },
      payload: {
        threadId: 'thread-a',
        text: 'Éteins le salon',
        clientContext: {
          voiceTransport: 'gpt-live', liveSessionId: 'live_session_a',
          liveDelegationId: delegationId, deviceType: 'desktop',
        },
      },
    });
    for (let attempt = 0; attempt < 10 && waitUntilObserved.mock.calls.length === 0; attempt += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    expect(waitUntilObserved).toHaveBeenCalledTimes(1);
    delegations.observe('live_session_a', delegationId);
    registry.markClosed({ sessionId: 'live_session_a', confirmed: true });

    const response = await pending;
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: 'live_session_closed_during_validation' });
    expect(mutation).not.toHaveBeenCalled();
    const recovery = await app.inject({ method: 'GET', url: `/v1/mutation-results/${key}` });
    expect(recovery.statusCode).toBe(404);
    await app.close();
    db.close();
  });

  test('allows a persisted uncertain delegation to advance when recovery finds the result', () => {
    const db = createConversationDb(':memory:');
    const registry = new LiveSessionRegistry(db);
    createSession(registry);
    const coordinator = new LiveDelegationCoordinator(registry, 30);
    coordinator.observe('live_session_a', 'delegation-a');
    const key = deriveLiveIdempotencyKey('live_session_a', 'delegation-a');
    coordinator.markIngestSent('live_session_a', 'delegation-a', key);
    coordinator.markClientState('live_session_a', 'delegation-a', 'uncertain');

    expect(() => coordinator.markClientState('live_session_a', 'delegation-a', 'ingest_completed'))
      .not.toThrow();
    expect(registry.requireDelegation('live_session_a', 'delegation-a')).toMatchObject({
      operationKey: key,
      state: 'ingest_completed',
    });
    coordinator.markClientState('live_session_a', 'delegation-a', 'uncertain');
    expect(registry.requireDelegation('live_session_a', 'delegation-a').state)
      .toBe('ingest_completed');
    db.close();
  });

  test('rejects late sideband delegations after session closure', () => {
    const db = createConversationDb(':memory:');
    const registry = new LiveSessionRegistry(db);
    createSession(registry);
    const coordinator = new LiveDelegationCoordinator(registry, 30);
    registry.markClosed({ sessionId: 'live_session_a', confirmed: true });

    expect(() => coordinator.observe('live_session_a', 'delegation-late'))
      .toThrow('live_session_inactive');
    expect(registry.findDelegation('live_session_a', 'delegation-late')).toBeNull();
    db.close();
  });

  test('retains the operation key and uncertain state across a registry restart', () => {
    const directory = mkdtempSync(join(tmpdir(), 'jarvis-live-restart-'));
    const databasePath = join(directory, 'runtime.sqlite');
    const firstDb = createConversationDb(databasePath);
    const firstRegistry = new LiveSessionRegistry(firstDb);
    createSession(firstRegistry);
    const firstCoordinator = new LiveDelegationCoordinator(firstRegistry, 30);
    firstCoordinator.observe('live_session_a', 'delegation-a');
    const key = deriveLiveIdempotencyKey('live_session_a', 'delegation-a');
    firstCoordinator.markIngestSent('live_session_a', 'delegation-a', key);
    firstCoordinator.markClientState('live_session_a', 'delegation-a', 'uncertain');
    firstDb.close();

    const restartedDb = createConversationDb(databasePath);
    const restartedRegistry = new LiveSessionRegistry(restartedDb);
    const restartedCoordinator = new LiveDelegationCoordinator(restartedRegistry, 30);
    expect(restartedRegistry.requireDelegation('live_session_a', 'delegation-a')).toMatchObject({
      state: 'uncertain',
      operationKey: key,
    });
    restartedCoordinator.markClientState('live_session_a', 'delegation-a', 'completed');
    expect(restartedRegistry.requireDelegation('live_session_a', 'delegation-a')).toMatchObject({
      state: 'completed',
      operationKey: key,
    });
    restartedDb.close();
    rmSync(directory, { recursive: true, force: true });
  });
});
