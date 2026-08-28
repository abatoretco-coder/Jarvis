import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, test } from '@jest/globals';

import { createConversationDb, SqliteThreadRepository } from '../src/conversation/repositories/SqliteRepositories';
import {
  ConversationResultSetRepository,
  MAX_CONVERSATION_RESULT_SET_ITEMS,
} from '../src/resultSets/ConversationResultSetRepository';

async function repositoryFor(threadIds: string[]) {
  const db = createConversationDb(':memory:');
  const threads = new SqliteThreadRepository(db);
  for (const threadId of threadIds) await threads.getOrCreate(threadId);
  return { db, threads, repository: new ConversationResultSetRepository(db) };
}

describe('ConversationResultSetRepository', () => {
  test('resolves ordinals, last item and focused pronouns deterministically', async () => {
    const { db, repository } = await repositoryFor(['thread-culture']);
    repository.create({
      threadId: 'thread-culture',
      sourceAgent: 'culture',
      sourceAction: 'discover',
      context: { latitude: 48.85, radiusKm: 15 },
      items: [
        { entityType: 'agora.item', entityId: 'item_1', displayLabel: 'Film A' },
        { entityType: 'agora.item', entityId: 'item_2', displayLabel: 'Film B' },
        { entityType: 'agora.item', entityId: 'item_3', displayLabel: 'Film C' },
      ],
    });

    expect(repository.resolveReference('thread-culture', 'le troisième')?.entityId).toBe('item_3');
    expect(repository.resolveReference('thread-culture', 'et lui ?')?.entityId).toBe('item_3');
    expect(repository.resolveReference('thread-culture', 'le premier')?.entityId).toBe('item_1');
    expect(repository.resolveReference('thread-culture', 'celle-là')?.entityId).toBe('item_1');
    expect(repository.resolveReference('thread-culture', 'elle')?.entityId).toBe('item_1');
    expect(repository.resolveReference('thread-culture', 'le dernier')?.entityId).toBe('item_3');
    db.close();
  });

  test('uses generic reference labels for titles, times and venues and reports real ambiguity', async () => {
    const { db, repository } = await repositoryFor(['thread-labels']);
    repository.create({
      threadId: 'thread-labels',
      sourceAgent: 'culture',
      sourceAction: 'discover',
      items: [
        {
          entityType: 'agora.item',
          entityId: 'item_dune',
          displayLabel: 'Dune',
          metadata: { referenceLabels: ['Dune'] },
        },
        {
          entityType: 'agora.item',
          entityId: 'item_arrival',
          displayLabel: 'Arrival',
          metadata: { referenceLabels: ['Arrival'] },
        },
      ],
    });
    expect(repository.resolveReference('thread-labels', 'le film Dune')?.entityId).toBe('item_dune');

    repository.create({
      threadId: 'thread-labels',
      sourceAgent: 'culture',
      sourceAction: 'find_occurrences',
      items: [
        {
          entityType: 'agora.occurrence',
          entityId: 'occ_18',
          displayLabel: 'Dune — Cinéma X, 18h',
          metadata: { referenceLabels: ['Dune', '18h', 'Cinéma X'] },
        },
        {
          entityType: 'agora.occurrence',
          entityId: 'occ_20',
          displayLabel: 'Dune — Cinéma X, 20h',
          metadata: { referenceLabels: ['Dune', '20h', 'Cinéma X'] },
        },
        {
          entityType: 'agora.occurrence',
          entityId: 'occ_y',
          displayLabel: 'Arrival — Cinéma Y, 21h',
          metadata: { referenceLabels: ['Arrival', '21h', 'Cinéma Y'] },
        },
      ],
    });

    expect(repository.resolveReferenceDetailed('thread-labels', 'Et après 21h ?')).toEqual({ status: 'not_reference' });
    expect(repository.resolveReference('thread-labels', 'celui de 20h')?.entityId).toBe('occ_20');
    expect(repository.resolveReference('thread-labels', 'celui au cinéma Y')?.entityId).toBe('occ_y');
    expect(repository.resolveReferenceDetailed('thread-labels', 'celui au cinéma X')).toMatchObject({
      status: 'ambiguous',
      candidates: [{ entityId: 'occ_18' }, { entityId: 'occ_20' }],
    });
    expect(repository.resolveReferenceDetailed('thread-labels', 'le film Avatar')).toMatchObject({
      status: 'not_found',
    });
    db.close();
  });

  test('isolates focus by thread and keeps only the newest set active', async () => {
    const { db, repository } = await repositoryFor(['thread-a', 'thread-b']);
    repository.create({
      threadId: 'thread-a',
      sourceAgent: 'search',
      sourceAction: 'query',
      items: [{ entityType: 'search.result', entityId: 'old', displayLabel: 'Ancien' }],
    });
    repository.create({
      threadId: 'thread-a',
      sourceAgent: 'culture',
      sourceAction: 'discover',
      items: [{ entityType: 'agora.item', entityId: 'new', displayLabel: 'Nouveau' }],
    });
    repository.create({
      threadId: 'thread-b',
      sourceAgent: 'culture',
      sourceAction: 'discover',
      items: [{ entityType: 'agora.item', entityId: 'other', displayLabel: 'Autre' }],
    });

    expect(repository.resolveReference('thread-a', 'le premier')?.entityId).toBe('new');
    expect(repository.resolveReferenceDetailed('thread-b', 'et lui')).toMatchObject({ status: 'not_found' });
    expect(repository.resolveReference('thread-a', 'et lui')?.entityId).toBe('new');
    db.close();
  });

  test('expires focus with its set and cleans expired rows', async () => {
    const { db, repository } = await repositoryFor(['thread-expired']);
    repository.create({
      threadId: 'thread-expired',
      sourceAgent: 'culture',
      sourceAction: 'discover',
      ttlMs: -1,
      items: [{ entityType: 'agora.item', entityId: 'expired', displayLabel: 'Expiré' }],
    });

    expect(repository.resolveReferenceDetailed('thread-expired', 'le premier')).toEqual({ status: 'expired' });
    expect(repository.findActive('thread-expired')).toBeNull();
    expect(db.prepare('SELECT COUNT(*) AS count FROM conversation_result_sets').get()).toEqual({ count: 0 });
    db.close();
  });

  test('bounds item count, context and metadata while honoring a custom TTL', async () => {
    const { db, repository } = await repositoryFor(['thread-bounds']);
    const before = Date.now();
    const set = repository.create({
      threadId: 'thread-bounds',
      sourceAgent: 'search',
      sourceAction: 'query',
      ttlMs: 120_000,
      items: Array.from({ length: 25 }, (_, index) => ({
        entityType: 'search.result',
        entityId: `result_${index}`,
        displayLabel: `Résultat ${index}`,
      })),
    });
    expect(set.items).toHaveLength(MAX_CONVERSATION_RESULT_SET_ITEMS);
    expect(set.expiresAtMs).toBeGreaterThanOrEqual(before + 120_000);
    expect(() => repository.create({
      threadId: 'thread-bounds',
      sourceAgent: 'search',
      sourceAction: 'query',
      context: { oversized: 'x'.repeat(17_000) },
      items: [],
    })).toThrow('conversation_result_set_payload_too_large');
    expect(() => repository.create({
      threadId: 'thread-bounds',
      sourceAgent: 'search',
      sourceAction: 'query',
      items: [{
        entityType: 'search.result',
        entityId: 'large',
        displayLabel: 'Large',
        metadata: { oversized: 'x'.repeat(33_000) },
      }],
    })).toThrow('conversation_result_set_payload_too_large');
    db.close();
  });

  test('cascades with thread deletion', async () => {
    const { db, threads, repository } = await repositoryFor(['thread-delete']);
    repository.create({
      threadId: 'thread-delete',
      sourceAgent: 'culture',
      sourceAction: 'discover',
      items: [{ entityType: 'agora.item', entityId: 'item', displayLabel: 'Film' }],
    });
    await threads.deleteThread('thread-delete');
    expect(repository.findActive('thread-delete')).toBeNull();
    db.close();
  });

  test('adds generic context columns to an existing database without dropping data', () => {
    const directory = mkdtempSync(join(tmpdir(), 'jarvis-resultset-migration-'));
    const path = join(directory, 'conversation.sqlite');
    const legacy = createConversationDb(path);
    legacy.exec("INSERT INTO conversation_threads(thread_id,created_at_ms,updated_at_ms) VALUES('legacy-thread',1,1)");
    legacy.exec("INSERT INTO conversation_result_sets(id,thread_id,source_agent,source_action,created_at_ms,expires_at_ms,active) VALUES('legacy-set','legacy-thread','search','query',1,9999999999999,1)");
    legacy.exec("INSERT INTO conversation_result_set_items(result_set_id,position,entity_type,entity_id,display_label) VALUES('legacy-set',1,'search.result','legacy-item','Ancien résultat')");
    legacy.exec('ALTER TABLE conversation_result_set_items DROP COLUMN metadata_json');
    legacy.exec('ALTER TABLE conversation_result_sets DROP COLUMN context_json');
    legacy.close();

    const migrated = createConversationDb(path);
    const repository = new ConversationResultSetRepository(migrated);
    expect(repository.findActive('legacy-thread')?.items[0]).toMatchObject({ entityId: 'legacy-item', metadata: null });
    expect(repository.findActive('legacy-thread')?.context).toBeNull();
    migrated.close();
    rmSync(directory, { recursive: true, force: true });
  });
});
