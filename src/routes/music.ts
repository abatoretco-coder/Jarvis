import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';

import { isStreamDeckMusicActionAllowed, isStreamDeckPrincipal } from '../identity/oidcClientPolicy';
import { getRequestPrincipal, hasRequestPermission } from '../identity/requestIdentity';
import { PC_MUSIC_TARGET_ID, PcMusicOrchestrator } from '../music/PcMusicOrchestrator';
import { PHONE_MUSIC_TARGET_ID, PhoneMusicOrchestrator } from '../music/PhoneMusicOrchestrator';
import { SALON_MUSIC_TARGET_ID, SalonMusicOrchestrator } from '../music/SalonMusicOrchestrator';
import type { AppDeps } from '../server';
import { executeSpotifyCapability } from '../spotify/spotifyExecutor';

const actionSchema = z.object({
  action: z.enum(['play', 'pause', 'next', 'previous', 'transfer', 'play_playlist', 'play_context', 'play_item', 'play_artist_mix', 'seek', 'volume', 'shuffle', 'repeat', 'add_queue', 'save_library', 'remove_library']),
  deviceId: z.string().trim().min(1).max(180).optional(),
  playlistUri: z.string().trim().regex(/^spotify:playlist:[A-Za-z0-9]+$/u).optional(),
  uri: z.string().trim().regex(/^spotify:(?:track|album|artist|playlist|show|episode|audiobook|user):[A-Za-z0-9]+$/u).optional(),
  positionMs: z.number().int().min(0).max(86_400_000).optional(),
  volumePercent: z.number().int().min(0).max(100).optional(),
  state: z.boolean().optional(),
  repeatMode: z.enum(['off', 'track', 'context']).optional(),
  activationHint: z.enum(['local_spotify_opened']).optional(),
}).strict().superRefine((value, context) => {
  if (value.action === 'transfer' && !value.deviceId) {
    context.addIssue({ code: 'custom', path: ['deviceId'], message: 'device_required' });
  }
  if (value.action === 'play_playlist' && !value.playlistUri) {
    context.addIssue({ code: 'custom', path: ['playlistUri'], message: 'playlist_required' });
  }
  if (['play_context', 'add_queue', 'save_library', 'remove_library'].includes(value.action) && !value.uri) {
    context.addIssue({ code: 'custom', path: ['uri'], message: 'uri_required' });
  }
  if (value.action === 'play_context' && value.uri && !/^spotify:(?:album|artist|playlist):/u.test(value.uri)) {
    context.addIssue({ code: 'custom', path: ['uri'], message: 'context_uri_required' });
  }
  if (value.action === 'play_item' && value.uri && !/^spotify:(?:track|episode):/u.test(value.uri)) {
    context.addIssue({ code: 'custom', path: ['uri'], message: 'item_uri_required' });
  }
  if (value.action === 'play_artist_mix' && value.uri && !/^spotify:artist:/u.test(value.uri)) {
    context.addIssue({ code: 'custom', path: ['uri'], message: 'artist_uri_required' });
  }
  if (['play_item', 'play_artist_mix'].includes(value.action) && !value.uri) {
    context.addIssue({ code: 'custom', path: ['uri'], message: 'uri_required' });
  }
  if (value.action === 'add_queue' && value.uri && !/^spotify:(?:track|episode):/u.test(value.uri)) {
    context.addIssue({ code: 'custom', path: ['uri'], message: 'queue_uri_required' });
  }
  if (value.action === 'seek' && value.positionMs === undefined) context.addIssue({ code: 'custom', path: ['positionMs'], message: 'position_required' });
  if (value.action === 'volume' && value.volumePercent === undefined) context.addIssue({ code: 'custom', path: ['volumePercent'], message: 'volume_required' });
  if (value.action === 'shuffle' && value.state === undefined) context.addIssue({ code: 'custom', path: ['state'], message: 'state_required' });
  if (value.action === 'repeat' && !value.repeatMode) context.addIssue({ code: 'custom', path: ['repeatMode'], message: 'repeat_mode_required' });
});

const searchSchema = z.object({
  q: z.string().trim().min(1).max(120),
  type: z.enum(['track', 'album', 'artist', 'playlist']).default('track'),
}).strict();

const playlistParamsSchema = z.object({ playlistId: z.string().regex(/^[A-Za-z0-9]+$/u) }).strict();

