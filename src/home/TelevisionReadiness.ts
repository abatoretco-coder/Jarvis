import { type HomeAssistantClient,HomeAssistantRequestError } from '../haClient';
import { type HassState, isHassState } from '../hass';
import { HOME_ACTION_TIMING } from './HomeActionTiming';

const DEFAULT_POLL_ATTEMPTS = HOME_ACTION_TIMING.television.pollAttempts;
const DEFAULT_POLL_INTERVAL_MS = HOME_ACTION_TIMING.television.pollIntervalMs;
const NOT_READY_STATES = new Set(['off', 'unavailable', 'unknown']);

export type TelevisionReadinessResult =
  | { ok: true; state: HassState }
  | {
      ok: false;
      code: 'television_control_failed' | 'television_state_timeout';
      operationStatus: 'failed' | 'uncertain';
    };

function isReady(state: unknown): state is HassState {
  return isHassState(state) && !NOT_READY_STATES.has(state.state);
}

export async function ensureTelevisionReady(input: {
  ha: HomeAssistantClient;
  entityId: string;
  wakeOnLanMac?: string;
  wakeOnLanBroadcastAddress?: string;
  pollAttempts?: number;
  pollIntervalMs?: number;
  wait?: (milliseconds: number) => Promise<void>;
}): Promise<TelevisionReadinessResult> {
  try {
    const initialState = await input.ha.getState(input.entityId);
    if (isReady(initialState)) return { ok: true, state: initialState };
  } catch {
    // A sleeping television may be temporarily absent from Home Assistant.
  }

  try {
    if (input.wakeOnLanMac) {
      await input.ha.callService({
        domain: 'wake_on_lan',
        service: 'send_magic_packet',
        serviceData: {
          mac: input.wakeOnLanMac,
          ...(input.wakeOnLanBroadcastAddress
            ? { broadcast_address: input.wakeOnLanBroadcastAddress }
            : {}),
        },
      });
    } else {
      await input.ha.callService({
        domain: 'media_player',
        service: 'turn_on',
        target: { entity_id: input.entityId },
      });
    }
  } catch (error) {
    if (error instanceof HomeAssistantRequestError && error.operationMayHaveBeenAccepted) {
      return {
        ok: false,
        code: 'television_state_timeout',
        operationStatus: 'uncertain',
      };
    }
    return {
      ok: false,
      code: 'television_control_failed',
      operationStatus: 'failed',
    };
  }

  const attempts = Math.max(1, input.pollAttempts ?? DEFAULT_POLL_ATTEMPTS);
  const intervalMs = Math.max(0, input.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS);
  const wait =
    input.wait ??
    ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    await wait(intervalMs);
    try {
      const state = await input.ha.getState(input.entityId);
      if (isReady(state)) return { ok: true, state };
    } catch {
      // Keep polling: Home Assistant can briefly lose the entity while webOS boots.
    }
  }

  return {
    ok: false,
    code: 'television_state_timeout',
    operationStatus: 'uncertain',
  };
}
