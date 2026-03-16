import type { SpotifyCapability } from './contracts';

export const SPOTIFY_CAPABILITY_REGISTRY_VERSION = '2026-03-04.v2';

export const SPOTIFY_CAPABILITIES: SpotifyCapability[] = [
  {
    action: 'pause',
    description: 'Pause playback on the active session.',
    required: [],
    optional: [],
    forbidden: ['slots.device'],
    examples: ['Pause la musique Spotify'],
  },
  {
    action: 'play',
    description: 'Resume playback. Use ONLY for "reprends"/"lance"/"joue" without content or device.',
    required: [],
    optional: [],
    forbidden: ['slots.device', 'slots.query', 'slots.uri', 'slots.context_uri'],
    examples: ['Relance la lecture Spotify'],
  },
  {
    action: 'next',
    description: 'Skip to next track on the active session.',
    required: [],
    optional: [],
    forbidden: ['slots.device'],
    examples: ['Piste suivante Spotify'],
  },
  {
    action: 'previous',
    description: 'Go to previous track on the active session.',
    required: [],
    optional: [],
    forbidden: ['slots.device'],
    examples: ['Piste précédente Spotify'],
  },
  {
    action: 'volume_set',
    description: 'Set volume. volume_percent=absolute (0-100), OR volume_delta=relative (signed int, e.g. +20 or -20).',
    required: ['slots.volume_percent (0-100) OR slots.volume_delta (signed int)'],
    optional: [],
    forbidden: ['slots.device'],
    examples: ['Mets le volume à 50%', 'Monte le volume', 'Baisse le son de 20', 'Volume plus', 'Volume moins'],
  },
  {
    action: 'search',
    description: 'Search without autoplay. Use when user asks to search without playing.',
    required: ['slots.query'],
    optional: [
      'slots.type ("track"|"album"|"artist"|"playlist")',
      'slots.limit',
      'understanding.entities',
    ],
    forbidden: ['slots.device'],
    examples: [
      'Recherche Spotify: query="daft punk", understanding.intent="find_best_music_options"',
      'Recherche playlist focus avec understanding.entities={mood:"focus"} et retour structuré',
    ],
  },
  {
    action: 'search_and_play',
    description: 'Search and play. Use when user names specific content.',
    required: ['slots.query (OR slots.uri OR slots.context_uri)'],
    optional: [
      'slots.uri', 'slots.track_uri', 'slots.context_uri',
      'slots.type ("track"|"album"|"artist"|"playlist")',
      'slots.display_name',
      'slots.device (alias:pc|alias:salon|alias:phone)',
      'understanding.entities',
    ],
    forbidden: [],
    examples: ['Lecture directe avec uri spotify:track:...', 'Lecture via query="Daft Punk" type="artist" entities={artist:"Daft Punk"}'],
  },
  {
    action: 'queue_add',
    description: 'Add a track to queue (tracks only; for playlist/album use search_and_play).',
    required: ['slots.query (OR slots.uri/track_uri)'],
    optional: [
      'slots.uri', 'slots.track_uri',
      'understanding.entities',
    ],
    forbidden: ['slots.type', 'slots.device'],
    examples: ['Ajoute Bohemian Rhapsody à la file', 'Ajoute spotify:track:... à la file'],
  },
  {
    action: 'clear_queue',
    description: 'Clear all manually queued tracks from the Spotify play queue.',
    required: [],
    optional: [],
    forbidden: ['slots.device'],
    examples: ['Vide la file d\'attente Spotify', 'Supprime la file d\'attente', 'Efface la queue'],
  },
  {
    action: 'transfer',
    description: 'Transfer playback to a device. Use for "mets/envoie/transfère sur X" without content.',
    required: ['slots.device (alias:pc|alias:salon|alias:phone)'],
    optional: ['slots.play (boolean)'],
    forbidden: ['slots.query', 'slots.uri', 'slots.context_uri'],
    examples: ['Bascule la musique sur le salon'],
  },
  {
    action: 'shuffle_set',
    description: 'Enable or disable shuffle mode on the active session.',
    required: ['slots.state (true|false)'],
    optional: [],
    forbidden: ['slots.device'],
    examples: ['Active le shuffle'],
  },
  {
    action: 'repeat_set',
    description: 'Set repeat mode on the active session.',
    required: ['slots.mode ("off"|"track"|"context")'],
    optional: [],
    forbidden: ['slots.device'],
    examples: ['Mets répétition piste'],
  },
  {
    action: 'seek',
    description: 'Seek to a position in the current track.',
    required: ['slots.position_ms OR slots.position_seconds (integers)'],
    optional: [],
    forbidden: ['slots.device'],
    examples: ['Avance à 1 minute 30'],
  },
  {
    action: 'like_track',
    description: 'Like/unlike the current track.',
    required: [],
    optional: [
      'slots.state (true=like, false=unlike)',
      'slots.track_id',
    ],
    forbidden: ['slots.device'],
    examples: ['Like ce morceau'],
  },
  {
    action: 'add_to_playlist',
    description: 'Add a track to a playlist.',
    required: [
      'slots.playlist_name OR slots.playlist_id',
      'slots.uris OR slots.query',
    ],
    optional: [],
    forbidden: ['slots.device'],
    examples: ['Ajoute ce titre à ma playlist Running'],
  },
  {
    action: 'list_devices',
    description: 'List available Spotify Connect devices.',
    required: [],
    optional: [],
    forbidden: ['slots.device'],
    examples: ['Liste mes appareils Spotify'],
  },
  {
    action: 'now_playing',
    description: 'Get current playback state and track info.',
    required: [],
    optional: [],
    forbidden: ['slots.device'],
    examples: ['Qu’est-ce qui joue ?'],
  },
];

const capabilitiesByAction = new Map(SPOTIFY_CAPABILITIES.map((item) => [item.action, item]));

export function getSpotifyCapability(action: string): SpotifyCapability | undefined {
  return capabilitiesByAction.get(action as SpotifyCapability['action']);
}
