import type { SpotifyWebApiClient } from '../spotifyWebApi';

export const PHONE_MUSIC_TARGET_ID = 'zone:phone';
export const PHONE_LOCAL_ACTIVATION_HINT = 'local_spotify_opened';

type SpotifyDevice = { id: string; name: string; type?: string; isActive: boolean };
type Logger = { warn?: (payload: unknown, message?: string) => void; info?: (payload: unknown, message?: string) => void };

export type PhoneMusicPreparation =
  | { ok: true; deviceId: string }
  | { ok: false; code: 'phone_local_activation_required' | 'phone_spotify_device_timeout'; message: string };

function normalize(value: string): string {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/gu, '').toLowerCase().replace(/[^a-z0-9]+/gu, ' ').trim();
}

function isPhoneDevice(device: SpotifyDevice, configuredName?: string): boolean {
  const type = normalize(device.type ?? '');
  if (type === 'smartphone' || type === 'phone') return true;
  const name = normalize(device.name);
  const configured = normalize(configuredName ?? '');
  return Boolean(configured && configured.split(' ').every((token) => name.includes(token)));
}

export class PhoneMusicOrchestrator {
  constructor(private readonly input: {
    spotify: SpotifyWebApiClient;
    configuredDeviceName?: string;
    log?: Logger;
    wait?: (milliseconds: number) => Promise<void>;
    spotifyPollAttempts?: number;
  }) {}

  findSpotifyDevice(devices: SpotifyDevice[]): SpotifyDevice | undefined {
    return devices.find((device) => isPhoneDevice(device, this.input.configuredDeviceName));
  }

  status(devices: SpotifyDevice[]) {
    const spotifyDevice = this.findSpotifyDevice(devices);
    return {
      availability: spotifyDevice ? 'ready' as const : 'off' as const,
      isActive: spotifyDevice?.isActive ?? false,
      spotifyDevice,
      statusLabel: spotifyDevice
        ? spotifyDevice.isActive ? 'Lecture active' : 'Spotify prêt'
        : 'Spotify fermé · ouvrir sur le téléphone',
    };
  }

  async prepare(devices: SpotifyDevice[], activationHint?: string): Promise<PhoneMusicPreparation> {
    const existing = this.findSpotifyDevice(devices);
    if (existing) return { ok: true, deviceId: existing.id };
    if (activationHint !== PHONE_LOCAL_ACTIVATION_HINT) {
      return {
        ok: false,
        code: 'phone_local_activation_required',
        message: 'Ouvre Jarvis sur le téléphone puis appuie sur la sortie Téléphone.',
      };
    }

    const wait = this.input.wait ?? ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
    for (let attempt = 0; attempt < (this.input.spotifyPollAttempts ?? 25); attempt += 1) {
      this.input.spotify.invalidateSituationCache();
      const result = await this.input.spotify.listDevicesPublic();
      const device = result.ok ? this.findSpotifyDevice(result.devices) : undefined;
      if (device) {
        this.input.log?.info?.({ spotifyDeviceId: device.id, attempt: attempt + 1 }, 'Phone Spotify target ready');
        return { ok: true, deviceId: device.id };
      }
      await wait(1_000);
    }
    this.input.log?.warn?.({}, 'Phone Spotify target timed out');
    return {
      ok: false,
      code: 'phone_spotify_device_timeout',
      message: 'Spotify est ouvert sur le téléphone, mais il n’est pas encore disponible dans Spotify Connect.',
    };
  }
}
