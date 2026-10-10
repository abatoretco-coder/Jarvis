import type { UserPrincipal } from './IdentityService';

export const STREAM_DECK_CLIENT_ID = 'jarvis-streamdeck';

export function isStreamDeckPrincipal(principal: UserPrincipal | undefined): boolean {
  return principal?.clientId === STREAM_DECK_CLIENT_ID;
}

export function isStreamDeckRouteAllowed(method: string, url: string): boolean {
  const path = url.split('?')[0] ?? url;
  return (
    (method === 'GET' && (path === '/v1/music' || path === '/v1/home/lights'))
    || (method === 'POST' && (path === '/v1/music/actions' || path === '/v1/home/actions'))
  );
}

const streamDeckMusicActions = new Set(['play', 'pause', 'next', 'previous', 'volume', 'shuffle']);

export function isStreamDeckMusicActionAllowed(action: string): boolean {
  return streamDeckMusicActions.has(action);
}

export function isStreamDeckHomeActionAllowed(domain: string, action: string): boolean {
  return domain === 'light' && (action === 'turn_on' || action === 'turn_off');
}
