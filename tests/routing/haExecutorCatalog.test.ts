import { describe, expect, it } from '@jest/globals';

import { HA_E1_ROUTES, SEMANTIC_ROUTES } from '../../src/routing/semanticRouteCatalog';

const expectedExecutorRoutes = [
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

describe('HA executor semantic catalog', () => {
  it('contains all expected executor routes', () => {
    const keys = HA_E1_ROUTES.map((r) => r.key);
    expect(keys).toEqual(expect.arrayContaining(expectedExecutorRoutes));
    expect(keys.length).toBe(expectedExecutorRoutes.length);
  });

  it('registers executor routes as E1 planner routes targeting executors', () => {
    for (const route of HA_E1_ROUTES) {
      expect(route.level).toBe('E1');
      expect(route.targetAgentId).toBe('executors');
      expect(route.plannerRequired).toBe(true);
      expect(route.directRequest?.domain).toBe('executors');
      expect(route.examples.length).toBeGreaterThan(0);
    }
  });

  it('includes executor routes in the master semantic catalog', () => {
    const keys = SEMANTIC_ROUTES.map((r) => r.key);
    for (const routeKey of expectedExecutorRoutes) {
      expect(keys).toContain(routeKey);
    }
  });
});
