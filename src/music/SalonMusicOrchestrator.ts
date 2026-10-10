import type { HomeAssistantClient } from '../haClient';
import { isHassState } from '../hass';
import type { HomeCatalog } from '../home/HomeCatalog';
import { ensureTelevisionReady } from '../home/TelevisionReadiness';
import type { SpotifyWebApiClient } from '../spotifyWebApi';

export const SALON_MUSIC_TARGET_ID = 'zone:salon';
const SALON_TV_DEVICE_ID = 'living-room-tv';
const DEFAULT_SPOTIFY_SOURCE = 'Spotify - Musique et podcasts';

type SpotifyDevice = { id: string; name: string; type?: string; isActive: boolean };

export type SalonMusicAvailability = 'off' | 'on' | 'ready' | 'unavailable';

export type SalonMusicStatus = {
  availability: SalonMusicAvailability;
  isActive: boolean;
  spotifyDevice?: SpotifyDevice;
};

export type SalonMusicPreparation =
  | { ok: true; deviceId: string }
  | {
      ok: false;
      code: 'salon_home_unavailable' | 'salon_tv_unavailable' | 'salon_spotify_launch_failed' | 'salon_spotify_device_timeout';
      message: string;
    };

type Logger = { warn?: (payload: unknown, message?: string) => void; info?: (payload: unknown, message?: string) => void };

function normalize(value: string): string {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/gu, '').toLowerCase().replace(/[^a-z0-9]+/gu, ' ').trim();
}

function isSalonDevice(device: SpotifyDevice, configuredName?: string): boolean {
  if (normalize(device.type ?? '') === 'tv') return true;
  const name = normalize(device.name);
  const configured = normalize(configuredName ?? '');
  if (configured && configured.split(' ').every((token) => name.includes(token))) return true;
  return name.includes('lg') && (name.includes('webos') || name.includes('tv'));
}

function spotifySource(state: unknown): string {
  if (!isHassState(state)) return DEFAULT_SPOTIFY_SOURCE;
  const candidates = state.attributes?.source_list;
  if (!Array.isArray(candidates)) return DEFAULT_SPOTIFY_SOURCE;
  return candidates.find((item): item is string => typeof item === 'string' && normalize(item).startsWith('spotify'))
    ?? DEFAULT_SPOTIFY_SOURCE;
}

export class SalonMusicOrchestrator {
  constructor(private readonly input: {
    ha?: HomeAssistantClient;
    catalog?: HomeCatalog;
    spotify: SpotifyWebApiClient;
    configuredDeviceName?: string;
    log?: Logger;
    wait?: (milliseconds: number) => Promise<void>;
    spotifyPollAttempts?: number;
    tvPollAttempts?: number;
  }) {}

  private get entityId(): string | undefined {
    return this.input.catalog?.getMapping(SALON_TV_DEVICE_ID)?.entityId;
  }

  private get televisionConfig() {
    return this.input.catalog?.getMapping(SALON_TV_DEVICE_ID)?.television;
  }

  private async listSalonSpotifyDevice(): Promise<SpotifyDevice | undefined> {
    this.input.spotify.invalidateSituationCache();
    const result = await this.input.spotify.listDevicesPublic();
    if (!result.ok) return undefined;
    return result.devices.find((device) => isSalonDevice(device, this.input.configuredDeviceName));
  }

  async status(devices?: SpotifyDevice[]): Promise<SalonMusicStatus> {
    const spotifyDevice = devices?.find((device) => isSalonDevice(device, this.input.configuredDeviceName));
    const entityId = this.entityId;
    if (!this.input.ha || !entityId) {
      return { availability: spotifyDevice ? 'ready' : 'unavailable', isActive: spotifyDevice?.isActive ?? false, spotifyDevice };
    }
    try {
      const state = await this.input.ha.getState(entityId);
      if (!isHassState(state) || ['unavailable', 'unknown'].includes(state.state)) {
        return { availability: spotifyDevice ? 'ready' : 'unavailable', isActive: spotifyDevice?.isActive ?? false, spotifyDevice };
      }
      return {
        availability: spotifyDevice ? 'ready' : state.state === 'off' ? 'off' : 'on',
        isActive: spotifyDevice?.isActive ?? false,
        spotifyDevice,
      };
    } catch {
      return { availability: spotifyDevice ? 'ready' : 'unavailable', isActive: spotifyDevice?.isActive ?? false, spotifyDevice };
    }
  }

  async prepare(): Promise<SalonMusicPreparation> {
    const { ha } = this.input;
    const entityId = this.entityId;
    if (!ha || !entityId) {
      return { ok: false, code: 'salon_home_unavailable', message: 'Le contrôle de la TV du salon est indisponible.' };
    }

    const wait = this.input.wait ?? ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
    let state: unknown;
    try {
      const readiness = await ensureTelevisionReady({
        ha,
        entityId,
        ...(this.televisionConfig?.wakeOnLanMac
          ? { wakeOnLanMac: this.televisionConfig.wakeOnLanMac }
          : {}),
        ...(this.televisionConfig?.wakeOnLanBroadcastAddress
          ? { wakeOnLanBroadcastAddress: this.televisionConfig.wakeOnLanBroadcastAddress }
          : {}),
        wait,
        pollAttempts: this.input.tvPollAttempts ?? 15,
      });
      if (!readiness.ok) {
        return {
          ok: false,
          code:
            readiness.code === 'television_state_timeout'
              ? 'salon_tv_unavailable'
              : 'salon_spotify_launch_failed',
          message:
            readiness.code === 'television_state_timeout'
              ? 'La TV du salon ne répond pas encore après la commande d’allumage.'
              : 'Impossible d’allumer la TV du salon.',
        };
      }
      state = readiness.state;

      const source = this.televisionConfig?.spotifySource || spotifySource(state);
      const activeSource = isHassState(state) && typeof state.attributes?.source === 'string' ? state.attributes.source : '';
      if (normalize(activeSource) !== normalize(source)) {
        await ha.callService({
          domain: 'media_player',
          service: 'select_source',
          target: { entity_id: entityId },
          serviceData: { source },
        });
      }
    } catch (error) {
      this.input.log?.warn?.({ errorCode: error instanceof Error ? error.message : 'salon_spotify_launch_failed' }, 'salon Spotify launch failed');
      return { ok: false, code: 'salon_spotify_launch_failed', message: 'Impossible d’ouvrir Spotify sur la TV du salon.' };
    }

    for (let attempt = 0; attempt < (this.input.spotifyPollAttempts ?? 20); attempt += 1) {
      const device = await this.listSalonSpotifyDevice();
      if (device) {
        this.input.log?.info?.({ spotifyDeviceId: device.id, attempt: attempt + 1 }, 'salon Spotify target ready');
        return { ok: true, deviceId: device.id };
      }
      await wait(1_000);
    }
    return {
      ok: false,
      code: 'salon_spotify_device_timeout',
      message: 'Spotify est ouvert sur la TV, mais la TV n’est pas encore disponible dans Spotify Connect.',
    };
  }
}
