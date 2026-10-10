import type { PcAgentCommandBroker } from '../pc/PcAgentCommandBroker';
import type { SpotifyWebApiClient } from '../spotifyWebApi';

export const PC_MUSIC_TARGET_ID = 'zone:pc';

type SpotifyDevice = { id: string; name: string; type?: string; isActive: boolean };
type Logger = { warn?: (payload: unknown, message?: string) => void; info?: (payload: unknown, message?: string) => void };

export type PcMusicPreparation =
  | { ok: true; deviceId: string }
  | { ok: false; code: 'pc_agent_unavailable' | 'pc_spotify_launch_failed' | 'pc_spotify_device_timeout'; message: string };

function normalize(value: string): string {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/gu, '').toLowerCase().replace(/[^a-z0-9]+/gu, ' ').trim();
}

function isPcDevice(device: SpotifyDevice, configuredName?: string): boolean {
  if (normalize(device.type ?? '') === 'computer') return true;
  const name = normalize(device.name);
  const configured = normalize(configuredName ?? '');
  return Boolean(configured && configured.split(' ').every((token) => name.includes(token)));
}

export class PcMusicOrchestrator {
  constructor(private readonly input: {
    broker?: PcAgentCommandBroker;
    spotify: SpotifyWebApiClient;
    configuredDeviceName?: string;
    log?: Logger;
    wait?: (milliseconds: number) => Promise<void>;
    spotifyPollAttempts?: number;
  }) {}

  findSpotifyDevice(devices: SpotifyDevice[]): SpotifyDevice | undefined {
    return devices.find((device) => isPcDevice(device, this.input.configuredDeviceName));
  }

  status(devices: SpotifyDevice[]) {
    const spotifyDevice = this.findSpotifyDevice(devices);
    const agent = this.input.broker?.getStatus() ?? { online: false, spotifyRunning: false };
    return {
      availability: spotifyDevice ? 'ready' as const : agent.online ? 'on' as const : 'unavailable' as const,
      isActive: spotifyDevice?.isActive ?? false,
      spotifyDevice,
      statusLabel: spotifyDevice
        ? spotifyDevice.isActive ? 'Lecture active' : 'Spotify prêt'
        : agent.online
          ? agent.spotifyRunning ? 'Spotify démarre…' : 'Spotify fermé · appuyer pour écouter'
          : 'Agent PC indisponible',
    };
  }

  async prepare(devices: SpotifyDevice[] = []): Promise<PcMusicPreparation> {
    const existing = this.findSpotifyDevice(devices);
    if (existing) return { ok: true, deviceId: existing.id };
    const broker = this.input.broker;
    if (!broker?.getStatus().online) {
      return { ok: false, code: 'pc_agent_unavailable', message: 'L’agent Jarvis du PC est indisponible.' };
    }
    if (!await broker.requestSpotifyOpen()) {
      return { ok: false, code: 'pc_spotify_launch_failed', message: 'Impossible d’ouvrir Spotify sur le PC.' };
    }

    const wait = this.input.wait ?? ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
    for (let attempt = 0; attempt < (this.input.spotifyPollAttempts ?? 25); attempt += 1) {
      this.input.spotify.invalidateSituationCache();
      const result = await this.input.spotify.listDevicesPublic();
      const device = result.ok ? this.findSpotifyDevice(result.devices) : undefined;
      if (device) {
        this.input.log?.info?.({ spotifyDeviceId: device.id, attempt: attempt + 1 }, 'PC Spotify target ready');
        return { ok: true, deviceId: device.id };
      }
      await wait(1_000);
    }
    this.input.log?.warn?.({}, 'PC Spotify target timed out');
    return { ok: false, code: 'pc_spotify_device_timeout', message: 'Spotify est ouvert sur le PC, mais le PC n’est pas encore disponible dans Spotify Connect.' };
  }
}

