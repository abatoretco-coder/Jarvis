import { MUSIC_ROUTING_MATRIX } from '../spotify/musicRoutingMatrix';

export type CapabilityAgent =
  | 'spotify'
  | 'mail'
  | 'todo'
  | 'calendar'
  | 'weather'
  | 'search'
  | 'executor'
  | 'nas_status';

export type CapabilityEffect = 'read' | 'write' | 'destructive';
export type CapabilitySemanticLevel = 'E2' | 'E1' | 'none';
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

const writeOrDestructive = (effect: CapabilityEffect): boolean => effect === 'write' || effect === 'destructive';

function define(input: Omit<CapabilityDefinition, 'requiresConfirmation'> & { requiresConfirmation?: boolean }): CapabilityDefinition {
  const requiresConfirmation = input.requiresConfirmation ?? writeOrDestructive(input.effect);
  return { ...input, requiresConfirmation };
}

const spotifyCapabilities = MUSIC_ROUTING_MATRIX.map((entry) => define({
  agent: 'spotify' as const,
  action: entry.action,
  effect: 'write',
  semanticLevel: entry.semanticLevel,
  plannerRequired: entry.plannerRequiredWhenSemantic,
  responseDomain: 'spotify' as const,
  routeKey: entry.semanticRouteKey,
  requiresConfirmation: false,
}));

const coreCapabilities: CapabilityDefinition[] = [
  define({ agent: 'calendar', action: 'list_upcoming', effect: 'read', semanticLevel: 'E1', plannerRequired: true, responseDomain: 'calendar', routeKey: 'calendar.list_upcoming' }),
  define({ agent: 'calendar', action: 'search_events', effect: 'read', semanticLevel: 'E1', plannerRequired: true, responseDomain: 'calendar', routeKey: 'calendar.search_events' }),
  define({ agent: 'calendar', action: 'create_event', effect: 'write', semanticLevel: 'E1', plannerRequired: true, responseDomain: 'calendar', routeKey: 'calendar.create_event' }),
  define({ agent: 'mail', action: 'send_email', effect: 'write', semanticLevel: 'E1', plannerRequired: true, responseDomain: 'mail', routeKey: 'mail.send_email' }),
  define({ agent: 'mail', action: 'reply_email', effect: 'write', semanticLevel: 'E1', plannerRequired: true, responseDomain: 'mail', routeKey: 'mail.reply_email' }),
  define({ agent: 'mail', action: 'forward_email', effect: 'write', semanticLevel: 'E1', plannerRequired: true, responseDomain: 'mail', routeKey: 'mail.forward_email' }),
  define({ agent: 'mail', action: 'trash_email', effect: 'destructive', semanticLevel: 'E1', plannerRequired: true, responseDomain: 'mail', routeKey: 'mail.trash_email' }),
  define({ agent: 'todo', action: 'create', effect: 'write', semanticLevel: 'E1', plannerRequired: true, responseDomain: 'todo', routeKey: 'todo.add_task' }),
  define({ agent: 'todo', action: 'update', effect: 'write', semanticLevel: 'E1', plannerRequired: true, responseDomain: 'todo' }),
  define({ agent: 'todo', action: 'delete', effect: 'destructive', semanticLevel: 'E1', plannerRequired: true, responseDomain: 'todo' }),
  define({ agent: 'todo', action: 'complete', effect: 'write', semanticLevel: 'E1', plannerRequired: true, responseDomain: 'todo' }),
  define({ agent: 'weather', action: 'current', effect: 'read', semanticLevel: 'E2', plannerRequired: false, responseDomain: 'weather', routeKey: 'weather.current_temperature' }),
  define({ agent: 'search', action: 'query', effect: 'read', semanticLevel: 'E2', plannerRequired: false, responseDomain: 'search' }),
  define({ agent: 'executor', action: 'timer', effect: 'write', semanticLevel: 'E1', plannerRequired: true, responseDomain: 'executor', routeKey: 'executor.timer' }),
  define({ agent: 'nas_status', action: 'read', effect: 'read', semanticLevel: 'none', plannerRequired: false, responseDomain: 'nas_status', routeKey: 'nas.status' }),
];

export const CAPABILITY_REGISTRY: CapabilityDefinition[] = [...spotifyCapabilities, ...coreCapabilities];

export function findCapabilityByRouteKey(routeKey: string): CapabilityDefinition | undefined {
  return CAPABILITY_REGISTRY.find((capability) => capability.routeKey === routeKey);
}

export function findCapability(agent: CapabilityAgent, action: string): CapabilityDefinition | undefined {
  return CAPABILITY_REGISTRY.find((capability) => capability.agent === agent && capability.action === action);
}

export function requiresCapabilityConfirmation(capability: CapabilityDefinition): boolean {
  return capability.requiresConfirmation || writeOrDestructive(capability.effect);
}
