import { randomUUID } from 'node:crypto';

import Database from 'better-sqlite3';

export type DailyLifeKind = 'shopping' | 'todo';
export type DailyLifeRecurrence = 'none' | 'weekly' | 'monthly';
export type DailyLifeRecurrenceUnit = 'none' | 'day' | 'week' | 'month' | 'quarter' | 'year';
export type DailyLifeMember = { userId: string; displayName: string };
export type HouseholdAgendaMember = DailyLifeMember & {
  connected: boolean;
  sharing: boolean;
  isCurrentUser: boolean;
};

export type DailyLifeItem = {
  itemId: string;
  listId: string;
  title: string;
  details: string;
  quantity: string | null;
  category: string | null;
  dueAtMs: number | null;
  recurrence: DailyLifeRecurrence;
  recurrenceUnit: DailyLifeRecurrenceUnit;
  recurrenceInterval: number;
  recurrenceAnchorAtMs: number | null;
  assignedToUserId: string | null;
  assignedToDisplayName: string | null;
  nextOccurrenceAtMs: number | null;
  completedAtMs: number | null;
  position: number;
  version: number;
  createdByUserId: string;
  updatedByUserId: string;
  createdAtMs: number;
  updatedAtMs: number;
};

export type DailyLifeList = {
  listId: string;
  kind: DailyLifeKind;
  name: string;
  position: number;
  items: DailyLifeItem[];
  createdAtMs: number;
  updatedAtMs: number;
};

export type DailyLifeOccurrence = {
  occurrenceId: string;
  itemId: string;
  itemVersion: number;
  dueAtMs: number | null;
  completedAtMs: number;
  completedByUserId: string;
  assignedToUserId: string | null;
  title: string;
};

type ItemRow = {
  item_id: string; list_id: string; title: string; details: string;
  quantity: string | null; category: string | null; due_at_ms: number | null;
  recurrence: DailyLifeRecurrence; recurrence_interval: number; recurrence_every: number;
  recurrence_unit: DailyLifeRecurrenceUnit; recurrence_anchor_at_ms: number | null;
  assigned_to_user_id: string | null; assigned_to_display_name?: string | null;
  next_occurrence_at_ms: number | null; completed_at_ms: number | null;
  position: number; version: number; created_by_user_id: string;
  updated_by_user_id: string; created_at_ms: number; updated_at_ms: number;
};

function itemFromRow(row: ItemRow): DailyLifeItem {
  return {
    itemId: row.item_id,
    listId: row.list_id,
    title: row.title,
    details: row.details,
    quantity: row.quantity,
    category: row.category,
    dueAtMs: row.due_at_ms,
    recurrence: row.recurrence,
    recurrenceUnit: row.recurrence_unit,
    recurrenceInterval: row.recurrence_every,
    recurrenceAnchorAtMs: row.recurrence_anchor_at_ms,
    assignedToUserId: row.assigned_to_user_id,
    assignedToDisplayName: row.assigned_to_display_name ?? null,
    nextOccurrenceAtMs: row.next_occurrence_at_ms,
    completedAtMs: row.completed_at_ms,
    position: row.position,
    version: row.version,
    createdByUserId: row.created_by_user_id,
    updatedByUserId: row.updated_by_user_id,
    createdAtMs: row.created_at_ms,
    updatedAtMs: row.updated_at_ms,
  };
}

type ParisDateParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
};

const parisFormatter = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/Paris',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

function parisParts(value: number): ParisDateParts {
  const parts = Object.fromEntries(
    parisFormatter.formatToParts(new Date(value)).map((part) => [part.type, part.value])
  );
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
  };
}

function civilValue(parts: ParisDateParts): number {
  return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
}

function parisInstant(parts: ParisDateParts): number {
  const targetCivil = civilValue(parts);
  let firstAfterGap: { instant: number; civil: number } | undefined;
  for (let instant = targetCivil - (4 * 3_600_000); instant <= targetCivil + (4 * 3_600_000); instant += 60_000) {
    const observed = parisParts(instant);
    const observedCivil = civilValue(observed);
    if (observedCivil === targetCivil) return instant;
    if (
      observed.year === parts.year
      && observed.month === parts.month
      && observed.day === parts.day
      && observedCivil > targetCivil
      && (!firstAfterGap || observedCivil < firstAfterGap.civil)
    ) firstAfterGap = { instant, civil: observedCivil };
  }
  return firstAfterGap?.instant ?? targetCivil;
}

