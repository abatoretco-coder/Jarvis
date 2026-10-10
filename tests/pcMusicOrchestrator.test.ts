import { PcMusicOrchestrator } from '../src/music/PcMusicOrchestrator';
import type { PcAgentCommandBroker } from '../src/pc/PcAgentCommandBroker';
import type { SpotifyWebApiClient } from '../src/spotifyWebApi';

describe('PcMusicOrchestrator', () => {
  test('uses an existing computer target without launching Spotify again', async () => {
    const requestSpotifyOpen = jest.fn();
    const orchestrator = new PcMusicOrchestrator({
      broker: { getStatus: () => ({ online: true, spotifyRunning: true }), requestSpotifyOpen } as unknown as PcAgentCommandBroker,
      spotify: {} as SpotifyWebApiClient,
    });
    await expect(orchestrator.prepare([{ id: 'pc-1', name: 'JARVIS', type: 'Computer', isActive: false }]))
      .resolves.toEqual({ ok: true, deviceId: 'pc-1' });
    expect(requestSpotifyOpen).not.toHaveBeenCalled();
  });

  test('opens Spotify through the agent and waits for the computer target', async () => {
    const listDevicesPublic = jest
      .fn()
      .mockResolvedValueOnce({ ok: true, devices: [] })
      .mockResolvedValue({ ok: true, devices: [{ id: 'pc-1', name: 'JARVIS', type: 'Computer', isActive: false }] });
    const requestSpotifyOpen = jest.fn(async () => true);
    const result = await new PcMusicOrchestrator({
      broker: { getStatus: () => ({ online: true, spotifyRunning: false }), requestSpotifyOpen } as unknown as PcAgentCommandBroker,
      spotify: { invalidateSituationCache: jest.fn(), listDevicesPublic } as unknown as SpotifyWebApiClient,
      wait: async () => undefined,
    }).prepare();
    expect(result).toEqual({ ok: true, deviceId: 'pc-1' });
    expect(requestSpotifyOpen).toHaveBeenCalledTimes(1);
  });

  test('fails explicitly when the local agent is offline', async () => {
    const result = await new PcMusicOrchestrator({
      broker: { getStatus: () => ({ online: false, spotifyRunning: false }) } as PcAgentCommandBroker,
      spotify: {} as SpotifyWebApiClient,
    }).prepare();
    expect(result).toMatchObject({ ok: false, code: 'pc_agent_unavailable' });
  });
});

