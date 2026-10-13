import { mkdtempSync, rmSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

import { describe, expect, jest, test } from '@jest/globals';
import Fastify from 'fastify';

import { createConversationDb } from '../src/conversation/repositories/SqliteRepositories';
import { MutationIdempotencyCoordinator } from '../src/idempotency/MutationIdempotencyCoordinator';
import { SqliteMutationIdempotencyStore } from '../src/idempotency/SqliteMutationIdempotencyStore';
import { setRequestPrincipal } from '../src/identity/requestIdentity';
import { registerMutationIdempotencyHooks } from '../src/routes/mutationIdempotency';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe('mutation idempotency', () => {
  test('survives a process restart and does not replay an in-flight mutation', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'jarvis-idempotency-'));
    const databasePath = join(directory, 'runtime.sqlite');
    const firstDb = createConversationDb(databasePath);
    const first = new MutationIdempotencyCoordinator({ store: new SqliteMutationIdempotencyStore(firstDb) });
    expect(first.reserve('user:a', 'restart-safe-0001', 'same-fingerprint')).toMatchObject({ kind: 'owner' });
    firstDb.close();

    const restartedDb = createConversationDb(databasePath);
    const restarted = new MutationIdempotencyCoordinator({ store: new SqliteMutationIdempotencyStore(restartedDb) });
    const replay = restarted.reserve('user:a', 'restart-safe-0001', 'same-fingerprint');
    expect(replay.kind).toBe('replay');
    if (replay.kind !== 'replay') throw new Error('expected_replay');
    await expect(replay.response).resolves.toMatchObject({
      statusCode: 503,
      payload: expect.stringContaining('mutation_result_unknown'),
    });
    restartedDb.close();
    rmSync(directory, { recursive: true, force: true });
  });

  test('replays the completed response from durable storage after restart', async () => {
    const db = createConversationDb(':memory:');
    const store = new SqliteMutationIdempotencyStore(db);
    const first = new MutationIdempotencyCoordinator({ store });
    const reservation = first.reserve('user:a', 'restart-safe-0002', 'same-fingerprint');
    if (reservation.kind !== 'owner') throw new Error('expected_owner');
    first.complete(reservation.cacheKey, {
      statusCode: 200,
      contentType: 'application/json',
      payload: '{"operationStatus":"uncertain"}',
    });

    const restarted = new MutationIdempotencyCoordinator({ store });
    const replay = restarted.reserve('user:a', 'restart-safe-0002', 'same-fingerprint');
    if (replay.kind !== 'replay') throw new Error('expected_replay');
    const response = await replay.response;
    expect(response.statusCode).toBe(200);
    expect(Buffer.from(response.payload).toString('utf8')).toContain('uncertain');
    db.close();
  });

  test('coalesces simultaneous identical mutations and replays the same response', async () => {
    const app = Fastify();
    registerMutationIdempotencyHooks(app, new MutationIdempotencyCoordinator());
    const gate = deferred<void>();
    const mutation = jest.fn(async () => {
      await gate.promise;
      return { status: 'ok', operationStatus: 'accepted' };
    });
    app.post('/v1/home/actions', async () => mutation());

    const request = {
      method: 'POST' as const,
      url: '/v1/home/actions',
      headers: { 'idempotency-key': 'home-action-0001' },
      payload: { deviceId: 'light-1', action: 'turn_on' },
    };
    const first = app.inject(request);
    const second = app.inject(request);
    for (let attempt = 0; attempt < 10 && mutation.mock.calls.length === 0; attempt += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    expect(mutation).toHaveBeenCalledTimes(1);
    gate.resolve();

    const [firstResponse, secondResponse] = await Promise.all([first, second]);
    expect(firstResponse.json()).toEqual({ status: 'ok', operationStatus: 'accepted' });
    expect(secondResponse.json()).toEqual(firstResponse.json());
    expect(secondResponse.headers['idempotent-replay']).toBe('true');
    expect(mutation).toHaveBeenCalledTimes(1);
    await app.close();
  });

  test('rejects reuse of a key with different parameters', async () => {
    const app = Fastify();
    registerMutationIdempotencyHooks(app, new MutationIdempotencyCoordinator());
    const mutation = jest.fn(async () => ({ status: 'ok' }));
    app.post('/v1/music/actions', async () => mutation());

    await app.inject({
      method: 'POST', url: '/v1/music/actions',
      headers: { 'idempotency-key': 'music-action-0001' },
      payload: { action: 'play' },
    });
    const conflict = await app.inject({
      method: 'POST', url: '/v1/music/actions',
      headers: { 'idempotency-key': 'music-action-0001' },
      payload: { action: 'pause' },
    });

    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toEqual({ error: 'idempotency_key_conflict' });
    expect(mutation).toHaveBeenCalledTimes(1);
    await app.close();
  });

  test('replays an uncertain result without running the mutation again', async () => {
    const app = Fastify();
    registerMutationIdempotencyHooks(app, new MutationIdempotencyCoordinator());
    const mutation = jest.fn(async () => ({ status: 'ok', operationStatus: 'uncertain' }));
    app.post('/v1/home/actions', async () => mutation());
    const request = {
      method: 'POST' as const,
      url: '/v1/home/actions',
      headers: { 'idempotency-key': 'home-action-uncertain' },
      payload: { deviceId: 'switch-1', action: 'turn_off' },
    };

    const first = await app.inject(request);
    const replay = await app.inject(request);

    expect(first.json().operationStatus).toBe('uncertain');
    expect(replay.json()).toEqual(first.json());
    expect(replay.headers['idempotent-replay']).toBe('true');
    expect(mutation).toHaveBeenCalledTimes(1);
    await app.close();
  });

  test('scopes the same idempotency key to the authenticated identity', async () => {
    const app = Fastify();
    app.addHook('preHandler', async (request) => {
      const userId = String(request.headers['x-test-user']);
      setRequestPrincipal(request, {
        kind: 'user',
        userId,
        email: `${userId}@example.test`,
        displayName: userId,
        roles: ['resident'],
        permissions: ['home'],
        status: 'active',
        sessionId: `session-${userId}`,
      });
    });
    registerMutationIdempotencyHooks(app, new MutationIdempotencyCoordinator());
    const mutation = jest.fn(async () => ({ status: 'ok' }));
    app.post('/v1/home/actions', async () => mutation());

    for (const userId of ['user-a', 'user-b']) {
      const response = await app.inject({
        method: 'POST',
        url: '/v1/home/actions',
        headers: { 'idempotency-key': 'shared-key-0001', 'x-test-user': userId },
        payload: { deviceId: 'light-1', action: 'turn_on' },
      });
      expect(response.statusCode).toBe(200);
    }

    expect(mutation).toHaveBeenCalledTimes(2);
    await app.close();
  });

  test('captures an ingest stream and exposes its completed result without replaying the action', async () => {
    const app = Fastify();
    registerMutationIdempotencyHooks(app, new MutationIdempotencyCoordinator());
    const mutation = jest.fn(() => Readable.from([
      'event: ack\ndata: {"text":"Je m’en occupe"}\n\n',
      'event: response\ndata: {"threadId":"voice-1","responseText":"Terminé"}\n\n',
    ]));
    app.post('/v1/ingest', async (_request, reply) => {
      reply.type('text/event-stream');
      return reply.send(mutation());
    });

    const key = 'voice-turn-recovery-0001';
    const response = await app.inject({
      method: 'POST',
      url: '/v1/ingest?sse=1',
      headers: { 'idempotency-key': key, accept: 'text/event-stream' },
      payload: { threadId: 'voice-1', text: 'Éteins le salon' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('event: response');

    const recovery = await app.inject({ method: 'GET', url: `/v1/mutation-results/${key}` });
    expect(recovery.statusCode).toBe(200);
    const result = recovery.json();
    expect(result).toMatchObject({ state: 'completed', statusCode: 200 });
    expect(Buffer.from(result.payloadBase64, 'base64').toString('utf8')).toBe(response.body);
    expect(mutation).toHaveBeenCalledTimes(1);
    await app.close();
  });

  test('keeps capturing an ingest stream after the SSE client disconnects', async () => {
    const app = Fastify();
    registerMutationIdempotencyHooks(app, new MutationIdempotencyCoordinator());
    const gate = deferred<void>();
    const mutation = jest.fn(() => {
      let started = false;
      return new Readable({
        read() {
          if (started) return;
          started = true;
          this.push('event: ack\ndata: {"text":"Je m’en occupe"}\n\n');
          void gate.promise.then(() => {
            this.push('event: response\ndata: {"threadId":"voice-2","responseText":"Terminé"}\n\n');
            this.push(null);
          });
        },
      });
    });
    app.post('/v1/ingest', async (_request, reply) => {
      reply.type('text/event-stream');
      return reply.send(mutation());
    });
    await app.listen({ host: '127.0.0.1', port: 0 });
    const address = app.server.address();
    if (!address || typeof address === 'string') throw new Error('expected_tcp_address');
    const key = 'voice-turn-disconnect-0001';
    const payload = JSON.stringify({ threadId: 'voice-2', text: 'Éteins le salon' });

    await new Promise<void>((resolve, reject) => {
      const request = httpRequest({
        host: '127.0.0.1',
        port: address.port,
        path: '/v1/ingest?sse=1',
        method: 'POST',
        headers: {
          accept: 'text/event-stream',
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(payload),
          'idempotency-key': key,
        },
      }, (response) => {
        response.once('data', () => {
          response.destroy();
          resolve();
        });
      });
      request.once('error', reject);
      request.end(payload);
    });

    gate.resolve();
    let recovery = await app.inject({ method: 'GET', url: `/v1/mutation-results/${key}` });
    for (let attempt = 0; attempt < 20 && recovery.statusCode === 202; attempt += 1) {
      await new Promise((resolve) => setImmediate(resolve));
      recovery = await app.inject({ method: 'GET', url: `/v1/mutation-results/${key}` });
    }

    expect(recovery.statusCode).toBe(200);
    const result = recovery.json();
    expect(result).toMatchObject({ state: 'completed', statusCode: 200 });
    const recoveredSse = Buffer.from(result.payloadBase64, 'base64').toString('utf8');
    expect(recoveredSse.match(/event: ack/gu)).toHaveLength(1);
    expect(recoveredSse.match(/event: response/gu)).toHaveLength(1);
    expect(mutation).toHaveBeenCalledTimes(1);
    await app.close();
  });

  test('reports a concurrent ingest as pending without invoking it again', async () => {
    const app = Fastify();
    const coordinator = new MutationIdempotencyCoordinator();
    registerMutationIdempotencyHooks(app, coordinator);
    const gate = deferred<void>();
    const mutation = jest.fn(async () => {
      await gate.promise;
      return { threadId: 'voice-2', responseText: 'Terminé' };
    });
    app.post('/v1/ingest', async () => mutation());
    const key = 'voice-turn-pending-0001';
    const first = app.inject({
      method: 'POST', url: '/v1/ingest', headers: { 'idempotency-key': key },
      payload: { threadId: 'voice-2', text: 'Allume le salon' },
    });
    for (let attempt = 0; attempt < 10 && mutation.mock.calls.length === 0; attempt += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    const recovery = await app.inject({ method: 'GET', url: `/v1/mutation-results/${key}` });
    expect(recovery.statusCode).toBe(202);
    expect(recovery.json()).toEqual({ state: 'pending' });
    expect(mutation).toHaveBeenCalledTimes(1);
    gate.resolve();
    await first;
    await app.close();
  });
});
