import type { HomeActionName } from './HomeCatalog';

export type HomeActionTimingBudget = {
  pollAttempts: number;
  pollIntervalMs: number;
  clientTimeoutMs: number;
};

export const HOME_ACTION_TIMING = {
  switch: { pollAttempts: 10, pollIntervalMs: 300, clientTimeoutMs: 12_000 },
  robot: { pollAttempts: 12, pollIntervalMs: 1_000, clientTimeoutMs: 22_000 },
  television: { pollAttempts: 20, pollIntervalMs: 1_000, clientTimeoutMs: 32_000 },
  generic: { pollAttempts: 8, pollIntervalMs: 500, clientTimeoutMs: 15_000 },
  scene: { pollAttempts: 20, pollIntervalMs: 1_000, clientTimeoutMs: 35_000 },
  spotify: { pollAttempts: 25, pollIntervalMs: 1_000, clientTimeoutMs: 60_000 },
} as const satisfies Record<string, HomeActionTimingBudget>;

export function homeActionTiming(domain: string, action: HomeActionName): HomeActionTimingBudget {
  if (domain === 'media_player' && action === 'turn_on') return HOME_ACTION_TIMING.television;
  if (domain === 'vacuum') return HOME_ACTION_TIMING.robot;
  if (domain === 'light' || domain === 'switch') return HOME_ACTION_TIMING.switch;
  return HOME_ACTION_TIMING.generic;
}
