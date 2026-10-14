import {
  CAPABILITY_REGISTRY,
  type CapabilityAgent,
} from '../capabilities/capabilityRegistry';
import type { AgentRouteEntry } from './orchestratorRouter';

export type RouterExposure = 'orchestrator' | 'runtime_special' | 'pre_router';

/**
 * One explicit exposure strategy per canonical capability family. The CI check
 * rejects a new family until its routing ownership is declared here.
 */
export const ROUTER_EXPOSURE_BY_AGENT: Record<CapabilityAgent, RouterExposure> = {
  calendar: 'orchestrator',
  culture: 'pre_router',
  executor: 'runtime_special',
  mail: 'orchestrator',
  nas_status: 'pre_router',
  search: 'orchestrator',
  spotify: 'runtime_special',
  todo: 'orchestrator',
  weather: 'runtime_special',
};

export type DirectRouterAvailability = {
  calendar: boolean;
  mail: boolean;
  search: boolean;
  todo: boolean;
};

const DIRECT_ROUTER_ENTRIES: Record<keyof DirectRouterAvailability, AgentRouteEntry[]> = {
  calendar: [
    {
      agentId: 'calendar',
      routerId: 'calendar',
      key: 'calendar',
      hint: 'Google Calendar: consulter, rechercher, créer, modifier ou supprimer des événements',
    },
  ],
  mail: [
    {
      agentId: 'mail',
      routerId: 'mail',
      key: 'mail',
      hint: 'Gmail: lire, rechercher, envoyer, répondre, transférer et organiser les emails',
    },
  ],
  search: [
    {
      agentId: 'search.news',
      routerId: 'search.news',
      key: 'search.news',
      hint: 'Informations récentes: actualités, météo externe, sport, prix et événements actuels',
    },
    {
      agentId: 'search.web',
      routerId: 'search.web',
      key: 'search.web',
      hint: 'Recherche factuelle rapide: définitions, personnes, lieux et faits',
    },
    {
      agentId: 'search.deep',
      routerId: 'search.deep',
      key: 'search.deep',
      hint: 'Recherche approfondie: analyses, histoire et comparaisons complexes',
    },
  ],
  todo: [
    {
      agentId: 'todo',
      routerId: 'todo',
      key: 'todo',
      hint: 'Microsoft To Do: consulter et gérer tâches, listes et checklists',
    },
  ],
};

const RESERVED_DIRECT_KEYS = new Set(
  Object.values(DIRECT_ROUTER_ENTRIES)
    .flat()
    .flatMap((entry) => [entry.key, entry.routerId, entry.agentId])
    .filter((value): value is string => Boolean(value))
);

function assertCanonicalDirectFamilies(): void {
  for (const agent of Object.keys(DIRECT_ROUTER_ENTRIES) as Array<
    keyof DirectRouterAvailability
  >) {
    if (!CAPABILITY_REGISTRY.some((capability) => capability.agent === agent)) {
      throw new Error(`router_agent_catalog_missing_capability_family:${agent}`);
    }
  }
}

assertCanonicalDirectFamilies();

function deduplicate(entries: AgentRouteEntry[]): AgentRouteEntry[] {
  const seen = new Set<string>();
  return entries.filter((entry) => {
    const id = entry.routerId ?? entry.agentId;
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

/**
 * Projects the canonical catalog into the LLM router for one request.
 * Runtime availability is deliberately separate from static capability existence.
 */
export function buildAvailableRouterAgents(input: {
  availability: DirectRouterAvailability;
  runtimeEntries: AgentRouteEntry[];
  configuredEntries: AgentRouteEntry[];
}): AgentRouteEntry[] {
  const directEntries = (
    Object.keys(input.availability) as Array<keyof DirectRouterAvailability>
  ).flatMap((agent) => (input.availability[agent] ? DIRECT_ROUTER_ENTRIES[agent] : []));

  // HA_AGENT_MAP is an extension point for external/legacy HA agents. Canonical
  // direct agents cannot be shadowed or accidentally enabled by environment drift.
  const externalEntries = input.configuredEntries.filter(
    (entry) =>
      !RESERVED_DIRECT_KEYS.has(entry.key ?? '') &&
      !RESERVED_DIRECT_KEYS.has(entry.routerId ?? '') &&
      !RESERVED_DIRECT_KEYS.has(entry.agentId)
  );

  return deduplicate([...input.runtimeEntries, ...directEntries, ...externalEntries]);
}
