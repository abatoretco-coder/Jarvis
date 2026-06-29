import { describe, expect, it } from '@jest/globals';

import { SEMANTIC_ROUTES } from '../../src/routing/semanticRouteCatalog';

const expectedE1Routes = [
  'spotify.search',
  'spotify.search_and_play',
  'spotify.queue_add',
  'spotify.transfer',
  'spotify.add_to_playlist',
  'spotify.volume_set',
  'search.deep.analysis',
  'search.deep.history',
  'search.deep.comparison',
  'todo.list_tasks',
  'todo.list_tasks.today',
  'todo.list_tasks.tomorrow',
  'todo.list_tasks.this_week',
  'todo.list_tasks.overdue',
  'todo.list_lists',
  'todo.add_task',
  'todo.complete_task',
  'todo.delete_task',
  'todo.update_task',
  'todo.create_list',
  'todo.delete_list',
  'todo.add_checklist_item',
  'todo.complete_checklist_item',
  'todo.delete_checklist_item',
  'mail.list_inbox',
  'mail.list_inbox.unread',
  'mail.search_emails',
  'mail.send_email',
  'mail.reply_email',
  'mail.forward_email',
  'mail.mark_read',
  'mail.mark_unread',
  'mail.trash_email',
  'mail.flag_email',
  'calendar.create_event',
  'calendar.delete_event',
  'calendar.update_event',
  'calendar.remove_from_event',
  'calendar.list_upcoming',
  'calendar.search_events',
  'executor.greeting',
  'executor.help',
  'executor.status',
  'executor.timer',
  'executor.note',
  'executor.scene_set',
  'executor.media_play_pause',
  'executor.media_next',
  'executor.media_previous',
  'executor.volume_up',
  'executor.volume_down',
  'executor.mute',
  'executor.unmute',
  'executor.climate_set',
  'executor.lock',
  'executor.unlock',
  'executor.vacuum_start',
  'executor.vacuum_stop',
  'executor.cover_open',
  'executor.cover_close',
];

describe('E1 semantic catalog', () => {
  it('contains all expected E1 routes', () => {
    const e1Keys = SEMANTIC_ROUTES.filter((r) => r.level === 'E1').map((r) => r.key);
    for (const routeKey of expectedE1Routes) {
      expect(e1Keys).toContain(routeKey);
    }
  });

  it('has no duplicate route keys', () => {
    const keys = SEMANTIC_ROUTES.map((r) => r.key);
    const uniques = new Set(keys);
    expect(uniques.size).toBe(keys.length);
  });

  it('enforces plannerRequired=true for all E1 routes', () => {
    const e1Routes = SEMANTIC_ROUTES.filter((r) => r.level === 'E1');
    expect(e1Routes.length).toBeGreaterThan(0);
    for (const route of e1Routes) {
      expect(route.plannerRequired).toBe(true);
    }
  });
});
