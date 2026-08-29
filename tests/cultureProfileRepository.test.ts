import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, test } from '@jest/globals';

import { createConversationDb } from '../src/conversation/repositories/SqliteRepositories';
import { CultureProfileRepository } from '../src/culture/CultureProfileRepository';

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('CultureProfileRepository', () => {
  test('adds Phase 5 tables to a pre-Phase-5 database without changing conversation rows', () => {
    const directory = mkdtempSync(join(tmpdir(), 'jarvis-culture-legacy-'));
    directories.push(directory);
    const path = join(directory, 'conversation.sqlite');
    const legacy = createConversationDb(path);
    legacy.exec(`
      DROP TABLE culture_proactive_notifications;
      DROP TABLE culture_saved_entities;
      DROP TABLE culture_feedback;
      DROP TABLE culture_preference_profiles;
      INSERT INTO conversation_threads(thread_id,created_at_ms,updated_at_ms) VALUES('legacy-thread',1,1);
    `);
    legacy.close();

    const migrated = createConversationDb(path);
    expect(migrated.prepare("SELECT thread_id FROM conversation_threads WHERE thread_id='legacy-thread'").get()).toEqual({
      thread_id: 'legacy-thread',
    });
    expect(migrated.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='culture_feedback'").get()).toEqual({
      name: 'culture_feedback',
    });
    migrated.close();
  });

  test('migrates an existing Jarvis database additively and preserves profile data after restart', () => {
    const directory = mkdtempSync(join(tmpdir(), 'jarvis-culture-profile-'));
    directories.push(directory);
    const path = join(directory, 'conversation.sqlite');
    const firstDb = createConversationDb(path);
    const first = new CultureProfileRepository(firstDb);
    first.updatePreferences('profile-a', { tagWeights: { jazz: 4 }, freeAffinityDelta: 2 });
    first.saveEntity({
      profileId: 'profile-a',
      entityType: 'agora.item',
      entityId: 'item-1',
      sourceRefs: [{ provider: 'openagenda', externalId: 'event-1', sourceUrl: 'https://example.test/event-1' }],
      title: 'Concert jazz',
      categories: ['jazz'],
      venue: { id: 'venue-1', name: 'Le Club' },
      occurrenceDate: '2026-09-01T18:00:00.000Z',
      metadata: { snapshot: true },
    });
    firstDb.close();

    const migratedDb = createConversationDb(path);
    const migrated = new CultureProfileRepository(migratedDb);
    expect(migrated.getProfile('profile-a')).toMatchObject({ tagWeights: { jazz: 4 }, freeAffinity: 2 });
    expect(migrated.listSaved('profile-a')[0]).toMatchObject({
      entityId: 'item-1',
      sourceRefs: [{ provider: 'openagenda', externalId: 'event-1' }],
    });
    expect(migratedDb.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='conversation_threads'").get()).toBeDefined();
    migratedDb.close();
  });

  test('isolates feedback, favorites and preferences between profiles', () => {
    const db = createConversationDb(':memory:');
    const repository = new CultureProfileRepository(db);
    repository.updatePreferences('profile-a', { typeWeights: { concert: 5 } });
    repository.updatePreferences('profile-b', { typeWeights: { theatre: 5 } });
    repository.recordFeedback({
      profileId: 'profile-a', entityType: 'agora.item', entityId: 'concert-1',
      signal: 'explicit_like', strength: 8, metadata: { type: 'concert' },
    });
    repository.saveEntity({
      profileId: 'profile-a', entityType: 'agora.item', entityId: 'concert-1', sourceRefs: [],
      title: 'Concert', categories: ['jazz'], venue: null, occurrenceDate: null, metadata: {},
    });
    expect(repository.getProfile('profile-a').typeWeights).toEqual({ concert: 5 });
    expect(repository.getProfile('profile-b').typeWeights).toEqual({ theatre: 5 });
    expect(repository.listFeedback('profile-b')).toEqual([]);
    expect(repository.listSaved('profile-b')).toEqual([]);
    db.close();
  });

  test('requires an explicit reset call and clears only the selected profile', () => {
    const db = createConversationDb(':memory:');
    const repository = new CultureProfileRepository(db);
    repository.updatePreferences('profile-a', { tagWeights: { photo: 4 } });
    repository.updatePreferences('profile-b', { tagWeights: { jazz: 4 } });
    repository.resetProfile('profile-a');
    expect(repository.getProfile('profile-a').tagWeights).toEqual({});
    expect(repository.getProfile('profile-b').tagWeights).toEqual({ jazz: 4 });
    db.close();
  });
});
