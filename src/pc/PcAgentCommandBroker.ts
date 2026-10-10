import { randomUUID } from 'node:crypto';

export type PcAgentCommand = { id: string; type: 'open_spotify' };

type PendingCommand = {
  command: PcAgentCommand;
  deliveredAt?: number;
  resolve: (success: boolean) => void;
  promise: Promise<boolean>;
};

export class PcAgentCommandBroker {
  private lastSeenAt = 0;
  private spotifyRunning = false;
  private pending?: PendingCommand;

  constructor(
    private readonly onlineTtlMs = 10_000,
    private readonly commandTimeoutMs = 8_000,
    private readonly now = () => Date.now(),
  ) {}

  reportStatus(status: { spotifyRunning: boolean }): PcAgentCommand | null {
    this.lastSeenAt = this.now();
    this.spotifyRunning = status.spotifyRunning;
    if (!this.pending) return null;
    if (!this.pending.deliveredAt || this.now() - this.pending.deliveredAt >= 3_000) {
      this.pending.deliveredAt = this.now();
      return this.pending.command;
    }
    return null;
  }

  getStatus(): { online: boolean; spotifyRunning: boolean } {
    return {
      online: this.lastSeenAt > 0 && this.now() - this.lastSeenAt <= this.onlineTtlMs,
      spotifyRunning: this.spotifyRunning,
    };
  }

  complete(commandId: string, success: boolean): boolean {
    if (!this.pending || this.pending.command.id !== commandId) return false;
    const pending = this.pending;
    this.pending = undefined;
    pending.resolve(success);
    return true;
  }

  async requestSpotifyOpen(): Promise<boolean> {
    if (!this.getStatus().online) return false;
    if (this.pending) return this.pending.promise;

    let resolveCommand!: (success: boolean) => void;
    const promise = new Promise<boolean>((resolve) => { resolveCommand = resolve; });
    const command: PendingCommand = {
      command: { id: randomUUID(), type: 'open_spotify' },
      resolve: resolveCommand,
      promise,
    };
    this.pending = command;

    const timeout = setTimeout(() => {
      if (this.pending === command) {
        this.pending = undefined;
        resolveCommand(false);
      }
    }, this.commandTimeoutMs);
    timeout.unref?.();
    return promise.finally(() => clearTimeout(timeout));
  }
}