function nextOccurrence(
  fromMs: number,
  unit: DailyLifeRecurrenceUnit,
  interval: number,
  anchorMs = fromMs
): number | null {
  if (unit === 'none') return null;
  const current = parisParts(fromMs);
  const anchor = parisParts(anchorMs);
  const date = new Date(Date.UTC(
    current.year,
    current.month - 1,
    current.day,
    anchor.hour,
    anchor.minute,
    anchor.second
  ));
  if (unit === 'day') date.setUTCDate(date.getUTCDate() + interval);
  else if (unit === 'week') date.setUTCDate(date.getUTCDate() + (7 * interval));
  else {
    const day = anchor.day;
    date.setUTCDate(1);
    const months = unit === 'quarter' ? interval * 3 : unit === 'year' ? interval * 12 : interval;
    date.setUTCMonth(date.getUTCMonth() + months);
    const lastDay = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
    date.setUTCDate(Math.min(day, lastDay));
  }
  return parisInstant({
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
    hour: date.getUTCHours(),
    minute: date.getUTCMinutes(),
    second: date.getUTCSeconds(),
  });
}

export class DailyLifeRepository {
  constructor(private readonly db: Database.Database) {}

  private householdId(userId: string): string {
    const row = this.db.prepare(
      `SELECT hm.household_id householdId
       FROM household_memberships hm
       WHERE hm.user_id=? AND hm.status='active'
       ORDER BY CASE hm.role_key WHEN 'owner' THEN 0 WHEN 'resident' THEN 1 ELSE 2 END,
                hm.created_at_ms, hm.household_id
       LIMIT 1`
    ).get(userId) as { householdId: string } | undefined;
    if (!row) throw new Error('daily_life_household_required');
    return row.householdId;
  }

  private assertList(userId: string, listId: string): { householdId: string; kind: DailyLifeKind } {
    const householdId = this.householdId(userId);
    const row = this.db.prepare(
      `SELECT kind FROM daily_life_lists
       WHERE list_id=? AND household_id=? AND archived_at_ms IS NULL`
    ).get(listId, householdId) as { kind: DailyLifeKind } | undefined;
    if (!row) throw new Error('daily_life_list_not_found');
    return { householdId, kind: row.kind };
  }

  private seedDefaults(userId: string, householdId: string, now: number): void {
    const count = this.db.prepare(
      'SELECT COUNT(*) count FROM daily_life_lists WHERE household_id=? AND archived_at_ms IS NULL'
    ).get(householdId) as { count: number };
    if (count.count > 0) return;
    const insert = this.db.prepare(
      `INSERT INTO daily_life_lists(
        list_id,household_id,kind,name,position,created_by_user_id,created_at_ms,updated_at_ms
      ) VALUES (?,?,?,?,?,?,?,?)`
    );
    insert.run(randomUUID(), householdId, 'shopping', 'Courses', 0, userId, now, now);
    insert.run(randomUUID(), householdId, 'todo', 'À faire', 0, userId, now, now);
  }

  processDueRecurrences(now = Date.now()): number {
    return this.db.prepare(
      `UPDATE daily_life_items
       SET completed_at_ms=NULL, due_at_ms=next_occurrence_at_ms, next_occurrence_at_ms=NULL,
           version=version+1, updated_at_ms=?
       WHERE completed_at_ms IS NOT NULL
         AND next_occurrence_at_ms IS NOT NULL AND next_occurrence_at_ms<=?
         AND list_id IN (SELECT list_id FROM daily_life_lists WHERE archived_at_ms IS NULL)`
    ).run(now, now).changes;
  }

