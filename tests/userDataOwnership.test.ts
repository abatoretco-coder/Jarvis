import { describe, expect, test } from '@jest/globals';
import type { FastifyRequest } from 'fastify';

import {
  createConversationDb,
  SqliteMessageRepository,
  SqliteThreadRepository,
} from '../src/conversation/repositories/SqliteRepositories';
import { IdentityRepository } from '../src/identity/IdentityRepository';
import { runWithRequestIdentityContext, setRequestPrincipal } from '../src/identity/requestIdentity';
import { PendingMutationRepository } from '../src/pendingMutations/PendingMutationRepository';
import { ConversationResultSetRepository } from '../src/resultSets/ConversationResultSetRepository';

function asUser<T>(userId: string, callback: () => T): T {
  return runWithRequestIdentityContext(() => {
    setRequestPrincipal({} as FastifyRequest, {
      kind: 'user', userId, email: `${userId}@example.test`, displayName: userId,
      status: 'active', roles: ['resident'], permissions: ['chat', 'history'], sessionId: `session-${userId}`,
    });
    return callback();
  });
}

function asService<T>(serviceId: string, callback: () => T): T {
  return runWithRequestIdentityContext(() => {
    setRequestPrincipal({} as FastifyRequest, { kind: 'service', serviceId, permissions: ['chat', 'history'] });
    return callback();
  });
}

describe('user data ownership', () => {
  test('isolates threads, messages, pending mutations and result sets between users', async () => {
    const db = createConversationDb(':memory:');
    const identities = new IdentityRepository(db);
    const userA = identities.provisionOidcIdentity({
      issuer: 'https://id.example.test', subject: 'a', email: 'a@example.test', emailVerified: true,
    }, 1);
    const userB = identities.provisionOidcIdentity({
      issuer: 'https://id.example.test', subject: 'b', email: 'b@example.test', emailVerified: true,
    }, 1);
    const threads = new SqliteThreadRepository(db);
    const messages = new SqliteMessageRepository(db);
    const mutations = new PendingMutationRepository(db);
    const resultSets = new ConversationResultSetRepository(db);

    await asUser(userA.userId, async () => {
      await threads.getOrCreate('private-thread');
      await messages.appendMessage({ threadId: 'private-thread', role: 'user', content: 'secret A' });
      await mutations.create({
        proposalId: 'private-proposal', threadId: 'private-thread', agent: 'todo', action: 'add',
        effect: 'write', preview: 'Ajouter', payload: {}, expiresAtMs: Date.now() + 60_000,
      });
      resultSets.create({
        threadId: 'private-thread', sourceAgent: 'search', sourceAction: 'query',
        items: [{ entityType: 'search.result', entityId: 'private-result', displayLabel: 'Privé' }],
      });
    });

    await asUser(userB.userId, async () => {
      await expect(threads.findById('private-thread')).resolves.toBeNull();
      await expect(threads.listRecent(20)).resolves.toEqual([]);
      await expect(messages.getRecentMessages('private-thread', 20)).resolves.toEqual([]);
      await expect(mutations.findByProposalId('private-proposal')).resolves.toBeNull();
      expect(resultSets.findActive('private-thread')).toBeNull();
      await expect(threads.deleteThread('private-thread')).resolves.toBe(false);
      await expect(threads.getOrCreate('private-thread')).rejects.toThrow('conversation_thread_not_found');
    });

    await asUser(userA.userId, async () => {
      await expect(messages.getRecentMessages('private-thread', 20)).resolves.toMatchObject([
        { content: 'secret A' },
      ]);
      await expect(mutations.findByProposalId('private-proposal')).resolves.toMatchObject({
        proposalId: 'private-proposal',
      });
      expect(resultSets.findActive('private-thread')?.items[0]?.entityId).toBe('private-result');
    });
    db.close();
  });

  test('keeps the compatibility partition separate from authenticated users', async () => {
    const db = createConversationDb(':memory:');
    const identities = new IdentityRepository(db);
    const user = identities.provisionOidcIdentity({
      issuer: 'https://id.example.test', subject: 'human', email: 'human@example.test', emailVerified: true,
    }, 1);
    const threads = new SqliteThreadRepository(db);
    await threads.getOrCreate('legacy-service-thread');

    await asUser(user.userId, async () => {
      await expect(threads.findById('legacy-service-thread')).resolves.toBeNull();
      await threads.getOrCreate('human-thread');
    });
    await expect(threads.findById('human-thread')).resolves.toBeNull();
    await expect(threads.findById('legacy-service-thread')).resolves.toMatchObject({ threadId: 'legacy-service-thread' });
    db.close();
  });

  test('isolates named technical services from each other and from the legacy partition', async () => {
    const db = createConversationDb(':memory:');
    const threads = new SqliteThreadRepository(db);
    await asService('home-assistant', () => threads.getOrCreate('service-thread'));

    await asService('automation-worker', async () => {
      await expect(threads.findById('service-thread')).resolves.toBeNull();
      await expect(threads.getOrCreate('service-thread')).rejects.toThrow('conversation_thread_not_found');
    });
    await expect(threads.findById('service-thread')).resolves.toBeNull();
    await asService('home-assistant', async () => {
      await expect(threads.findById('service-thread')).resolves.toMatchObject({ threadId: 'service-thread' });
    });
    expect(db.prepare('SELECT owner_user_id,owner_service_id FROM conversation_threads').get()).toEqual({
      owner_user_id: null, owner_service_id: 'home-assistant',
    });
    db.close();
  });
});
