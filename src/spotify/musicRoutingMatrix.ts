import { spotifyActionSchema } from './contracts';

export type MusicSemanticLevel = 'E2' | 'E1' | 'none';

export type MusicRoutingMatrixEntry = {
  action: (typeof spotifyActionSchema)['options'][number];
  semanticLevel: MusicSemanticLevel;
  semanticRouteKey?: string;
  plannerRequiredWhenSemantic: boolean;
  explicitContract: boolean;
  routerDirect: boolean;
  musicPlanner: boolean;
};

export const MUSIC_ROUTING_MATRIX: MusicRoutingMatrixEntry[] = [
  {
    action: 'pause',
    semanticLevel: 'E2',
    semanticRouteKey: 'spotify.pause',
    plannerRequiredWhenSemantic: false,
    explicitContract: true,
    routerDirect: true,
    musicPlanner: false,
  },
  {
    action: 'play',
    semanticLevel: 'E2',
    semanticRouteKey: 'spotify.play',
    plannerRequiredWhenSemantic: false,
    explicitContract: true,
    routerDirect: true,
    musicPlanner: false,
  },
  {
    action: 'next',
    semanticLevel: 'E2',
    semanticRouteKey: 'spotify.next',
    plannerRequiredWhenSemantic: false,
    explicitContract: true,
    routerDirect: true,
    musicPlanner: false,
  },
  {
    action: 'previous',
    semanticLevel: 'E2',
    semanticRouteKey: 'spotify.previous',
    plannerRequiredWhenSemantic: false,
    explicitContract: true,
    routerDirect: true,
    musicPlanner: false,
  },
  {
    action: 'now_playing',
    semanticLevel: 'E2',
    semanticRouteKey: 'spotify.now_playing',
    plannerRequiredWhenSemantic: false,
    explicitContract: true,
    routerDirect: true,
    musicPlanner: false,
  },
  {
    action: 'list_devices',
    semanticLevel: 'E2',
    semanticRouteKey: 'spotify.list_devices',
    plannerRequiredWhenSemantic: false,
    explicitContract: true,
    routerDirect: true,
    musicPlanner: false,
  },
  {
    action: 'clear_queue',
    semanticLevel: 'E2',
    semanticRouteKey: 'spotify.clear_queue',
    plannerRequiredWhenSemantic: false,
    explicitContract: true,
    routerDirect: true,
    musicPlanner: false,
  },
  {
    action: 'search',
    semanticLevel: 'E1',
    semanticRouteKey: 'spotify.search',
    plannerRequiredWhenSemantic: true,
    explicitContract: true,
    routerDirect: false,
    musicPlanner: true,
  },
  {
    action: 'search_and_play',
    semanticLevel: 'E1',
    semanticRouteKey: 'spotify.search_and_play',
    plannerRequiredWhenSemantic: true,
    explicitContract: true,
    routerDirect: false,
    musicPlanner: true,
  },
  {
    action: 'queue_add',
    semanticLevel: 'E1',
    semanticRouteKey: 'spotify.queue_add',
    plannerRequiredWhenSemantic: true,
    explicitContract: true,
    routerDirect: false,
    musicPlanner: true,
  },
  {
    action: 'transfer',
    semanticLevel: 'E1',
    semanticRouteKey: 'spotify.transfer',
    plannerRequiredWhenSemantic: true,
    explicitContract: true,
    routerDirect: false,
    musicPlanner: true,
  },
  {
    action: 'add_to_playlist',
    semanticLevel: 'E1',
    semanticRouteKey: 'spotify.add_to_playlist',
    plannerRequiredWhenSemantic: true,
    explicitContract: true,
    routerDirect: false,
    musicPlanner: true,
  },
  {
    action: 'volume_set',
    semanticLevel: 'E1',
    semanticRouteKey: 'spotify.volume_set',
    plannerRequiredWhenSemantic: true,
    explicitContract: true,
    routerDirect: false,
    musicPlanner: true,
  },
  {
    action: 'like_track',
    semanticLevel: 'none',
    plannerRequiredWhenSemantic: false,
    explicitContract: true,
    routerDirect: false,
    musicPlanner: true,
  },
];
