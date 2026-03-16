import type { SpotifyWebApiClient } from '../spotifyWebApi';
import { getSpotifyCapability, SPOTIFY_CAPABILITY_REGISTRY_VERSION } from './capabilityRegistry';
import type { IngestSpotifyRequest, JarvisSpotifyResponse } from './contracts';

type LoggerLike = {
  info?: (obj: Record<string, unknown>, msg?: string) => void;
  warn?: (obj: Record<string, unknown>, msg?: string) => void;
};

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function slotString(slots: Record<string, unknown>, key: string): string | undefined {
  const value = slots[key];
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  return normalized || undefined;
}

function slotBoolean(slots: Record<string, unknown>, key: string): boolean | undefined {
  const value = slots[key];
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true' || normalized === 'on' || normalized === '1') return true;
    if (normalized === 'false' || normalized === 'off' || normalized === '0') return false;
  }
  return undefined;
}

function slotNumber(slots: Record<string, unknown>, key: string): number | undefined {
  const value = slots[key];
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function normalizeSearchType(input?: string): 'track' | 'album' | 'playlist' | 'artist' | 'show' | 'episode' | undefined {
  const value = String(input ?? '').trim().toLowerCase();
  if (!value) return undefined;
  if (value === 'track' || value === 'title' || value === 'song' || value === 'titre') return 'track';
  if (value === 'playlist' || value === 'play_list' || value === 'liste') return 'playlist';
  if (value === 'album') return 'album';
  if (value === 'artist' || value === 'artiste') return 'artist';
  if (value === 'show') return 'show';
  if (value === 'episode') return 'episode';
  return undefined;
}

function resolveSearchAndPlayType(input: {
  requestedType?: 'track' | 'album' | 'playlist' | 'artist' | 'show' | 'episode';
  query?: string;
  text?: string;
  entities?: Record<string, unknown>;
}): 'track' | 'album' | 'playlist' | 'artist' | 'show' | 'episode' {
  const requested = input.requestedType;
  const query = String(input.query ?? '').toLowerCase();
  const text = String(input.text ?? '').toLowerCase();
  const entities = input.entities ?? {};

  const hasPlaylistSignal = /\b(playlist|play\s*list|likes?|titres\s+likes?|favoris)\b/.test(`${query} ${text}`)
    || typeof entities.playlist === 'string'
    || typeof entities.playlist_name === 'string';
  if (hasPlaylistSignal) return 'playlist';

  const hasArtistEntity = typeof entities.artist === 'string' || typeof entities.artist_name === 'string';
  const hasTrackEntity = typeof entities.track === 'string' || typeof entities.title === 'string';
  if ((requested === 'track' || !requested) && hasArtistEntity && !hasTrackEntity) {
    return 'artist';
  }

  return requested ?? 'track';
}

function normalizeForMatch(input: string): string {
  return String(input ?? '')
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function tokenize(input: string): string[] {
  const normalized = normalizeForMatch(input);
  if (!normalized) return [];
  return normalized.split(/\s+/).filter((token) => token.length >= 2);
}

function nameMatchScore(candidateName: string, requestedName: string): number {
  const candidate = normalizeForMatch(candidateName);
  const requested = normalizeForMatch(requestedName);
  if (!candidate || !requested) return 0;
  if (candidate === requested) return 1000;
  if (candidate.startsWith(requested)) return 900;
  if (requested.startsWith(candidate)) return 850;
  if (candidate.includes(requested) || requested.includes(candidate)) return 800;

  const requestedTokens = tokenize(requested);
  if (!requestedTokens.length) return 0;

  const candidateSet = new Set(tokenize(candidate));
  const overlap = requestedTokens.filter((token) => candidateSet.has(token)).length;
  if (!overlap) return 0;

  const ratio = overlap / requestedTokens.length;
  if (ratio < 0.5) return 0;
  return Math.round(ratio * 700);
}

function candidateNameFromType(entities: Record<string, unknown>, type: string): string | undefined {
  if (type === 'artist') return slotString(entities, 'artist') ?? slotString(entities, 'artist_name');
  if (type === 'album') return slotString(entities, 'album') ?? slotString(entities, 'album_name');
  if (type === 'playlist') return slotString(entities, 'playlist') ?? slotString(entities, 'playlist_name');
  if (type === 'track') return slotString(entities, 'track') ?? slotString(entities, 'title');
  return undefined;
}

function normalizeCatalogOptions(type: string, items: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  return items
    .map((item) => {
      const uri = slotString(item, 'uri');
      const name = slotString(item, 'name');
      if (!uri || !name) return undefined;
      const url = spotifyUriToUrl(uri);
      return {
        type,
        id: slotString(item, 'id') ?? undefined,
        name,
        uri,
        ...(url ? { url } : {}),
      } as Record<string, unknown>;
    })
    .filter((item): item is Record<string, unknown> => Boolean(item));
}

function rankCatalogOptions(input: {
  options: Array<Record<string, unknown>>;
  query: string;
  type: string;
  assistantUnderstanding?: Record<string, unknown>;
}): Array<{ option: Record<string, unknown>; score: number }> {
  const { options, query, type, assistantUnderstanding } = input;
  const entities = asRecord(assistantUnderstanding?.entities) ?? {};
  const hintedName = candidateNameFromType(entities, type);

  return options
    .map((option) => {
      const optionName = slotString(option, 'name') ?? '';
      const byQuery = nameMatchScore(optionName, query);
      const byHint = hintedName ? nameMatchScore(optionName, hintedName) : 0;
      const score = Math.max(byQuery, byHint > 0 ? byHint + 120 : 0);
      return { option, score };
    })
    .sort((left, right) => right.score - left.score);
}

function shouldAutoselectRankedCandidates(ranked: Array<{ option: Record<string, unknown>; score: number }>): boolean {
  if (!ranked.length) return false;
  const top = ranked[0]?.score ?? 0;
  const second = ranked[1]?.score ?? 0;
  if (top >= 1000) return true;
  if (top >= 900 && top - second >= 120) return true;
  if (top >= 850 && ranked.length === 1) return true;
  return false;
}

function spotifyUriToUrl(uri: string): string | undefined {
  const normalized = String(uri ?? '').trim();
  const match = normalized.match(/^spotify:(track|album|artist|playlist|show|episode):([a-zA-Z0-9]+)$/);
  if (!match) return undefined;
  return `https://open.spotify.com/${match[1]}/${match[2]}`;
}

function toErrorResponse(errorCode: string, tts: string, details?: Record<string, unknown>): JarvisSpotifyResponse {
  return {
    status: 'error',
    error_code: errorCode,
    tts,
    ...(details ? { data: details } : {}),
  };
}

function normalizeDeviceSlot(slots: Record<string, unknown>): string | undefined {
  const device = slotString(slots, 'device') ?? slotString(slots, 'device_id');
  if (!device) return undefined;
  if (device.startsWith('alias:')) return device;
  return `alias:${device}`;
}

function inferDeviceAliasFromRequest(input: {
  slots: Record<string, unknown>;
  text?: string;
  understanding?: Record<string, unknown>;
}): string | undefined {
  const explicit = normalizeDeviceSlot(input.slots);
  if (explicit) return explicit;

  const entities = asRecord(input.understanding?.entities) ?? {};
  const entityDevice = slotString(entities, 'device') ?? slotString(entities, 'target_device') ?? slotString(entities, 'location');
  if (entityDevice) {
    const normalized = normalizeForMatch(entityDevice);
    if (/(^|\s)(pc|ordi|ordinateur|computer|jarvis|vm400)(\s|$)/.test(normalized)) return 'alias:pc';
    if (/(^|\s)(tel|telephone|mobile|phone)(\s|$)/.test(normalized)) return 'alias:phone';
    if (/(^|\s)(salon|living room|livingroom|enceinte)(\s|$)/.test(normalized)) return 'alias:salon';
  }

  const text = normalizeForMatch(input.text ?? '');
  if (!text) return undefined;
  if (/(^|\s)(sur|vers|to|on)\s+(le\s+|la\s+|mon\s+|ma\s+)?(pc|ordi|ordinateur|computer|jarvis|vm400)(\s|$)/.test(text)) {
    return 'alias:pc';
  }
  if (/(^|\s)(sur|vers|to|on)\s+(le\s+|la\s+|mon\s+|ma\s+)?(tel|telephone|mobile|phone)(\s|$)/.test(text)) {
    return 'alias:phone';
  }
  if (/(^|\s)(sur|vers|to|on)\s+(le\s+|la\s+|mon\s+|ma\s+)?(salon|enceinte|living room|livingroom)(\s|$)/.test(text)) {
    return 'alias:salon';
  }
  return undefined;
}

function buildSearchQuery(input: {
  slots: Record<string, unknown>;
  type: 'track' | 'album' | 'playlist' | 'artist' | 'show' | 'episode';
  entities: Record<string, unknown>;
}): string | undefined {
  const { slots, type, entities } = input;
  const direct = slotString(slots, 'query') ?? slotString(slots, 'text');
  if (direct) return direct;

  if (type === 'track') {
    const track = slotString(entities, 'track') ?? slotString(entities, 'title');
    const artist = slotString(entities, 'artist') ?? slotString(entities, 'artist_name');
    return [track, artist].filter((value): value is string => Boolean(value && value.trim())).join(' ') || undefined;
  }

  if (type === 'artist') return slotString(entities, 'artist') ?? slotString(entities, 'artist_name');
  if (type === 'album') {
    const album = slotString(entities, 'album') ?? slotString(entities, 'album_name');
    const artist = slotString(entities, 'artist') ?? slotString(entities, 'artist_name');
    return [album, artist].filter((value): value is string => Boolean(value && value.trim())).join(' ') || undefined;
  }
  if (type === 'playlist') return slotString(entities, 'playlist') ?? slotString(entities, 'playlist_name');

  return undefined;
}

function isPersonalPlaylistIntent(input: {
  query?: string;
  text?: string;
  entities?: Record<string, unknown>;
}): boolean {
  const q = normalizeForMatch(input.query ?? '');
  const t = normalizeForMatch(input.text ?? '');
  const playlistEntity = normalizeForMatch(
    slotString(input.entities ?? {}, 'playlist')
      ?? slotString(input.entities ?? {}, 'playlist_name')
      ?? ''
  );

  const combined = [q, t, playlistEntity].filter((value) => value.length > 0).join(' ');
  if (!combined) return false;
  return /(^|\s)(ma|mes|moi|my)(\s|$)/.test(combined);
}

function isNowPlayingActive(data: Record<string, unknown>): boolean {
  return data.is_playing === true;
}

type PlaybackSnapshot = {
  isPlaying?: boolean;
  deviceId?: string;
  deviceName?: string;
  volumePercent?: number;
};

function toPlaybackSnapshot(data: Record<string, unknown>): PlaybackSnapshot {
  const device = asRecord(data.device);
  const volumeRaw = device?.volume_percent;
  const volumePercent = typeof volumeRaw === 'number' && Number.isFinite(volumeRaw)
    ? Math.max(0, Math.min(100, Math.round(volumeRaw)))
    : undefined;

  return {
    isPlaying: data.is_playing === true ? true : data.is_playing === false ? false : undefined,
    deviceId: typeof device?.id === 'string' ? device.id.trim() || undefined : undefined,
    deviceName: typeof device?.name === 'string' ? device.name.trim() || undefined : undefined,
    volumePercent,
  };
}

function normalizeDeviceNeedle(value?: string): string {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  const withoutAlias = raw.toLowerCase().startsWith('alias:') ? raw.slice('alias:'.length) : raw;
  return normalizeForMatch(withoutAlias);
}

function matchesDeviceNeedle(device: { id?: string; name?: string }, needle?: string): boolean {
  const n = normalizeDeviceNeedle(needle);
  if (!n) return false;
  const idNorm = normalizeForMatch(device.id ?? '');
  if (idNorm && idNorm === n) return true;
  const nameNorm = normalizeForMatch(device.name ?? '');
  if (!nameNorm) return false;
  return nameNorm === n || nameNorm.includes(n) || n.includes(nameNorm);
}

const READONLY_SPOTIFY_ACTIONS = new Set(['list_devices', 'now_playing', 'search']);

export async function executeSpotifyCapability(input: {
  request: IngestSpotifyRequest;
  spotifyWebApi: SpotifyWebApiClient;
  log?: LoggerLike;
}): Promise<JarvisSpotifyResponse> {
  const result = await _executeSpotifyCapability(input);
  if (!READONLY_SPOTIFY_ACTIONS.has(input.request.action) && result.status !== 'error') {
    input.spotifyWebApi.scheduleSituationRefresh(600);
  }
  return result;
}

async function _executeSpotifyCapability(input: {
  request: IngestSpotifyRequest;
  spotifyWebApi: SpotifyWebApiClient;
  log?: LoggerLike;
}): Promise<JarvisSpotifyResponse> {
  const { request, spotifyWebApi, log } = input;
  const capability = getSpotifyCapability(request.action);

  if (!capability) {
    return toErrorResponse('unsupported_action', `Action Spotify non supportée: ${request.action}.`, {
      registry_version: SPOTIFY_CAPABILITY_REGISTRY_VERSION,
    });
  }

  if (!spotifyWebApi.isConfigured()) {
    return toErrorResponse(
      'spotify_webapi_not_configured',
      'Spotify Web API n’est pas configuré sur VM400.',
      { action: request.action }
    );
  }

  const slots = request.slots ?? {};
  const assistantUnderstanding = asRecord(request.understanding) ?? {};
  const deviceId = inferDeviceAliasFromRequest({
    slots,
    text: request.text,
    understanding: assistantUnderstanding,
  });
  const requestContext = asRecord(request.context) ?? {};

  log?.info?.(
    {
      correlation_id: request.correlation_id,
      threadId: request.threadId,
      action: request.action,
      user_id: request.user_id,
      payload_version: slotString(requestContext, 'payload_version') ?? slotString(slots, 'payload_version'),
    },
    'spotify_capability_execute_start'
  );

  if (request.action === 'list_devices') {
    const result = await spotifyWebApi.listDevicesPublic();
    if (!result.ok) {
      return toErrorResponse(result.error, 'Impossible d\'interroger les appareils Spotify pour l\'instant.', {
        status: result.status,
      });
    }
    return {
      status: 'success',
      tts: `${result.devices.length} appareil(s) Spotify détecté(s). Je me permets de vous tenir informé.`,
      data: {
        devices: result.devices,
        registry_version: SPOTIFY_CAPABILITY_REGISTRY_VERSION,
      },
    };
  }

  if (request.action === 'now_playing') {
    const result = await spotifyWebApi.getNowPlaying();
    if (!result.ok) {
      return toErrorResponse(result.error, 'Rien en cours sur Spotify.', { status: result.status });
    }
    const item = result.data.item;
    const itemRecord = item && typeof item === 'object' && !Array.isArray(item)
      ? (item as Record<string, unknown>)
      : undefined;
    const title = typeof itemRecord?.name === 'string' ? itemRecord.name : 'un titre inconnu';
    return {
      status: 'success',
      tts: `En cours : ${title}. Je supposais que vous le saviez.`,
      data: {
        now_playing: result.data,
        registry_version: SPOTIFY_CAPABILITY_REGISTRY_VERSION,
      },
    };
  }

  if (request.action === 'pause') {
    const now = await spotifyWebApi.getNowPlaying();
    if (now.ok && !isNowPlayingActive(now.data)) {
      return {
        status: 'success',
        tts: 'Déjà en pause. Je m\'abstiens de mentionner que c\'était évident.',
        data: {
          no_op: true,
          reason: 'already_paused',
          registry_version: SPOTIFY_CAPABILITY_REGISTRY_VERSION,
        },
      };
    }
    if (!now.ok && now.status === 204) {
      return {
        status: 'success',
        tts: 'Rien ne joue actuellement. Il fallait peut-être le vérifier d\'abord.',
        data: {
          no_op: true,
          reason: 'no_active_playback',
          registry_version: SPOTIFY_CAPABILITY_REGISTRY_VERSION,
        },
      };
    }

    const paused = await spotifyWebApi.pause(deviceId);
    if (!paused.ok) {
      return toErrorResponse(paused.error, 'Impossible de mettre en pause.', { status: paused.status });
    }
    return { status: 'success', tts: 'Mis en pause. À votre service, comme toujours.', data: { registry_version: SPOTIFY_CAPABILITY_REGISTRY_VERSION } };
  }

  if (request.action === 'play') {
    // Si aucun device explicite, on récupère le device du now_playing (même en pause) pour le cibler.
    let targetDevice = deviceId;
    if (!targetDevice) {
      const now = await spotifyWebApi.getNowPlaying();
      if (now.ok) {
        const snapshot = toPlaybackSnapshot(now.data);
        targetDevice = snapshot.deviceId;
      }
    }

    const played = await spotifyWebApi.play(targetDevice);
    if (!played.ok) {
      const tts = played.error === 'spotify_device_not_available'
        ? (targetDevice
          ? 'Spotify n\'est pas ouvert sur cet appareil. Lancez l\'application d\'abord.'
          : 'Aucun appareil Spotify actif. Ouvrez Spotify sur un appareil pour reprendre.')
        : 'Impossible de relancer la lecture.';
      return toErrorResponse(played.error, tts, { status: played.status });
    }
    return { status: 'success', tts: 'Lecture reprise. Je présume que vous saviez ce que vous faisiez.', data: { registry_version: SPOTIFY_CAPABILITY_REGISTRY_VERSION } };
  }

  if (request.action === 'next') {
    const skipped = await spotifyWebApi.next(deviceId);
    if (!skipped.ok) {
      return toErrorResponse(skipped.error, 'Impossible de passer à la piste suivante.', { status: skipped.status });
    }
    return { status: 'success', tts: 'Piste suivante. Espérons que celle-ci vous convienne davantage.', data: { registry_version: SPOTIFY_CAPABILITY_REGISTRY_VERSION } };
  }

  if (request.action === 'previous') {
    const previous = await spotifyWebApi.previous(deviceId);
    if (!previous.ok) {
      return toErrorResponse(previous.error, 'Impossible de revenir en arrière.', { status: previous.status });
    }
    return { status: 'success', tts: 'Retour en arrière. Je m\'abstiens de tout commentaire.', data: { registry_version: SPOTIFY_CAPABILITY_REGISTRY_VERSION } };
  }

  if (request.action === 'volume_set') {
    const volumePercent = slotNumber(slots, 'volume_percent') ?? slotNumber(slots, 'volume') ?? slotNumber(slots, 'percent');
    const volumeDelta = slotNumber(slots, 'volume_delta') ?? slotNumber(slots, 'delta');
    const hasAbsolute = typeof volumePercent === 'number' && Number.isFinite(volumePercent);
    const hasDelta = typeof volumeDelta === 'number' && Number.isFinite(volumeDelta);

    if (!hasAbsolute && !hasDelta) {
      return toErrorResponse('missing_volume', 'Précisez le niveau souhaité, ou indiquez dans quel sens changer le volume.');
    }

    let targetVolume: number;

    let deltaSnapshot: ReturnType<typeof toPlaybackSnapshot> | undefined;
    if (hasAbsolute && !hasDelta) {
      targetVolume = Math.max(0, Math.min(100, Math.round(volumePercent!)));
    } else {
      // Delta relatif : on a besoin du volume actuel
      const now = await spotifyWebApi.getNowPlaying();
      if (!now.ok) {
        return toErrorResponse('spotify_no_active_playback', 'Rien ne joue en ce moment — impossible d\'ajuster le volume.');
      }
      deltaSnapshot = toPlaybackSnapshot(now.data);
      const currentVolume = typeof deltaSnapshot.volumePercent === 'number' ? deltaSnapshot.volumePercent : 50;
      const delta = hasDelta ? volumeDelta! : 0;
      const absolute = hasAbsolute ? volumePercent! : undefined;
      // Si on a les deux (cas mixte), l'absolu prend le dessus après application du delta
      targetVolume = Math.max(0, Math.min(100, Math.round(
        absolute !== undefined ? absolute : currentVolume + delta
      )));
    }

    // Reuse the snapshot from the delta fetch when available; otherwise fetch once for no-op check.
    const nowSnapshot = deltaSnapshot ?? (await spotifyWebApi.getNowPlaying().then((r) => r.ok ? toPlaybackSnapshot(r.data) : undefined));
    if (nowSnapshot) {
      if (typeof nowSnapshot.volumePercent === 'number' && nowSnapshot.volumePercent === targetVolume) {
        return {
          status: 'success',
          tts: `Le volume est déjà à ${targetVolume}%. Bonne observation.`,
          data: {
            no_op: true,
            reason: 'already_at_volume',
            volume_percent: targetVolume,
            registry_version: SPOTIFY_CAPABILITY_REGISTRY_VERSION,
          },
        };
      }
    }

    const volumeSet = await spotifyWebApi.setVolume(targetVolume, deviceId);
    if (!volumeSet.ok) {
      return toErrorResponse(volumeSet.error, 'Impossible de modifier le volume.', { status: volumeSet.status });
    }
    return {
      status: 'success',
      tts: `Volume réglé à ${targetVolume}%. Considérez-le fait.`,
      data: { volume_percent: targetVolume, registry_version: SPOTIFY_CAPABILITY_REGISTRY_VERSION },
    };
  }

  if (request.action === 'search') {
    const query = slotString(slots, 'query') ?? slotString(slots, 'text') ?? request.text?.trim();
    const requestedType = normalizeSearchType(slotString(slots, 'type'));
    const limit = Math.max(1, Math.min(8, Math.round(slotNumber(slots, 'limit') ?? 5)));

    if (!query) {
      return {
        status: 'need_clarification',
        tts: 'Je dois savoir quoi chercher. Les miracles ont des limites.',
        error_code: 'missing_query',
        data: { registry_version: SPOTIFY_CAPABILITY_REGISTRY_VERSION },
      };
    }

    const searchTypes: Array<'track' | 'album' | 'playlist' | 'artist' | 'show' | 'episode'> = requestedType
      ? [requestedType]
      : ['track', 'artist', 'playlist', 'album'];

    const groupedResults: Record<string, Array<Record<string, unknown>>> = {};

    for (const type of searchTypes) {
      const searched = await spotifyWebApi.searchCatalog(type, query, limit);
      if (!searched.ok) {
        if (searchTypes.length === 1) {
          return toErrorResponse(searched.error, `Recherche Spotify impossible pour ${query}.`, { status: searched.status });
        }
        continue;
      }

      const normalizedItems = searched.items
        .map((item) => {
          const uri = slotString(item, 'uri');
          const name = slotString(item, 'name');
          if (!uri || !name) return undefined;
          const url = spotifyUriToUrl(uri);
          return {
            type,
            id: slotString(item, 'id') ?? undefined,
            name,
            uri,
            ...(url ? { url } : {}),
          } as Record<string, unknown>;
        })
        .filter((item): item is Record<string, unknown> => Boolean(item));

      if (type === 'track' && normalizedItems.length > 1) {
        const entities = asRecord(assistantUnderstanding.entities) ?? {};
        const hintedArtist = slotString(entities, 'artist') ?? slotString(entities, 'artist_name');
        const bestTrack = await spotifyWebApi.searchTopTrackUri(query, hintedArtist);
        if (bestTrack.ok) {
          normalizedItems.sort((left, right) => {
            const leftUri = slotString(left, 'uri');
            const rightUri = slotString(right, 'uri');
            if (leftUri === bestTrack.uri && rightUri !== bestTrack.uri) return -1;
            if (rightUri === bestTrack.uri && leftUri !== bestTrack.uri) return 1;
            return 0;
          });
        }
      }

      if (normalizedItems.length) groupedResults[type] = normalizedItems;
    }

    const flatItems = Object.values(groupedResults).flat();
    const byTypeCounts = Object.entries(groupedResults).reduce<Record<string, number>>((acc, [type, items]) => {
      acc[type] = Array.isArray(items) ? items.length : 0;
      return acc;
    }, {});

    if (!flatItems.length) {
      return {
        status: 'need_clarification',
        tts: `Aucun résultat Spotify pour "${query}". Ce n’est pas faute d’avoir essayé.`,
        error_code: 'spotify_search_no_results',
        data: {
          query,
          type: requestedType ?? 'auto',
          result_summary: {
            total: 0,
            by_type: byTypeCounts,
          },
          registry_version: SPOTIFY_CAPABILITY_REGISTRY_VERSION,
        },
      };
    }

    const first = flatItems[0];
    const firstName = slotString(first, 'name') ?? query;
    const firstUrl = slotString(first, 'url');

    return {
      status: 'success',
      tts: firstUrl
        ? `${flatItems.length} résultat(s) — premier : ${firstName}. Je vous laisse la main.`
        : `${flatItems.length} résultat(s) pour "${query}". Je vous laisse la main.`,
      data: {
        query,
        type: requestedType ?? 'auto',
        total: flatItems.length,
        result_summary: {
          total: flatItems.length,
          by_type: byTypeCounts,
          top_name: firstName,
          top_type: slotString(first, 'type') ?? requestedType ?? 'unknown',
          ...(firstUrl ? { top_url: firstUrl } : {}),
        },
        grouped: groupedResults,
        top: first,
        top_url: firstUrl,
        registry_version: SPOTIFY_CAPABILITY_REGISTRY_VERSION,
      },
      options: flatItems.slice(0, 5),
    };
  }

  if (request.action === 'transfer') {
    const playAfterTransfer = slotBoolean(slots, 'play') ?? true;
    const now = await spotifyWebApi.getNowPlaying();

    // Rien en cours de lecture : si un device cible est précisé, on démarre directement dessus
    if (!now.ok && deviceId) {
      const played = await spotifyWebApi.play(deviceId);
      if (!played.ok) {
        const tts = played.error === 'spotify_device_not_available'
          ? 'Spotify n\'est pas ouvert sur cet appareil. Lancez l\'application d\'abord.'
          : 'Impossible de démarrer la lecture sur cet appareil.';
        return toErrorResponse(played.error, tts, { status: played.status });
      }
      return { status: 'success', tts: 'Lecture lancée sur cet appareil. Enfin.', data: { registry_version: SPOTIFY_CAPABILITY_REGISTRY_VERSION } };
    }

    if (now.ok) {
      const snapshot = toPlaybackSnapshot(now.data);
      let requestedMatchesCurrent = false;

      if (!deviceId) {
        requestedMatchesCurrent = Boolean(snapshot.deviceId || snapshot.deviceName);
      } else {
        if (matchesDeviceNeedle({ id: snapshot.deviceId, name: snapshot.deviceName }, deviceId)) {
          requestedMatchesCurrent = true;
        } else {
          const devices = await spotifyWebApi.listDevicesPublic();
          if (devices.ok && snapshot.deviceId) {
            const matched = devices.devices.find((device) => matchesDeviceNeedle({ id: device.id, name: device.name }, deviceId));
            requestedMatchesCurrent = Boolean(matched && matched.id === snapshot.deviceId);
          }
        }
      }

      if (requestedMatchesCurrent) {
        if (playAfterTransfer && snapshot.isPlaying === false) {
          const resumed = await spotifyWebApi.play(deviceId);
          if (!resumed.ok) {
            return toErrorResponse(resumed.error, 'Impossible de relancer Spotify sur cet appareil.', {
              status: resumed.status,
            });
          }
          return {
            status: 'success',
            tts: 'Lecture reprise sur cet appareil. Comme demandé.',
            data: { resumed: true, registry_version: SPOTIFY_CAPABILITY_REGISTRY_VERSION },
          };
        }

        return {
          status: 'success',
          tts: 'La lecture est déjà sur cet appareil. Je l\'avais remarqué.',
          data: {
            no_op: true,
            reason: 'already_on_target_device',
            registry_version: SPOTIFY_CAPABILITY_REGISTRY_VERSION,
          },
        };
      }
    }

    const transfer = await spotifyWebApi.transferPlayback(deviceId, playAfterTransfer);
    if (!transfer.ok) {
      const tts = transfer.error === 'spotify_device_not_available'
        ? 'Spotify n\'est pas ouvert sur cet appareil. Lancez l\'application d\'abord.'
        : 'Impossible de transférer la lecture vers cet appareil.';
      return toErrorResponse(transfer.error, tts, { status: transfer.status });
    }
    return { status: 'success', tts: 'Lecture transférée. Je vous laisse apprécier.', data: { registry_version: SPOTIFY_CAPABILITY_REGISTRY_VERSION } };
  }

  if (request.action === 'queue_add') {
    const entities = asRecord(assistantUnderstanding.entities) ?? {};
    const type = normalizeSearchType(slotString(slots, 'type')) ?? 'track';
    const hintedArtist = slotString(entities, 'artist') ?? slotString(entities, 'artist_name');

    let targetTrackUri = slotString(slots, 'uri') ?? slotString(slots, 'track_uri') ?? '';

    if (!targetTrackUri) {
      const query = buildSearchQuery({ slots, type, entities });
      if (!query) {
        return {
          status: 'need_clarification',
          tts: 'Précisez le titre à ajouter à la file. Je ne devine pas — enfin, pas encore.',
          error_code: 'missing_query',
          data: {
            expected_slots: ['uri|track_uri', 'query', 'type'],
            accepted_uri_format: 'spotify:track:<id>',
            registry_version: SPOTIFY_CAPABILITY_REGISTRY_VERSION,
          },
        };
      }

      if (type === 'track') {
        const uri = await spotifyWebApi.searchTopTrackUri(query, hintedArtist);
        if (!uri.ok) {
          return toErrorResponse(uri.error, `Je n’ai pas trouvé de résultat unique pour ${query}.`, {
            options: Array.isArray((uri.details as Record<string, unknown> | undefined)?.candidates)
              ? ((uri.details as Record<string, unknown>).candidates as Array<Record<string, unknown>>).slice(0, 5)
              : undefined,
          });
        }
        targetTrackUri = uri.uri;
      } else {
        const searched = await spotifyWebApi.searchCatalog(type, query, 5);
        if (!searched.ok) {
          return toErrorResponse(searched.error, `Recherche Spotify impossible pour ${query}.`, { status: searched.status });
        }

        const options = normalizeCatalogOptions(type, searched.items);
        if (!options.length) {
          return toErrorResponse('spotify_search_no_results', `Je n’ai trouvé aucun résultat Spotify pour ${query}.`);
        }

        const ranked = rankCatalogOptions({ options, query, type, assistantUnderstanding });
        const top = ranked[0]?.option;
        if (!top || !shouldAutoselectRankedCandidates(ranked)) {
          return {
            status: 'need_clarification',
            tts: `Plusieurs résultats pour "${query}". Soyez plus précis, je vous prie.`,
            options: options.slice(0, 5),
            error_code: 'ambiguous_search',
          };
        }

        const contextUri = slotString(top, 'uri');
        if (!contextUri) return toErrorResponse('spotify_missing_uri', 'Je ne trouve pas d’URI Spotify valide.');

        const resolved = await spotifyWebApi.getFirstTrackUriFromContext(contextUri, hintedArtist);
        if (!resolved.ok) {
          return toErrorResponse(resolved.error, `Je ne peux pas déterminer un titre à ajouter depuis ${slotString(top, 'name') ?? query}.`, {
            status: resolved.status,
          });
        }
        targetTrackUri = resolved.uri;
      }
    }

    if (!targetTrackUri.startsWith('spotify:track:')) {
      return toErrorResponse('invalid_track_uri', 'URI de piste invalide pour la file Spotify.', {
        uri: targetTrackUri,
      });
    }

    const queued = await spotifyWebApi.addToQueueUri(targetTrackUri, deviceId);
    if (!queued.ok) return toErrorResponse(queued.error, 'Impossible d’ajouter ce titre à la file Spotify.', { status: queued.status });
    return {
      status: 'success',
      tts: 'Titre ajouté à la file d\'attente. Il attendra sagement.',
      data: { uri: targetTrackUri, registry_version: SPOTIFY_CAPABILITY_REGISTRY_VERSION },
    };
  }

  if (request.action === 'like_track') {
    const state = slotBoolean(slots, 'state') ?? true;
    const trackId = slotString(slots, 'track_id');
    const acted = state
      ? await spotifyWebApi.likeTrack(trackId)
      : await spotifyWebApi.unlikeTrack(trackId);
    if (!acted.ok) return toErrorResponse(acted.error, 'Impossible de modifier vos favoris Spotify.', { status: acted.status });
    return {
      status: 'success',
      tts: state ? 'Ajouté à vos favoris. Votre goût musical reste entre nous.' : 'Retiré de vos favoris. Je ne juge pas.',
      data: { track_id: trackId, state, registry_version: SPOTIFY_CAPABILITY_REGISTRY_VERSION },
    };
  }

  if (request.action === 'add_to_playlist') {
    const playlistId = slotString(slots, 'playlist_id');
    const playlistName = slotString(slots, 'playlist_name');
    const urisRaw = slots.uris;
    const uris = Array.isArray(urisRaw) ? urisRaw.filter((item): item is string => typeof item === 'string') : [];

    let targetPlaylistId = playlistId;
    if (!targetPlaylistId && playlistName) {
      const playlist = await spotifyWebApi.searchUserPlaylistContextUri(playlistName);
      if (playlist.ok) {
        targetPlaylistId = playlist.uri.replace('spotify:playlist:', '');
      }
    }

    if (!targetPlaylistId) {
      return {
        status: 'need_clarification',
        tts: 'Précisez dans quelle playlist ajouter ce titre. Je ne travaille pas à l\'aveugle.',
        error_code: 'missing_playlist',
      };
    }

    let candidateUris = uris;
    if (!candidateUris.length) {
      const query = slotString(slots, 'query');
      if (!query) {
        return {
          status: 'need_clarification',
          tts: 'Quel titre voulez-vous ajouter à cette playlist ? Je suis là — j\'attends.',
          error_code: 'missing_track_query',
        };
      }
      const track = await spotifyWebApi.searchTopTrackUri(query);
      if (!track.ok) {
        return {
          status: 'need_clarification',
          tts: `Plusieurs résultats pour "${query}". Soyez plus précis, je vous prie.`,
          options: Array.isArray((track.details as Record<string, unknown> | undefined)?.candidates)
            ? ((track.details as Record<string, unknown>).candidates as Array<Record<string, unknown>>).slice(0, 5)
            : undefined,
          error_code: track.error,
        };
      }
      candidateUris = [track.uri];
    }

    const added = await spotifyWebApi.addUrisToPlaylist(targetPlaylistId, candidateUris);
    if (!added.ok) {
      return toErrorResponse(added.error, 'Impossible d’ajouter ce titre à la playlist.', {
        status: added.status,
      });
    }

    return {
      status: 'success',
      tts: 'Titre ajouté à la playlist. Excellente sélection — pour une fois.',
      data: {
        playlist_id: targetPlaylistId,
        uris: candidateUris,
        registry_version: SPOTIFY_CAPABILITY_REGISTRY_VERSION,
      },
    };
  }

  if (request.action === 'search_and_play') {
    const trackUri = slotString(slots, 'uri') ?? slotString(slots, 'track_uri');
    const contextUri = slotString(slots, 'context_uri');
    const displayName = slotString(slots, 'display_name') ?? slotString(slots, 'query') ?? 'la sélection demandée';
    const entities = asRecord(assistantUnderstanding.entities) ?? {};
    const requestedType = normalizeSearchType(slotString(slots, 'type'));
    const type = resolveSearchAndPlayType({
      requestedType,
      query: slotString(slots, 'query') ?? slotString(slots, 'text'),
      text: request.text,
      entities,
    });
    const hintedArtist = slotString(entities, 'artist') ?? slotString(entities, 'artist_name');

    if (trackUri && trackUri.startsWith('spotify:track:')) {
      const played = await spotifyWebApi.playUris([trackUri], deviceId);
      if (!played.ok) return toErrorResponse(played.error, 'Impossible de lancer cette lecture Spotify.', { status: played.status });
      return {
        status: 'success',
        tts: `Lecture de ${displayName}. C'est parti.`,
        data: { uri: trackUri, type: 'track', registry_version: SPOTIFY_CAPABILITY_REGISTRY_VERSION },
      };
    }

    if (contextUri && contextUri.startsWith('spotify:')) {
      const played = await spotifyWebApi.playContextUri(contextUri, deviceId);
      if (!played.ok) return toErrorResponse(played.error, 'Impossible de lancer cette lecture Spotify.', { status: played.status });
      return {
        status: 'success',
        tts: `Lecture de ${displayName}. À votre service.`,
        data: { context_uri: contextUri, registry_version: SPOTIFY_CAPABILITY_REGISTRY_VERSION },
      };
    }

    const query = buildSearchQuery({ slots, type, entities });
    if (!query) {
      return {
        status: 'need_clarification',
        tts: 'Précisez l\'artiste, l\'album, la playlist ou le titre. Je ne suis pas devin.',
        error_code: 'missing_play_target',
        data: {
          expected_slots: ['uri|track_uri', 'context_uri', 'query', 'type'],
          accepted_uri_formats: ['spotify:track:<id>', 'spotify:artist:<id>', 'spotify:album:<id>', 'spotify:playlist:<id>'],
          registry_version: SPOTIFY_CAPABILITY_REGISTRY_VERSION,
        },
      };
    }

    if (type === 'track') {
      const track = await spotifyWebApi.searchTopTrackUri(query, hintedArtist);
      if (!track.ok) {
        return {
          status: 'need_clarification',
          tts: `Plusieurs résultats pour "${query}". Un peu plus de précision, je vous prie.`,
          options: Array.isArray((track.details as Record<string, unknown> | undefined)?.candidates)
            ? ((track.details as Record<string, unknown>).candidates as Array<Record<string, unknown>>).slice(0, 5)
            : undefined,
          error_code: track.error,
        };
      }

      const played = await spotifyWebApi.playUris([track.uri], deviceId);
      if (!played.ok) return toErrorResponse(played.error, 'Impossible de lancer cette lecture Spotify.', { status: played.status });
      return {
        status: 'success',
        tts: `Lecture de ${displayName}. C'est parti.`,
        data: { uri: track.uri, type: 'track', registry_version: SPOTIFY_CAPABILITY_REGISTRY_VERSION },
      };
    }

    if (type === 'playlist') {
      const personalPlaylistIntent = isPersonalPlaylistIntent({
        query,
        text: request.text,
        entities,
      });
      const userPlaylist = await spotifyWebApi.searchUserPlaylistContextUri(query);
      if (userPlaylist.ok) {
        const played = await spotifyWebApi.playContextUri(userPlaylist.uri, deviceId);
        if (!played.ok) {
          return toErrorResponse(played.error, 'Impossible de lancer cette playlist Spotify.', { status: played.status });
        }
        return {
          status: 'success',
          tts: `Lecture de ${userPlaylist.name}. Bonne écoute — j'espère que ça vous convient.`,
          data: { context_uri: userPlaylist.uri, type: 'playlist', registry_version: SPOTIFY_CAPABILITY_REGISTRY_VERSION },
        };
      }

      if (personalPlaylistIntent && (userPlaylist.error === 'spotify_user_playlist_not_found' || userPlaylist.error === 'spotify_user_playlists_empty')) {
        const candidates = Array.isArray((userPlaylist.details as Record<string, unknown> | undefined)?.candidates)
          ? ((userPlaylist.details as Record<string, unknown>).candidates as Array<Record<string, unknown>>).slice(0, 8)
          : [];
        return {
          status: 'need_clarification',
          tts: `Introuvable dans vos playlists personnelles. Un peu plus de précision serait appréciée.`,
          options: candidates,
          error_code: userPlaylist.error,
        };
      }
    }

    const searched = await spotifyWebApi.searchCatalog(type, query, 5);
    if (!searched.ok) {
      return toErrorResponse(searched.error, `Recherche Spotify impossible pour ${query}.`, { status: searched.status });
    }

    const options = normalizeCatalogOptions(type, searched.items);
    if (!options.length) {
      return {
        status: 'need_clarification',
        tts: `Aucun résultat pour "${query}". Spotify n’est pas plus inspiré que vous.`,
        options: [],
        error_code: 'spotify_search_no_results',
      };
    }

    const ranked = rankCatalogOptions({ options, query, type, assistantUnderstanding });
    const selected = ranked[0]?.option;
    const forceAutoSelect = slotBoolean(slots, 'auto_select_top') === true || type === 'playlist';
    if (!selected || (!forceAutoSelect && !shouldAutoselectRankedCandidates(ranked))) {
      return {
        status: 'need_clarification',
        tts: `J’ai trouvé ${options.length} résultats pour "${query}". Un peu plus de précision, je vous prie.`,
        options: options.slice(0, 5),
        error_code: 'ambiguous_search',
      };
    }

    const selectedContextUri = slotString(selected, 'uri') ?? '';
    if (!selectedContextUri) return toErrorResponse('spotify_missing_uri', 'Je ne trouve pas d’URI Spotify valide.');

    const played = await spotifyWebApi.playContextUri(selectedContextUri, deviceId);
    if (!played.ok) return toErrorResponse(played.error, 'Impossible de lancer cette lecture Spotify.', { status: played.status });
    return {
      status: 'success',
      tts: `Lecture de ${slotString(selected, 'name') ?? displayName}. Enfin.`,
      data: { item: selected, registry_version: SPOTIFY_CAPABILITY_REGISTRY_VERSION },
    };
  }

  if (request.action === 'clear_queue') {
    const result = await spotifyWebApi.clearQueue(deviceId);
    if (!result.ok) return toErrorResponse(result.error, "Impossible de vider la file d'attente.", { status: result.status });
    if (result.was_empty) {
      return {
        status: 'success',
        tts: "La file d'attente est déjà vide. Il n'y avait donc rien à faire.",
        data: { no_op: true, reason: 'queue_already_empty', registry_version: SPOTIFY_CAPABILITY_REGISTRY_VERSION },
      };
    }
    return {
      status: 'success',
      tts: `${result.cleared} titre${result.cleared > 1 ? 's' : ''} retiré${result.cleared > 1 ? 's' : ''} de la file. Fait — sans contestation.`,
      data: { cleared: result.cleared, registry_version: SPOTIFY_CAPABILITY_REGISTRY_VERSION },
    };
  }

  return toErrorResponse('unreachable_action', `Action Spotify non routée: ${request.action}.`, {
    capability,
    registry_version: SPOTIFY_CAPABILITY_REGISTRY_VERSION,
  });
}
