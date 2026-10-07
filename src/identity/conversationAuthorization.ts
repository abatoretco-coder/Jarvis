import type { PermissionKey } from './IdentityRepository';

export function permissionForCapabilityAgent(agent: string | undefined): PermissionKey {
  switch (agent) {
    case 'calendar': return 'calendar';
    case 'mail': return 'mail';
    case 'todo': return 'todo';
    case 'spotify': return 'music';
    case 'executors': return 'home';
    case 'nas': return 'nas.operations';
    default: return 'chat';
  }
}

export function permissionForRouteKey(routeKey: string | undefined): PermissionKey {
  if (!routeKey) return 'chat';
  if (routeKey.startsWith('calendar.')) return 'calendar';
  if (routeKey.startsWith('mail.')) return 'mail';
  if (routeKey.startsWith('todo.')) return 'todo';
  if (routeKey.startsWith('spotify.')) return 'music';
  if (routeKey.startsWith('executor.')) return 'home';
  if (routeKey.startsWith('nas.')) return 'nas.operations';
  return 'chat';
}