  snapshot(userId: string, now = Date.now()): { householdId: string; members: DailyLifeMember[]; lists: DailyLifeList[] } {
    const householdId = this.householdId(userId);
    this.seedDefaults(userId, householdId, now);
    const rows = this.db.prepare(
      `SELECT list_id listId,kind,name,position,created_at_ms createdAtMs,updated_at_ms updatedAtMs
       FROM daily_life_lists WHERE household_id=? AND archived_at_ms IS NULL
       ORDER BY kind,position,created_at_ms`
    ).all(householdId) as Array<Omit<DailyLifeList, 'items'>>;
    const itemStatement = this.db.prepare(
      `SELECT i.*,u.display_name assigned_to_display_name
       FROM daily_life_items i LEFT JOIN users u ON u.user_id=i.assigned_to_user_id
       WHERE i.list_id=?
       ORDER BY i.completed_at_ms IS NOT NULL, i.position, i.created_at_ms`
    );
    const members = this.db.prepare(
      `SELECT u.user_id userId,COALESCE(NULLIF(u.display_name,''),u.email_normalized) displayName
       FROM household_memberships hm JOIN users u ON u.user_id=hm.user_id
       WHERE hm.household_id=? AND hm.status='active' AND u.status='active'
       ORDER BY CASE hm.role_key WHEN 'owner' THEN 0 WHEN 'resident' THEN 1 ELSE 2 END, displayName`
    ).all(householdId) as DailyLifeMember[];
    return {
      householdId,
      members,
      lists: rows.map((row) => ({
        ...row,
        items: (itemStatement.all(row.listId) as ItemRow[]).map(itemFromRow),
      })),
    };
  }

  calendarMembers(userId: string): { householdId: string; members: HouseholdAgendaMember[] } {
    const householdId = this.householdId(userId);
    const members = this.db.prepare(
      `SELECT u.user_id userId,COALESCE(NULLIF(u.display_name,''),u.email_normalized) displayName,
        EXISTS(
          SELECT 1 FROM integration_connections c
          WHERE c.owner_user_id=u.user_id AND c.provider='google-calendar'
            AND c.connection_kind='personal' AND c.status='active'
        ) connected,
        EXISTS(
          SELECT 1 FROM daily_life_calendar_shares s
          WHERE s.household_id=hm.household_id AND s.user_id=hm.user_id
        ) sharing
       FROM household_memberships hm JOIN users u ON u.user_id=hm.user_id
       WHERE hm.household_id=? AND hm.status='active' AND u.status='active'
       ORDER BY CASE hm.role_key WHEN 'owner' THEN 0 WHEN 'resident' THEN 1 ELSE 2 END, displayName`
    ).all(householdId) as Array<{
      userId: string; displayName: string; connected: number; sharing: number;
    }>;
    return {
      householdId,
      members: members.map((member) => ({
        userId: member.userId,
        displayName: member.displayName,
        connected: Boolean(member.connected),
        sharing: Boolean(member.sharing),
        isCurrentUser: member.userId === userId,
      })),
    };
  }

  setCalendarSharing(userId: string, enabled: boolean, now = Date.now()): void {
    const householdId = this.householdId(userId);
    if (enabled) {
      const connected = this.db.prepare(
        `SELECT 1 FROM integration_connections
         WHERE owner_user_id=? AND provider='google-calendar'
           AND connection_kind='personal' AND status='active' LIMIT 1`
      ).get(userId);
      if (!connected) throw new Error('daily_life_calendar_connection_required');
      this.db.prepare(
        `INSERT INTO daily_life_calendar_shares(household_id,user_id,enabled_at_ms,updated_at_ms)
         VALUES (?,?,?,?) ON CONFLICT(household_id,user_id) DO UPDATE SET updated_at_ms=excluded.updated_at_ms`
      ).run(householdId, userId, now, now);
      return;
    }
    this.db.prepare(
      'DELETE FROM daily_life_calendar_shares WHERE household_id=? AND user_id=?'
    ).run(householdId, userId);
  }

  createList(userId: string, input: { kind: DailyLifeKind; name: string }, now = Date.now()): DailyLifeList {
    const householdId = this.householdId(userId);
    const listId = randomUUID();
    try {
      const position = (this.db.prepare(
        'SELECT COALESCE(MAX(position),-1)+1 value FROM daily_life_lists WHERE household_id=? AND kind=?'
      ).get(householdId, input.kind) as { value: number }).value;
      this.db.prepare(
        `INSERT INTO daily_life_lists(list_id,household_id,kind,name,position,created_by_user_id,created_at_ms,updated_at_ms)
         VALUES (?,?,?,?,?,?,?,?)`
      ).run(listId, householdId, input.kind, input.name, position, userId, now, now);
    } catch (error) {
      if (String(error).includes('UNIQUE')) throw new Error('daily_life_list_exists', { cause: error });
      throw error;
    }
    return { listId, kind: input.kind, name: input.name, position: 0, items: [], createdAtMs: now, updatedAtMs: now };
  }

