/**
 * Deterministic Responses — Spotify
 *
 * Phrases TTS-friendly pour les actions Spotify E2.
 * Pas d'IA, variations simples pour naturalité.
 * Chaque action peut avoir plusieurs variantes (aléatoire).
 */

// ─────────────────────────────────────────────────────────────────────────────
// SPOTIFY.PAUSE
// ─────────────────────────────────────────────────────────────────────────────

export const SPOTIFY_PAUSE_RESPONSES = [
  'Musique en pause.',
  'J\'ai mis en pause.',
  'Pause.',
  'C\'est en pause.',
];

// ─────────────────────────────────────────────────────────────────────────────
// SPOTIFY.PLAY
// ─────────────────────────────────────────────────────────────────────────────

export const SPOTIFY_PLAY_RESPONSES = [
  'Musique relancée.',
  'C\'est parti.',
  'Relancé.',
  'Ça joue.',
];

// ─────────────────────────────────────────────────────────────────────────────
// SPOTIFY.NEXT
// ─────────────────────────────────────────────────────────────────────────────

export const SPOTIFY_NEXT_RESPONSES = [
  'Passage au morceau suivant.',
  'Suivant.',
  'Morceau suivant.',
  'On passe au suivant.',
];

// ─────────────────────────────────────────────────────────────────────────────
// SPOTIFY.PREVIOUS
// ─────────────────────────────────────────────────────────────────────────────

export const SPOTIFY_PREVIOUS_RESPONSES = [
  'Retour au morceau précédent.',
  'Morceau précédent.',
  'Retour.',
  'On revient en arrière.',
];

// ─────────────────────────────────────────────────────────────────────────────
// SPOTIFY.NOW_PLAYING
// ─────────────────────────────────────────────────────────────────────────────

export const SPOTIFY_NOW_PLAYING_RESPONSES = [
  'Je n\'arrive pas à dire ce qui joue pour le moment.',
  'Aucun morceau en cours.',
  'Rien ne joue actuellement.',
];

// Template pour quand on a les infos
export const SPOTIFY_NOW_PLAYING_TEMPLATE = (artist: string, track: string): string => {
  const variants = [
    `Actuellement : ${track} de ${artist}.`,
    `Ça joue : ${track} par ${artist}.`,
    `${track} de ${artist}.`,
  ];
  return variants[Math.floor(Math.random() * variants.length)];
};

// ─────────────────────────────────────────────────────────────────────────────
// SPOTIFY.LIST_DEVICES
// ─────────────────────────────────────────────────────────────────────────────

export const SPOTIFY_LIST_DEVICES_RESPONSES = [
  'Aucun appareil trouvé.',
  'Je ne vois aucun appareil disponible.',
];

export const SPOTIFY_LIST_DEVICES_TEMPLATE = (devices: string): string => {
  const variants = [
    `Appareils disponibles : ${devices}.`,
    `Je vois : ${devices}.`,
    `${devices}.`,
  ];
  return variants[Math.floor(Math.random() * variants.length)];
};

// ─────────────────────────────────────────────────────────────────────────────
// SPOTIFY.CLEAR_QUEUE
// ─────────────────────────────────────────────────────────────────────────────

export const SPOTIFY_CLEAR_QUEUE_RESPONSES = [
  'File d\'attente vidée.',
  'La file est vide.',
  'J\'ai effacé la file d\'attente.',
];

// ─────────────────────────────────────────────────────────────────────────────
// Generic Helper
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Récupère une réponse aléatoire pour une action Spotify.
 * Utilisé par E2 direct executor.
 */
export function getSpotifyResponse(action: string, params?: Record<string, string | undefined>): string {
  const randomize = (arr: string[]): string => {
    return arr.length > 0 ? arr[Math.floor(Math.random() * arr.length)] : 'Action effectuée.';
  };

  switch (action) {
    case 'pause':
      return randomize(SPOTIFY_PAUSE_RESPONSES);
    case 'play':
      return randomize(SPOTIFY_PLAY_RESPONSES);
    case 'next':
      return randomize(SPOTIFY_NEXT_RESPONSES);
    case 'previous':
      return randomize(SPOTIFY_PREVIOUS_RESPONSES);
    case 'now_playing':
      if (params?.artist && params?.track) {
        return SPOTIFY_NOW_PLAYING_TEMPLATE(params.artist, params.track);
      }
      return randomize(SPOTIFY_NOW_PLAYING_RESPONSES);
    case 'list_devices':
      if (params?.devices) {
        return SPOTIFY_LIST_DEVICES_TEMPLATE(params.devices);
      }
      return randomize(SPOTIFY_LIST_DEVICES_RESPONSES);
    case 'clear_queue':
      return randomize(SPOTIFY_CLEAR_QUEUE_RESPONSES);
    default:
      return 'Action effectuée.';
  }
}
