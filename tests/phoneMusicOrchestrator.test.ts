import { PHONE_LOCAL_ACTIVATION_HINT, PhoneMusicOrchestrator } from '../src/music/PhoneMusicOrchestrator';
import type { SpotifyWebApiClient } from '../src/spotifyWebApi';

describe('PhoneMusicOrchestrator', () => {
  test('uses an existing smartphone target without requiring local activation', async () => {
    const orchestrator = new PhoneMusicOrchestrator({ spotify: {} as SpotifyWebApiClient });
    await expect(orchestrator.prepare([{ id: 'phone-1', name: 'Galaxy', type: 'Smartphone', isActive: false }]))
      .resolves.toEqual({ ok: true, deviceId: 'phone-1' });
  });

  test('requires an explicit local activation when the phone is absent', async () => {
    const orchestrator = new PhoneMusicOrchestrator({ spotify: {} as SpotifyWebApiClient });
    await expect(orchestrator.prepare([])).resolves.toMatchObject({
      ok: false,
      code: 'phone_local_activation_required',
    });
  });

  test('waits for Spotify Connect after the APK opens Spotify locally', async () => {
    const listDevicesPublic = jest
      .fn()
      .mockResolvedValueOnce({ ok: true, devices: [] })
      .mockResolvedValue({ ok: true, devices: [{ id: 'phone-1', name: 'Galaxy', type: 'Smartphone', isActive: false }] });
    const result = await new PhoneMusicOrchestrator({
      spotify: { invalidateSituationCache: jest.fn(), listDevicesPublic } as unknown as SpotifyWebApiClient,
      wait: async () => undefined,
    }).prepare([], PHONE_LOCAL_ACTIVATION_HINT);
    expect(result).toEqual({ ok: true, deviceId: 'phone-1' });
  });
});
