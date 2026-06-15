/**
 * haAgentRouter — compatibility re-export layer for HA Agent Router.
 *
 * The canonical implementation lives in `orchestratorRouter.ts`.
 * This module re-exports everything under the names expected by tests
 * and any external consumers that import from `haAgentRouter`.
 */

export type { RouterOptions, RouterResult, RouterTarget } from './orchestratorRouter';
export {
  routeUserRequest as routeToHaAgent,
  SPOTIFY_AGENT_ID,
  synthesizeAgentResponses,
} from './orchestratorRouter';

/**
 * HaAgentEntry — agent entry without the routing `key` label.
 * The `key` field is a human-readable label used only internally in ingest.ts;
 * consumers of haAgentRouter only need agentId + hint.
 */
export type HaAgentEntry = {
  agentId: string;
  hint: string;
};

/**
 * Parse HA_AGENT_MAP env var into HaAgentEntry[].
 *
 * Format: "key:entity_id:hint|key2:entity_id2:hint2"
 * The leading key segment is used for routing labels (stripped from output).
 */
export function parseAgentMap(raw: string | undefined): HaAgentEntry[] {
  if (!raw?.trim()) return [];
  return raw
    .split('|')
    .map((segment) => {
      const firstColon = segment.indexOf(':');
      const secondColon = segment.indexOf(':', firstColon + 1);
      if (firstColon === -1 || secondColon === -1) return null;
      const agentId = segment.slice(firstColon + 1, secondColon).trim();
      const hint = segment.slice(secondColon + 1).trim();
      if (!agentId || !hint) return null;
      return { agentId, hint };
    })
    .filter((e): e is HaAgentEntry => e !== null);
}