  updateList(userId: string, listId: string, input: { name?: string; archived?: boolean }, now = Date.now()): void {
    this.assertList(userId, listId);
    let changed: number;
    try {
      changed = this.db.prepare(
        `UPDATE daily_life_lists
         SET name=COALESCE(?,name), archived_at_ms=CASE WHEN ?=1 THEN ? ELSE archived_at_ms END, updated_at_ms=?
         WHERE list_id=?`
      ).run(input.name ?? null, input.archived ? 1 : 0, now, now, listId).changes;
    } catch (error) {
      if (String(error).includes('UNIQUE')) throw new Error('daily_life_list_exists', { cause: error });
      throw error;
    }
    if (!changed) throw new Error('daily_life_list_not_found');
  }

  createItem(userId: string, listId: string, input: {
    title: string; details?: string; quantity?: string | null; category?: string | null;
    dueAtMs?: number | null; recurrenceUnit?: DailyLifeRecurrenceUnit; recurrenceInterval?: number;
    recurrenceAnchorAtMs?: number | null; assignedToUserId?: string | null;
  }, now = Date.now()): DailyLifeItem {
    const { householdId, kind } = this.assertList(userId, listId);
    const itemId = randomUUID();
    const recurrenceUnit = input.recurrenceUnit ?? 'none';
    const interval = input.recurrenceInterval ?? 1;
    this.assertAssignee(householdId, input.assignedToUserId ?? null);
    const position = (this.db.prepare(
      'SELECT COALESCE(MAX(position),-1)+1 value FROM daily_life_items WHERE list_id=?'
    ).get(listId) as { value: number }).value;
    const quantity = kind === 'shopping' ? input.quantity ?? null : null;
    const category = kind === 'shopping' ? input.category ?? null : null;
    const dueAtMs = input.dueAtMs ?? null;
    const anchorAtMs = input.recurrenceAnchorAtMs ?? dueAtMs;
    const legacyRecurrence: DailyLifeRecurrence = recurrenceUnit === 'week' ? 'weekly' : recurrenceUnit === 'month' ? 'monthly' : 'none';
    this.db.prepare(
      `INSERT INTO daily_life_items(
        item_id,list_id,title,details,quantity,category,due_at_ms,recurrence,recurrence_interval,recurrence_every,
        recurrence_unit,recurrence_anchor_at_ms,assigned_to_user_id,
        position,created_by_user_id,updated_by_user_id,created_at_ms,updated_at_ms
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run(itemId, listId, input.title, input.details ?? '', quantity, category, dueAtMs,
      legacyRecurrence, Math.min(interval, 52), interval, recurrenceUnit, anchorAtMs, input.assignedToUserId ?? null,
      position, userId, userId, now, now);
    return this.readItem(itemId);
  }

  updateItem(userId: string, itemId: string, expectedVersion: number, input: {
    title?: string; details?: string; quantity?: string | null; category?: string | null;
    dueAtMs?: number | null; recurrenceUnit?: DailyLifeRecurrenceUnit; recurrenceInterval?: number;
    recurrenceAnchorAtMs?: number | null; assignedToUserId?: string | null;
    completed?: boolean;
  }, now = Date.now()): DailyLifeItem {
    return this.db.transaction(() => {
      const row = this.db.prepare(
      `SELECT i.* FROM daily_life_items i JOIN daily_life_lists l ON l.list_id=i.list_id
       JOIN household_memberships hm ON hm.household_id=l.household_id
       WHERE i.item_id=? AND hm.user_id=? AND hm.status='active' AND l.archived_at_ms IS NULL`
      ).get(itemId, userId) as ItemRow | undefined;
      if (!row) throw new Error('daily_life_item_not_found');
      if (row.version !== expectedVersion) throw new Error('daily_life_version_conflict');

      const householdId = this.householdId(userId);
      this.assertAssignee(householdId, input.assignedToUserId === undefined ? row.assigned_to_user_id : input.assignedToUserId);
      const recurrenceUnit = input.recurrenceUnit ?? row.recurrence_unit;
      const interval = input.recurrenceInterval ?? row.recurrence_every;
      const anchorAt = input.recurrenceAnchorAtMs === undefined ? row.recurrence_anchor_at_ms : input.recurrenceAnchorAtMs;
      const dueAt = input.dueAtMs === undefined ? row.due_at_ms : input.dueAtMs;
      let completedAt = row.completed_at_ms;
      let nextAt = row.next_occurrence_at_ms;
      const recordOccurrence = input.completed === true && completedAt === null;
      if (recordOccurrence) {
        completedAt = now;
        nextAt = nextOccurrence(
          dueAt ?? anchorAt ?? now,
          recurrenceUnit,
          interval,
          anchorAt ?? dueAt ?? now
        );
      } else if (input.completed === false) {
        completedAt = null;
        nextAt = null;
      }
      const result = this.db.prepare(
      `UPDATE daily_life_items SET
        title=?,details=?,quantity=?,category=?,due_at_ms=?,recurrence=?,recurrence_interval=?,recurrence_every=?,
        recurrence_unit=?,recurrence_anchor_at_ms=?,assigned_to_user_id=?,
        completed_at_ms=?,next_occurrence_at_ms=?,updated_by_user_id=?,updated_at_ms=?,version=version+1
       WHERE item_id=? AND version=?`
      ).run(
      input.title ?? row.title, input.details ?? row.details,
      input.quantity === undefined ? row.quantity : input.quantity,
      input.category === undefined ? row.category : input.category,
      dueAt, recurrenceUnit === 'week' ? 'weekly' : recurrenceUnit === 'month' ? 'monthly' : 'none', Math.min(interval, 52), interval,
      recurrenceUnit, anchorAt,
      input.assignedToUserId === undefined ? row.assigned_to_user_id : input.assignedToUserId,
      completedAt, nextAt, userId, now, itemId, expectedVersion,
      );
      if (result.changes !== 1) throw new Error('daily_life_version_conflict');
      if (recordOccurrence) {
        this.db.prepare(
          `INSERT INTO daily_life_item_occurrences(
             occurrence_id,item_id,list_id,item_version,due_at_ms,completed_at_ms,completed_by_user_id,
             assigned_to_user_id,title,created_at_ms
           ) VALUES (?,?,?,?,?,?,?,?,?,?)`
        ).run(
          randomUUID(), itemId, row.list_id, row.version, dueAt, now, userId,
          input.assignedToUserId === undefined ? row.assigned_to_user_id : input.assignedToUserId,
          input.title ?? row.title, now
        );
      }
      return this.readItem(itemId);
    })();
  }

  listItemOccurrences(userId: string, itemId: string): DailyLifeOccurrence[] {
    const householdId = this.householdId(userId);
    return this.db.prepare(
      `SELECT o.occurrence_id occurrenceId,o.item_id itemId,o.item_version itemVersion,
              o.due_at_ms dueAtMs,o.completed_at_ms completedAtMs,
              o.completed_by_user_id completedByUserId,o.assigned_to_user_id assignedToUserId,o.title
       FROM daily_life_item_occurrences o
       JOIN daily_life_lists l ON l.list_id=o.list_id
       WHERE o.item_id=? AND l.household_id=?
       ORDER BY o.completed_at_ms DESC`
    ).all(itemId, householdId) as DailyLifeOccurrence[];
  }

  private assertAssignee(householdId: string, assigneeUserId: string | null): void {
    if (!assigneeUserId) return;
    const member = this.db.prepare(
      `SELECT 1 FROM household_memberships hm JOIN users u ON u.user_id=hm.user_id
       WHERE hm.household_id=? AND hm.user_id=? AND hm.status='active' AND u.status='active'`
    ).get(householdId, assigneeUserId);
    if (!member) throw new Error('daily_life_assignee_invalid');
  }

  private readItem(itemId: string): DailyLifeItem {
    return itemFromRow(this.db.prepare(
      `SELECT i.*,u.display_name assigned_to_display_name FROM daily_life_items i
       LEFT JOIN users u ON u.user_id=i.assigned_to_user_id WHERE i.item_id=?`
    ).get(itemId) as ItemRow);
  }

  deleteItem(userId: string, itemId: string, expectedVersion: number): void {
    const householdId = this.householdId(userId);
    const changed = this.db.prepare(
      `DELETE FROM daily_life_items WHERE item_id=? AND version=? AND list_id IN (
        SELECT list_id FROM daily_life_lists WHERE household_id=? AND archived_at_ms IS NULL
      )`
    ).run(itemId, expectedVersion, householdId).changes;
    if (!changed) {
      const exists = this.db.prepare('SELECT 1 FROM daily_life_items WHERE item_id=?').get(itemId);
      throw new Error(exists ? 'daily_life_version_conflict' : 'daily_life_item_not_found');
    }
  }
}
