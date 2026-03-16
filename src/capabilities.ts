export const SUPPORTED_ACTIONS = [
  'spotify.pause',
  'spotify.play',
  'spotify.next',
  'spotify.previous',
  'spotify.volume_set',
  'spotify.search',
  'spotify.search_and_play',
  'spotify.queue_add',
  'spotify.transfer',
  'spotify.shuffle_set',
  'spotify.repeat_set',
  'spotify.seek',
  'spotify.like_track',
  'spotify.add_to_playlist',
  'spotify.list_devices',
  'spotify.now_playing',
] as const;

export type SupportedActionType = (typeof SUPPORTED_ACTIONS)[number];

export type Vm400Capabilities = {
  version: number;
  supportedActions: SupportedActionType[];
  integrations: {
    homeAssistant: boolean;
    spotifyWebApi: boolean;
    influx: boolean;
  };
  auth?: {
    requireApiKey: boolean;
  };
};

export function getVm400Capabilities(input: {
  haConfigured: boolean;
  spotifyWebApiConfigured: boolean;
  influxEnabled: boolean;
  requireApiKey?: boolean;
}): Vm400Capabilities {
  const spotifyWebApiActions = new Set<SupportedActionType>([
    // HA-decides contract: these delegated spotify actions remain available
    // only when Spotify Web API is configured.
    'spotify.pause',
    'spotify.play',
    'spotify.next',
    'spotify.previous',
    'spotify.volume_set',
    'spotify.search',
    'spotify.search_and_play',
    'spotify.queue_add',
    'spotify.transfer',
    'spotify.shuffle_set',
    'spotify.repeat_set',
    'spotify.seek',
    'spotify.like_track',
    'spotify.add_to_playlist',
    'spotify.list_devices',
    'spotify.now_playing',
  ]);

  const supportedActions = SUPPORTED_ACTIONS.filter((t) => {
    if (!input.spotifyWebApiConfigured && spotifyWebApiActions.has(t)) return false;
    return true;
  });

  return {
    version: 1,
    supportedActions,
    integrations: {
      homeAssistant: input.haConfigured,
      spotifyWebApi: input.spotifyWebApiConfigured,
      influx: input.influxEnabled,
    },
    ...(typeof input.requireApiKey === 'boolean'
      ? { auth: { requireApiKey: input.requireApiKey } }
      : {}),
  };
}
