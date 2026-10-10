import { PcAgentCommandBroker } from '../src/pc/PcAgentCommandBroker';

describe('PcAgentCommandBroker', () => {
  test('delivers only the fixed Spotify command and resolves its acknowledgement', async () => {
    const broker = new PcAgentCommandBroker(10_000, 1_000);
    broker.reportStatus({ spotifyRunning: false });
    const completion = broker.requestSpotifyOpen();
    const command = broker.reportStatus({ spotifyRunning: false });
    expect(command).toMatchObject({ type: 'open_spotify' });
    expect(broker.complete(command!.id, true)).toBe(true);
    await expect(completion).resolves.toBe(true);
    expect(broker.complete(command!.id, true)).toBe(false);
  });

  test('refuses to queue a command while the PC agent is offline', async () => {
    const broker = new PcAgentCommandBroker();
    await expect(broker.requestSpotifyOpen()).resolves.toBe(false);
  });
});

