import { describe, expect, test } from '@jest/globals';

import { createConversationDb } from '../src/conversation/repositories/SqliteRepositories';
import { DailyLifeRepository } from '../src/dailyLife/DailyLifeRepository';

function addUser(db: ReturnType<typeof createConversationDb>, id: string, household: string, role: 'owner' | 'resident') {
  db.prepare(`INSERT INTO users(user_id,email_normalized,display_name,status,created_at_ms,updated_at_ms)
    VALUES (?,?,?,'active',1,1)`).run(id, `${id}@example.test`, id);
  if (role === 'owner') {
    db.prepare(`INSERT OR IGNORE INTO households(household_id,name,created_by_user_id,created_at_ms,updated_at_ms)
      VALUES (?, 'Maison', ?, 1, 1)`).run(household, id);
  }
  db.prepare(`INSERT INTO household_memberships(household_id,user_id,role_key,status,created_at_ms,updated_at_ms)
    VALUES (?, ?, ?, 'active', 1, 1)`).run(household, id, role);
}

describe('DailyLifeRepository', () => {
  test('shares household lists with residents and isolates other households', () => {
    const db = createConversationDb(':memory:');
    addUser(db, 'owner', 'home:one', 'owner');
    addUser(db, 'chloe', 'home:one', 'resident');
    addUser(db, 'other', 'home:two', 'owner');
    const repository = new DailyLifeRepository(db);
    const courses = repository.snapshot('owner', 100).lists.find((list) => list.kind === 'shopping')!;
    repository.createItem('owner', courses.listId, { title: 'Café', quantity: '2 paquets' }, 110);

    expect(repository.snapshot('chloe', 120).lists.find((list) => list.listId === courses.listId)?.items[0]?.title)
      .toBe('Café');
    expect(repository.snapshot('other', 120).lists.some((list) => list.listId === courses.listId)).toBe(false);
    expect(() => repository.createItem('other', courses.listId, { title: 'Intrus' }, 130))
      .toThrow('daily_life_list_not_found');
    db.close();
  });

  test('reactivates recurring items and rejects stale updates', () => {
    const db = createConversationDb(':memory:');
    addUser(db, 'owner', 'home:one', 'owner');
    const repository = new DailyLifeRepository(db);
    const todo = repository.snapshot('owner', 100).lists.find((list) => list.kind === 'todo')!;
    const item = repository.createItem('owner', todo.listId, {
      title: 'Sortir les poubelles', recurrenceUnit: 'week', dueAtMs: 1_000,
    }, 200);
    const completed = repository.updateItem('owner', item.itemId, 1, { completed: true }, 500);
    expect(completed.nextOccurrenceAtMs).toBe(604_801_000);
    expect(() => repository.updateItem('owner', item.itemId, 1, { title: 'Ancien état' }, 600))
      .toThrow('daily_life_version_conflict');
    const beforeProcessing = repository.snapshot('owner', 604_801_000).lists
      .flatMap((list) => list.items).find((candidate) => candidate.itemId === item.itemId)!;
    expect(beforeProcessing.completedAtMs).toBe(500);
    expect(repository.processDueRecurrences(604_801_000)).toBe(1);
    expect(repository.processDueRecurrences(604_801_000)).toBe(0);
    const reactivated = repository.snapshot('owner', 604_801_000).lists
      .flatMap((list) => list.items).find((candidate) => candidate.itemId === item.itemId)!;
    expect(reactivated.completedAtMs).toBeNull();
    expect(reactivated.dueAtMs).toBe(604_801_000);
    expect(reactivated.version).toBe(3);
    expect(repository.listItemOccurrences('owner', item.itemId)).toEqual([
      expect.objectContaining({
        itemId: item.itemId,
        itemVersion: 1,
        completedAtMs: 500,
        completedByUserId: 'owner',
      }),
    ]);
    db.close();
  });

  test('keeps monthly recurrence on the last valid day of shorter months', () => {
    const db = createConversationDb(':memory:');
    addUser(db, 'owner', 'home:one', 'owner');
    const repository = new DailyLifeRepository(db);
    const todo = repository.snapshot('owner').lists.find((list) => list.kind === 'todo')!;
    const january31 = Date.UTC(2027, 0, 31, 12);
    const item = repository.createItem('owner', todo.listId, {
      title: 'Relevé mensuel', recurrenceUnit: 'month', dueAtMs: january31,
    }, january31);
    const completed = repository.updateItem('owner', item.itemId, item.version, { completed: true }, january31);
    expect(completed.nextOccurrenceAtMs).toBe(Date.UTC(2027, 1, 28, 12));
    expect(repository.processDueRecurrences(completed.nextOccurrenceAtMs!)).toBe(1);
    const february = repository.snapshot('owner').lists.flatMap((list) => list.items)
      .find((candidate) => candidate.itemId === item.itemId)!;
    const completedAgain = repository.updateItem(
      'owner', item.itemId, february.version, { completed: true }, february.dueAtMs!
    );
    expect(completedAgain.nextOccurrenceAtMs).toBe(Date.UTC(2027, 2, 31, 11));
    db.close();
  });

  test('preserves the Paris wall-clock time across daylight-saving changes', () => {
    const db = createConversationDb(':memory:');
    addUser(db, 'owner', 'home:one', 'owner');
    const repository = new DailyLifeRepository(db);
    const todo = repository.snapshot('owner').lists.find((list) => list.kind === 'todo')!;
    const nineInParisBeforeDst = Date.UTC(2027, 2, 27, 8);
    const item = repository.createItem('owner', todo.listId, {
      title: 'Routine du matin', recurrenceUnit: 'day', dueAtMs: nineInParisBeforeDst,
    }, nineInParisBeforeDst);

    const completed = repository.updateItem(
      'owner', item.itemId, item.version, { completed: true }, nineInParisBeforeDst
    );

    expect(completed.nextOccurrenceAtMs).toBe(Date.UTC(2027, 2, 28, 7));
    db.close();
  });

  test('restores leap-day yearly recurrences when the leap year returns', () => {
    const db = createConversationDb(':memory:');
    addUser(db, 'owner', 'home:one', 'owner');
    const repository = new DailyLifeRepository(db);
    const todo = repository.snapshot('owner').lists.find((list) => list.kind === 'todo')!;
    const leapDay = Date.UTC(2024, 1, 29, 11);
    const item = repository.createItem('owner', todo.listId, {
      title: 'Leap', recurrenceUnit: 'year', recurrenceInterval: 4, dueAtMs: leapDay,
    }, leapDay);

    const completed = repository.updateItem('owner', item.itemId, item.version, { completed: true }, leapDay);

    expect(completed.nextOccurrenceAtMs).toBe(Date.UTC(2028, 1, 29, 11));
    db.close();
  });

  test('supports flexible intervals and household assignment', () => {
    const db = createConversationDb(':memory:');
    addUser(db, 'owner', 'home:one', 'owner');
    addUser(db, 'chloe', 'home:one', 'resident');
    const repository = new DailyLifeRepository(db);
    const todo = repository.snapshot('owner').lists.find((list) => list.kind === 'todo')!;
    const start = Date.UTC(2027, 2, 15, 12);
    const item = repository.createItem('owner', todo.listId, {
      title: 'Contrôle chaudière', dueAtMs: start, recurrenceUnit: 'quarter',
      recurrenceInterval: 4, assignedToUserId: 'chloe',
    }, start);
    expect(item.assignedToDisplayName).toBe('chloe');
    expect(item.recurrenceUnit).toBe('quarter');
    const completed = repository.updateItem('chloe', item.itemId, item.version, { completed: true }, start);
    expect(completed.nextOccurrenceAtMs).toBe(Date.UTC(2028, 2, 15, 12));
    expect(() => repository.updateItem('owner', item.itemId, completed.version, { assignedToUserId: 'unknown' }))
      .toThrow('daily_life_assignee_invalid');
    db.close();
  });

  test('stores the full supported recurrence interval beyond the legacy limit', () => {
    const db = createConversationDb(':memory:');
    addUser(db, 'owner', 'home:one', 'owner');
    const repository = new DailyLifeRepository(db);
    const todo = repository.snapshot('owner').lists.find((list) => list.kind === 'todo')!;
    const item = repository.createItem('owner', todo.listId, {
      title: 'Très lointain', recurrenceUnit: 'day', recurrenceInterval: 999,
    });
    expect(item.recurrenceInterval).toBe(999);
    const completed = repository.updateItem('owner', item.itemId, item.version, { completed: true }, 1_000);
    expect(completed.nextOccurrenceAtMs).toBe(1_000 + (999 * 86_400_000));
    db.close();
  });

  test('requires a connected calendar before explicitly sharing it with the household', () => {
    const db = createConversationDb(':memory:');
    addUser(db, 'owner', 'home:one', 'owner');
    addUser(db, 'chloe', 'home:one', 'resident');
    addUser(db, 'other', 'home:two', 'owner');
    const repository = new DailyLifeRepository(db);
    expect(() => repository.setCalendarSharing('owner', true)).toThrow(
      'daily_life_calendar_connection_required'
    );
    db.prepare(`INSERT INTO integration_connections(
      connection_id,owner_user_id,provider,scopes_json,status,connection_kind,created_at_ms,updated_at_ms
    ) VALUES ('calendar-owner','owner','google-calendar','[]','active','personal',1,1)`).run();

    repository.setCalendarSharing('owner', true, 200);
    expect(repository.calendarMembers('chloe').members).toEqual(expect.arrayContaining([
      expect.objectContaining({ userId: 'owner', connected: true, sharing: true, isCurrentUser: false }),
      expect.objectContaining({ userId: 'chloe', connected: false, sharing: false, isCurrentUser: true }),
    ]));
    expect(repository.calendarMembers('other').members).toHaveLength(1);
    repository.setCalendarSharing('owner', false, 300);
    expect(repository.calendarMembers('chloe').members.find((member) => member.userId === 'owner')?.sharing)
      .toBe(false);
    db.close();
  });
});
