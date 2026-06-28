export type SpotifyResponseShape = {
  status: 'success' | 'need_clarification' | 'error';
  tts?: string;
  data?: Record<string, unknown>;
  options?: Array<Record<string, unknown>>;
  error_code?: string;
};

type SpotifyRoutingPath = 'router_direct' | 'music_planner' | 'explicit_contract';

export function inferSpotifyRoutingPath(musicPlanReason?: string): SpotifyRoutingPath {
  if (typeof musicPlanReason === 'string' && musicPlanReason.startsWith('router_direct:')) {
    return 'router_direct';
  }
  return 'music_planner';
}

export function buildSpotifyIngestPayload(input: {
  threadId: string;
  responseText: string;
  spotify: SpotifyResponseShape;
  action: string;
  routingPath: SpotifyRoutingPath;
  correlationId?: string;
  planner?: { source: 'openai_music_agent'; route: string; reason?: string };
}) {
  const replyMeta = {
    kind: 'spotify',
    source: 'spotify_executor',
    routeKey: `spotify.${input.action}`,
    ...(input.spotify.status === 'error' ? { fallbackReason: 'execution_error' } : {}),
  };

  return {
    threadId: input.threadId,
    responseText: input.responseText,
    status: input.spotify.status,
    ...(input.spotify.data ? { data: input.spotify.data } : {}),
    ...(input.spotify.options ? { options: input.spotify.options } : {}),
    ...(input.spotify.error_code ? { error_code: input.spotify.error_code } : {}),
    ...(input.correlationId ? { correlation_id: input.correlationId } : {}),
    ...(input.planner ? { planner: input.planner } : {}),
    replyMeta,
    music: {
      routing: {
        domain: 'spotify',
        path: input.routingPath,
        action: input.action,
      },
      execution: {
        status: input.spotify.status,
      },
    },
  };
}
