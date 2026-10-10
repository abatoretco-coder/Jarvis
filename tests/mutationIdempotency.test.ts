import { describe, expect, jest, test } from '@jest/globals';
import Fastify from 'fastify';

import { MutationIdempotencyCoordinator } from '../src/idempotency/MutationIdempotencyCoordinator';
import { setRequestPrincipal } from '../src/identity/requestIdentity';
import { registerMutationIdempotencyHooks } from '../src/routes/mutationIdempotency';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe('mutation idempotency', () => {
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
});
