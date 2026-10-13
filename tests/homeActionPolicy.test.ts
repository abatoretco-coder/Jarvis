import { describe, expect, test } from '@jest/globals';

import { canStartRobotRoomCleaning, homeActionStateAlreadySatisfied, homeActionStateConflict } from '../src/home/HomeActionPolicy';

describe('home action state policy', () => {
  test('prevents contradictory television power commands', () => {
    expect(homeActionStateConflict({ domain: 'media_player', action: 'turn_on', state: 'playing' })).toBeTruthy();
    expect(homeActionStateConflict({ domain: 'media_player', action: 'turn_off', state: 'off' })).toBeTruthy();
    expect(homeActionStateConflict({ domain: 'media_player', action: 'turn_on', state: 'off' })).toBeNull();
    expect(homeActionStateConflict({ domain: 'media_player', action: 'turn_off', state: 'playing' })).toBeNull();
    expect(homeActionStateConflict({ domain: 'media_player', action: 'select_source', state: 'turning_on' })).toBeTruthy();
  });

  test('recognizes an already satisfied television power state for idempotent scenes', () => {
    expect(homeActionStateAlreadySatisfied({ domain: 'media_player', action: 'turn_off', state: 'off' })).toBe(true);
    expect(homeActionStateAlreadySatisfied({ domain: 'media_player', action: 'turn_off', state: 'standby' })).toBe(true);
    expect(homeActionStateAlreadySatisfied({ domain: 'media_player', action: 'turn_on', state: 'playing' })).toBe(true);
    expect(homeActionStateAlreadySatisfied({ domain: 'media_player', action: 'turn_off', state: 'playing' })).toBe(false);
    expect(homeActionStateAlreadySatisfied({ domain: 'media_player', action: 'turn_off', state: 'unavailable' })).toBe(false);
  });

  test('only exposes robot commands compatible with its live state', () => {
    expect(homeActionStateConflict({ domain: 'vacuum', action: 'start', state: 'cleaning' })).toBeTruthy();
    expect(homeActionStateConflict({ domain: 'vacuum', action: 'start', state: 'docked' })).toBeNull();
    expect(homeActionStateConflict({ domain: 'vacuum', action: 'return_to_base', state: 'docked' })).toBeTruthy();
    expect(homeActionStateConflict({ domain: 'vacuum', action: 'return_to_base', state: 'cleaning' })).toBeNull();
    expect(homeActionStateConflict({ domain: 'vacuum', action: 'start_mop_drying', state: 'docked', dryingTimeRemainingMinutes: 12 })).toBeTruthy();
    expect(homeActionStateConflict({ domain: 'vacuum', action: 'stop_mop_drying', state: 'docked', dryingTimeRemainingMinutes: 12 })).toBeNull();
  });

  test('blocks targeted room cleaning while moving or drying', () => {
    expect(canStartRobotRoomCleaning('cleaning')).toBe(false);
    expect(canStartRobotRoomCleaning('returning')).toBe(false);
    expect(canStartRobotRoomCleaning('docked', 15)).toBe(false);
    expect(canStartRobotRoomCleaning('docked', 0)).toBe(true);
  });
});