const uriQuerySchema = z.object({
  uri: z.string().trim().regex(/^spotify:(?:track|album|artist|playlist|show|episode|audiobook|user):[A-Za-z0-9]+$/u),
}).strict();

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function number(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function normalizeNowPlaying(data: Record<string, unknown>) {
  const item = asRecord(data.item);
  const album = asRecord(item?.album);
  const device = asRecord(data.device);
  const images = Array.isArray(album?.images) ? album.images : [];
  const image = asRecord(images[0]);
  const artists = Array.isArray(item?.artists)
    ? item.artists.map(asRecord).map((artist) => text(artist?.name)).filter((name): name is string => Boolean(name))
    : [];
  const firstArtist = Array.isArray(item?.artists) ? asRecord(item.artists[0]) : undefined;
  const externalUrls = asRecord(item?.external_urls);
  return {
    isPlaying: data.is_playing === true,
    progressMs: number(data.progress_ms) ?? 0,
    shuffle: data.shuffle_state === true,
    repeat: text(data.repeat_state) ?? 'off',
    track: item ? {
      id: text(item.id) ?? '',
      title: text(item.name) ?? 'Titre inconnu',
      artists,
      artistUri: text(firstArtist?.uri),
      album: text(album?.name),
      imageUrl: text(image?.url),
      durationMs: number(item.duration_ms) ?? 0,
      spotifyUrl: text(externalUrls?.spotify),
    } : null,
    device: device ? {
      id: text(device.id) ?? '',
      name: text(device.name) ?? 'Appareil inconnu',
      type: text(device.type),
      volumePercent: number(device.volume_percent),
    } : null,
  };
}

function normalizeSpotifyItem(value: unknown) {
  const item = asRecord(value);
  if (!item) return null;
  const album = asRecord(item.album);
  const images = Array.isArray(album?.images) ? album.images : Array.isArray(item.images) ? item.images : [];
  const image = asRecord(images[0]);
  const artists = Array.isArray(item.artists)
    ? item.artists.map(asRecord).map((artist) => text(artist?.name)).filter((name): name is string => Boolean(name))
    : [];
  const firstArtist = Array.isArray(item.artists) ? asRecord(item.artists[0]) : undefined;
  const externalUrls = asRecord(item.external_urls);
  const uri = text(item.uri);
  if (!uri) return null;
  return {
    id: text(item.id) ?? uri,
    uri,
    type: text(item.type) ?? 'track',
    title: text(item.name) ?? 'Titre inconnu',
    artists,
    artistUri: text(firstArtist?.uri),
    album: text(album?.name),
    imageUrl: text(image?.url),
    durationMs: number(item.duration_ms) ?? 0,
    spotifyUrl: text(externalUrls?.spotify),
  };
}

function spotifyClientForRequest(request: FastifyRequest, deps: AppDeps) {
  const principal = getRequestPrincipal(request);
  const userId = principal?.kind === 'user' ? principal.userId : undefined;
  return deps.spotifyClients?.forUser(userId) ?? deps.spotifyWebApi;
}

function auditAction(request: FastifyRequest, deps: AppDeps, input: {
  action: string;
  targetId?: string;
  outcome: 'success' | 'failed';
  errorCode?: string;
}) {
  const principal = getRequestPrincipal(request);
  deps.adminAudit?.recordActorAudit({
    actorKind: principal?.kind ?? 'system',
    actorId: principal?.kind === 'user' ? principal.userId : principal?.kind === 'service' ? principal.serviceId : 'legacy-local',
    action: `music.${input.action}`,
    targetType: 'spotify.playback',
    targetId: input.targetId ?? 'active',
    outcome: input.outcome,
    correlationId: request.id,
    metadata: input.errorCode ? { errorCode: input.errorCode } : {},
  });
}

export function registerMusicRoutes(app: FastifyInstance, deps: AppDeps): void {
  app.get('/v1/music', async (request, reply) => {
    if (!hasRequestPermission(request, 'music')) return reply.code(403).send({ error: 'identity_permission_denied' });
    const spotify = spotifyClientForRequest(request, deps);
    if (!spotify.isConfigured()) {
      return reply.send({
        connected: false,
        playback: null,
        devices: [],
        playlists: [],
        multiZone: { supported: false, mode: 'spotify_connect_group' },
      });
    }

    const [now, devices, playlists] = await Promise.all([
      spotify.getNowPlaying(),
      spotify.listDevicesPublic(),
      spotify.listUserPlaylistsPublic(50),
    ]);
    const discoveredDevices = devices.ok ? devices.devices : [];
    const salon = new SalonMusicOrchestrator({
      ha: deps.ha,
      catalog: deps.homeCatalog,
      spotify,
      configuredDeviceName: deps.env.SPOTIFY_WEBAPI_DEVICE_ALIAS_SALON_NAME,
      log: app.log,
    });
    const salonStatus = await salon.status(discoveredDevices);
    const pc = new PcMusicOrchestrator({
      broker: deps.pcAgentBroker,
      spotify,
      configuredDeviceName: deps.env.SPOTIFY_WEBAPI_DEVICE_ALIAS_COMPUTER_NAME,
      log: app.log,
    });
    const pcStatus = pc.status(discoveredDevices);
    const phone = new PhoneMusicOrchestrator({
      spotify,
      configuredDeviceName: deps.env.SPOTIFY_WEBAPI_DEVICE_ALIAS_PHONE_NAME,
      log: app.log,
    });
    const phoneStatus = phone.status(discoveredDevices);
    const normalizedPlayback = now.ok ? normalizeNowPlaying(now.data) : null;
    const activeDevice = devices.ok ? devices.devices.find((device) => device.isActive) : undefined;
    const playback = normalizedPlayback && !normalizedPlayback.device && activeDevice
      ? {
          ...normalizedPlayback,
          device: {
            id: activeDevice.id,
            name: activeDevice.name,
            type: activeDevice.type,
          },
        }
      : normalizedPlayback;
    return reply.send({
      connected: true,
      playback,
      devices: [
        {
          id: SALON_MUSIC_TARGET_ID,
          name: 'TV · Salon',
          type: 'TV',
          isActive: salonStatus.isActive,
          zone: 'salon',
          availability: salonStatus.availability,
          statusLabel: salonStatus.isActive
            ? 'Lecture active'
            : salonStatus.availability === 'ready'
              ? 'Spotify prêt'
              : salonStatus.availability === 'off'
                ? 'Éteinte · appuyer pour écouter'
                : salonStatus.availability === 'on'
                  ? 'Allumée · appuyer pour écouter'
                  : 'TV indisponible',
        },
        {
          id: PC_MUSIC_TARGET_ID,
          name: 'PC',
          type: 'Computer',
          isActive: pcStatus.isActive,
          zone: 'pc',
          availability: pcStatus.availability,
          statusLabel: pcStatus.statusLabel,
        },
        {
          id: PHONE_MUSIC_TARGET_ID,
          name: 'Téléphone',
          type: 'Smartphone',
          isActive: phoneStatus.isActive,
          zone: 'phone',
          availability: phoneStatus.availability,
          statusLabel: phoneStatus.statusLabel,
        },
        ...discoveredDevices
          .filter((device) => device.id !== salonStatus.spotifyDevice?.id && device.id !== pcStatus.spotifyDevice?.id && device.id !== phoneStatus.spotifyDevice?.id)
          .map((device) => ({ ...device, zone: null, availability: 'ready' })),
      ],
      playlists: playlists.ok ? playlists.playlists : [],
      multiZone: { supported: false, mode: 'spotify_connect_group' },
      errors: [
        ...(!now.ok && now.status !== 204 ? [{ resource: 'playback', code: now.error }] : []),
        ...(!devices.ok ? [{ resource: 'devices', code: devices.error }] : []),
        ...(!playlists.ok ? [{ resource: 'playlists', code: playlists.error }] : []),
      ],
    });
  });

  app.get('/v1/music/queue', async (request, reply) => {
    if (!hasRequestPermission(request, 'music')) return reply.code(403).send({ error: 'identity_permission_denied' });
    const result = await spotifyClientForRequest(request, deps).getQueuePublic();
    if (!result.ok) return reply.code(result.status === 401 || result.status === 403 ? result.status : 502).send({ error: result.error });
    const queue = Array.isArray(result.data.queue) ? result.data.queue.map(normalizeSpotifyItem).filter(Boolean) : [];
    return reply.send({ current: normalizeSpotifyItem(result.data.currently_playing), queue });
  });

  app.get('/v1/music/history', async (request, reply) => {
    if (!hasRequestPermission(request, 'music')) return reply.code(403).send({ error: 'identity_permission_denied' });
    const result = await spotifyClientForRequest(request, deps).getRecentlyPlayedPublic(20);
    if (!result.ok) return reply.code(result.status === 401 || result.status === 403 ? result.status : 502).send({ error: result.error });
    return reply.send({ items: result.items.map((entry) => ({
      playedAt: text(entry.played_at),
      track: normalizeSpotifyItem(entry.track),
    })).filter((entry) => entry.track) });
  });

  app.get('/v1/music/playlists/:playlistId', async (request, reply) => {
    if (!hasRequestPermission(request, 'music')) return reply.code(403).send({ error: 'identity_permission_denied' });
    const parsed = playlistParamsSchema.safeParse(request.params ?? {});
    if (!parsed.success) return reply.code(400).send({ error: 'music_playlist_invalid' });
    const result = await spotifyClientForRequest(request, deps).getPlaylistItemsPublic(parsed.data.playlistId, 50);
    if (!result.ok) return reply.code(result.status === 401 || result.status === 403 ? result.status : 502).send({ error: result.error });
    return reply.send({ items: result.items.map(normalizeSpotifyItem).filter(Boolean), total: result.total ?? result.items.length });
  });

  app.get('/v1/music/search', async (request, reply) => {
    if (!hasRequestPermission(request, 'music')) return reply.code(403).send({ error: 'identity_permission_denied' });
    const parsed = searchSchema.safeParse(request.query ?? {});
    if (!parsed.success) return reply.code(400).send({ error: 'music_search_invalid' });
    const result = await spotifyClientForRequest(request, deps).searchCatalog(parsed.data.type, parsed.data.q, 10);
    if (!result.ok) return reply.code(result.status === 401 || result.status === 403 ? result.status : 502).send({ error: result.error });
    return reply.send({ items: result.items });
  });

  app.get('/v1/music/library/contains', async (request, reply) => {
    if (!hasRequestPermission(request, 'music')) return reply.code(403).send({ error: 'identity_permission_denied' });
    const parsed = uriQuerySchema.safeParse(request.query ?? {});
    if (!parsed.success) return reply.code(400).send({ error: 'music_library_uri_invalid' });
    const result = await spotifyClientForRequest(request, deps).libraryContainsUri(parsed.data.uri);
    if (!result.ok) return reply.code(result.status === 401 || result.status === 403 ? result.status : 502).send({ error: result.error });
    return reply.send({ saved: result.saved });
  });

  app.post('/v1/music/actions', async (request, reply) => {
    if (!hasRequestPermission(request, 'music')) return reply.code(403).send({ error: 'identity_permission_denied' });
    const parsed = actionSchema.safeParse(request.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: 'music_action_invalid' });
    const principal = getRequestPrincipal(request);
    if (principal?.kind === 'user' && isStreamDeckPrincipal(principal) && !isStreamDeckMusicActionAllowed(parsed.data.action)) {
      return reply.code(403).send({ error: 'client_scope_forbidden' });
    }
    const spotify = spotifyClientForRequest(request, deps);
    const { action, playlistUri, activationHint, uri, positionMs, volumePercent, state, repeatMode } = parsed.data;
    let { deviceId } = parsed.data;
    if (deviceId === SALON_MUSIC_TARGET_ID) {
      const prepared = await new SalonMusicOrchestrator({
        ha: deps.ha,
        catalog: deps.homeCatalog,
        spotify,
        configuredDeviceName: deps.env.SPOTIFY_WEBAPI_DEVICE_ALIAS_SALON_NAME,
        log: app.log,
      }).prepare();
      if (!prepared.ok) {
        try {
          auditAction(request, deps, { action, targetId: SALON_MUSIC_TARGET_ID, outcome: 'failed', errorCode: prepared.code });
        } catch (error) {
          app.log.error({ errorCode: error instanceof Error ? error.message : 'music_audit_failed' }, 'music UI audit persistence failed');
        }
        return reply.code(409).send({ error: prepared.code, message: prepared.message });
      }
      deviceId = prepared.deviceId;
    }
    if (deviceId === PC_MUSIC_TARGET_ID) {
      const currentDevices = await spotify.listDevicesPublic();
      const prepared = await new PcMusicOrchestrator({
        broker: deps.pcAgentBroker,
        spotify,
        configuredDeviceName: deps.env.SPOTIFY_WEBAPI_DEVICE_ALIAS_COMPUTER_NAME,
        log: app.log,
      }).prepare(currentDevices.ok ? currentDevices.devices : []);
      if (!prepared.ok) {
        try {
          auditAction(request, deps, { action, targetId: PC_MUSIC_TARGET_ID, outcome: 'failed', errorCode: prepared.code });
        } catch (error) {
          app.log.error({ errorCode: error instanceof Error ? error.message : 'music_audit_failed' }, 'music UI audit persistence failed');
        }
        return reply.code(409).send({ error: prepared.code, message: prepared.message });
      }
      deviceId = prepared.deviceId;
    }
    if (deviceId === PHONE_MUSIC_TARGET_ID) {
      const currentDevices = await spotify.listDevicesPublic();
      const prepared = await new PhoneMusicOrchestrator({
        spotify,
        configuredDeviceName: deps.env.SPOTIFY_WEBAPI_DEVICE_ALIAS_PHONE_NAME,
        log: app.log,
      }).prepare(currentDevices.ok ? currentDevices.devices : [], activationHint);
      if (!prepared.ok) {
        try {
          auditAction(request, deps, { action, targetId: PHONE_MUSIC_TARGET_ID, outcome: 'failed', errorCode: prepared.code });
        } catch (error) {
          app.log.error({ errorCode: error instanceof Error ? error.message : 'music_audit_failed' }, 'music UI audit persistence failed');
        }
        return reply.code(409).send({ error: prepared.code, message: prepared.message });
      }
      deviceId = prepared.deviceId;
    }
    let directResult = action === 'seek' ? await spotify.seekToPosition(positionMs!, deviceId)
      : action === 'volume' ? await spotify.setVolume(volumePercent!, deviceId)
        : action === 'shuffle' ? await spotify.setShuffle(state!, deviceId)
          : action === 'repeat' ? await spotify.setRepeat(repeatMode!, deviceId)
            : action === 'play_context' ? await spotify.playContextUri(uri!, deviceId)
              : action === 'play_item' ? await spotify.playUris([uri!], deviceId)
                : action === 'play_artist_mix' ? await spotify.playContextUri(uri!, deviceId)
                  : action === 'play_playlist' ? await spotify.playContextUri(playlistUri!, deviceId)
              : action === 'add_queue' ? await spotify.addToQueueUri(uri!, deviceId)
                : action === 'save_library' ? await spotify.saveLibraryUri(uri!)
                  : action === 'remove_library' ? await spotify.removeLibraryUri(uri!)
                  : undefined;
    if (action === 'play_playlist' && directResult?.ok && state !== undefined) {
      directResult = await spotify.setShuffle(state, deviceId);
    }
    if (directResult) {
      const outcome = directResult.ok ? 'success' as const : 'failed' as const;
      try {
        auditAction(request, deps, { action, targetId: deviceId ?? uri, outcome, errorCode: directResult.ok ? undefined : directResult.error });
      } catch (error) {
        app.log.error({ errorCode: error instanceof Error ? error.message : 'music_audit_failed' }, 'music UI audit persistence failed');
      }
      if (!directResult.ok) return reply.code(409).send({ error: directResult.error, message: 'Commande Spotify indisponible.' });
      spotify.scheduleSituationRefresh();
      return reply.send({
        status: 'success',
        operationStatus: 'accepted',
        message: 'Commande Spotify acceptée. Vérification de la lecture en cours.',
      });
    }
    const requestAction = action === 'play' || action === 'pause' || action === 'next' || action === 'previous' || action === 'transfer'
        ? action
        : null;
    if (!requestAction) {
      return reply.code(400).send({ error: 'music_action_invalid' });
    }
    const slots: Record<string, unknown> = {};
    if (deviceId) slots.device_id = deviceId;
    const result = await executeSpotifyCapability({
      request: {
        threadId: `music-ui-${request.id}`,
        domain: 'spotify',
        action: requestAction,
        slots,
        context: {},
        text: undefined,
      },
      spotifyWebApi: spotify,
      env: deps.env,
      log: app.log,
    });
    try {
      auditAction(request, deps, {
        action,
        targetId: deviceId ?? playlistUri,
        outcome: result.status === 'success' ? 'success' : 'failed',
        errorCode: result.error_code,
      });
    } catch (error) {
      app.log.error({ errorCode: error instanceof Error ? error.message : 'music_audit_failed' }, 'music UI audit persistence failed');
    }
    if (result.status === 'error') return reply.code(409).send({ error: result.error_code ?? 'music_action_failed', message: result.tts });
    return reply.send({
      status: result.status,
      operationStatus: 'accepted',
      message: result.tts,
      data: result.data ?? null,
    });
  });
}
