import { SEMANTIC_ROUTES } from '../routing/semanticRouteCatalog';

export type CapabilityAgent =
  | 'spotify'
  | 'mail'
  | 'todo'
  | 'calendar'
  | 'weather'
  | 'search'
  | 'executor'
  | 'nas_status'
  | 'culture';

export type CapabilityEffect = 'read' | 'write' | 'destructive';
export type CapabilitySemanticLevel = 'D0' | 'E2' | 'E1' | 'none';
export type CapabilityResponseDomain = CapabilityAgent | 'general';

export type CapabilityDefinition = {
  agent: CapabilityAgent;
  action: string;
  effect: CapabilityEffect;
  semanticLevel: CapabilitySemanticLevel;
  plannerRequired: boolean;
  requiresConfirmation: boolean;
  responseDomain: CapabilityResponseDomain;
  routeKey?: string;
};

const DESTRUCTIVE_ACTIONS = new Set([
  'calendar.delete_event',
  'mail.trash_email',
  'todo.delete_checklist_item',
  'todo.delete_list',
  'todo.delete_task',
]);

const READ_ACTIONS = new Set([
  'calendar.list_upcoming',
  'calendar.search_events',
  'culture.compare_candidates',
  'culture.discover',
  'culture.find_occurrences',
  'culture.find_venues',
  'culture.get_item',
  'culture.recommend_candidates',
  'executor.greeting',
  'executor.help',
  'executor.status',
  'mail.list_inbox',
  'mail.search_emails',
  'search.analysis',
  'search.comparison',
  'search.current_news',
  'search.definition',
  'search.external_weather',
  'search.history',
  'search.live_sport',
  'search.quick_lookup',
  'spotify.list_devices',
  'spotify.now_playing',
  'spotify.search',
  'todo.list_lists',
  'todo.list_tasks',
  'weather.current_conditions',
  'weather.current_humidity',
  'weather.current_precipitation',
  'weather.current_temperature',
]);

const WRITE_ACTIONS = new Set([
  'calendar.create_event',
  'calendar.remove_from_event',
  'calendar.update_event',
  'executor.climate_set',
  'executor.cover_close',
  'executor.cover_open',
  'executor.lock',
  'executor.media_next',
  'executor.media_play_pause',
  'executor.media_previous',
  'executor.mute',
  'executor.note',
  'executor.scene_set',
  'executor.timer',
  'executor.unlock',
  'executor.unmute',
  'executor.vacuum_start',
  'executor.vacuum_stop',
  'executor.volume_down',
  'executor.volume_up',
  'mail.flag_email',
  'mail.forward_email',
  'mail.mark_read',
  'mail.mark_unread',
  'mail.reply_email',
  'mail.send_email',
  'spotify.add_to_playlist',
  'spotify.clear_queue',
  'spotify.next',
  'spotify.pause',
  'spotify.play',
  'spotify.previous',
  'spotify.queue_add',
  'spotify.search_and_play',
  'spotify.transfer',
  'spotify.volume_set',
  'todo.add_checklist_item',
  'todo.add_task',
  'todo.complete_checklist_item',
  'todo.complete_task',
  'todo.create_list',
  'todo.update_task',
]);

function capabilityAgentForTarget(targetAgentId: string | undefined): CapabilityAgent {
  if (targetAgentId === 'executors') return 'executor';
  if (
    targetAgentId === 'spotify' ||
    targetAgentId === 'mail' ||
    targetAgentId === 'todo' ||
    targetAgentId === 'calendar' ||
    targetAgentId === 'weather' ||
    targetAgentId === 'search' ||
    targetAgentId === 'culture'
  ) {
    return targetAgentId;
  }
  throw new Error(`capability_catalog_unknown_target:${targetAgentId ?? 'missing'}`);
}

function effectFor(agent: CapabilityAgent, action: string): CapabilityEffect {
  const key = `${agent}.${action}`;
  if (DESTRUCTIVE_ACTIONS.has(key)) return 'destructive';
  if (WRITE_ACTIONS.has(key)) return 'write';
  if (READ_ACTIONS.has(key)) return 'read';
  throw new Error(`capability_catalog_unclassified_effect:${key}`);
}

function buildCapabilityRegistry(): CapabilityDefinition[] {
  const routeKeys = new Set<string>();
  const capabilities = SEMANTIC_ROUTES.map((route): CapabilityDefinition => {
    if (routeKeys.has(route.key)) throw new Error(`capability_catalog_duplicate_route:${route.key}`);
    routeKeys.add(route.key);
    if (!route.directRequest?.action) {
      throw new Error(`capability_catalog_missing_action:${route.key}`);
    }

    const agent = capabilityAgentForTarget(route.targetAgentId);
    const effect = effectFor(agent, route.directRequest.action);
    return {
      agent,
      action: route.directRequest.action,
      effect,
      semanticLevel: route.level,
      plannerRequired: route.plannerRequired === true,
      requiresConfirmation: agent === 'spotify' ? false : effect !== 'read',
      responseDomain: agent,
      routeKey: route.key,
    };
  });

  // NAS status is direct and non-semantic, but remains in the same exported catalog.
  capabilities.push({
    agent: 'nas_status',
    action: 'read',
    effect: 'read',
    semanticLevel: 'none',
    plannerRequired: false,
    requiresConfirmation: false,
    responseDomain: 'nas_status',
    routeKey: 'nas.status',
  });

  return capabilities;
}

/**
 * Canonical conversational capability catalog.
 *
 * Route identity and semantic metadata come from SEMANTIC_ROUTES. Every other
 * consumer projects from this registry instead of maintaining another route inventory.
 */
export const CAPABILITY_REGISTRY: CapabilityDefinition[] = buildCapabilityRegistry();

export function findCapabilityByRouteKey(routeKey: string): CapabilityDefinition | undefined {
  return CAPABILITY_REGISTRY.find((capability) => capability.routeKey === routeKey);
}

export function findCapability(
  agent: CapabilityAgent,
  action: string
): CapabilityDefinition | undefined {
  return CAPABILITY_REGISTRY.find(
    (capability) => capability.agent === agent && capability.action === action
  );
}

export function requiresCapabilityConfirmation(capability: CapabilityDefinition): boolean {
  return capability.requiresConfirmation;
}
