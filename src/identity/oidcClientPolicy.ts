import type { UserPrincipal } from './IdentityService';

export const STREAM_DECK_CLIENT_ID = 'jarvis-streamdeck';

export function isStreamDeckPrincipal(principal: UserPrincipal | undefined): boolean {
  return principal?.clientId === STREAM_DECK_CLIENT_ID;
}

export function isStreamDeckRouteAllowed(method: string, url: string): boolean {
  const path = url.split('?')[0] ?? url;
  return (
    (method === 'GET' && (
      path === '/v1/music'
      || path === '/v1/home/lighting/rooms'
      || path === '/v1/home/stream-deck/status'
    ))
    || (method === 'PUT' && /^\/v1\/home\/lighting\/rooms\/[a-z0-9_-]+\/mode$/u.test(path))
    || (method === 'POST' && (path === '/v1/music/actions' || path === '/v1/home/actions' || path === '/v1/home/scenes/film/run'))
  );
}

const streamDeckMusicActions = new Set(['play', 'pause', 'next', 'previous', 'volume', 'transfer']);

export function isStreamDeckMusicActionAllowed(action: string): boolean {
  return streamDeckMusicActions.has(action);
}

export function isStreamDeckHomeActionAllowed(domain: string, action: string): boolean {
  return (domain === 'light' && (action === 'turn_on' || action === 'turn_off'))
    || (domain === 'media_player' && ['turn_on', 'turn_off', 'select_source', 'volume_up', 'volume_down', 'mute', 'unmute'].includes(action));
}

export function isStreamDeckSceneActionAllowed(sceneId: string, domain: string, action: string): boolean {
  if (isStreamDeckHomeActionAllowed(domain, action)) return true;
  return sceneId === 'film'
    && domain === 'switch'
    && (action === 'turn_on' || action === 'turn_off');
}
