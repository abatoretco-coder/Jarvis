import type { HomeActionName } from './HomeCatalog';

export type HomeActionState = {
  domain: string;
  action: HomeActionName;
  state: string;
  dryingTimeRemainingMinutes?: number;
};

const unavailableStates = new Set(['unavailable', 'unknown', 'error']);
const televisionOffStates = new Set(['off', 'standby']);
const televisionTransitionStates = new Set(['turning_on', 'turning_off']);
const robotStationaryStates = new Set(['docked', 'idle', 'paused']);

export function homeActionStateConflict(input: HomeActionState): string | null {
  const state = input.state.toLowerCase();
  if (input.domain === 'media_player') {
    if (televisionTransitionStates.has(state)) return 'television_transition_in_progress';
    if (input.action === 'turn_on') {
      return televisionOffStates.has(state) || state === 'unavailable'
        ? null
        : 'television_already_on_or_state_unknown';
    }
    if (input.action === 'turn_off') {
      return televisionOffStates.has(state) || unavailableStates.has(state)
        ? 'television_already_off_or_state_unknown'
        : null;
    }
    return televisionOffStates.has(state) || unavailableStates.has(state)
      ? 'television_not_ready'
      : null;
  }

  if (input.domain !== 'vacuum') return null;
  const drying = (input.dryingTimeRemainingMinutes ?? 0) > 0;
  if (unavailableStates.has(state)) return 'vacuum_not_ready';
  if (input.action === 'start') {
    if (drying) return 'vacuum_drying';
    return robotStationaryStates.has(state) ? null : 'vacuum_already_active';
  }
  if (input.action === 'stop') {
    return ['cleaning', 'returning'].includes(state) ? null : 'vacuum_not_active';
  }
  if (input.action === 'return_to_base') {
    return ['cleaning', 'paused', 'idle'].includes(state) ? null : 'vacuum_already_docked_or_returning';
  }
  if (['empty_dust_bin', 'wash_mop'].includes(input.action)) {
    return state === 'docked' && !drying ? null : 'vacuum_station_unavailable';
  }
  if (input.action === 'start_mop_drying') {
    return state === 'docked' && !drying ? null : 'vacuum_drying_or_away';
  }
  if (input.action === 'stop_mop_drying') {
    return state === 'docked' && drying ? null : 'vacuum_not_drying';
  }
  return null;
}

export function canStartRobotRoomCleaning(state: string, dryingTimeRemainingMinutes?: number): boolean {
  return robotStationaryStates.has(state.toLowerCase()) && (dryingTimeRemainingMinutes ?? 0) <= 0;
}
