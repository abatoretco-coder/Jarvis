import { spawn } from 'node:child_process';

import { getCurrentDataOwnerScope } from '../identity/requestIdentity';
import type { VoiceArchiveRepository,VoiceArtifactDirection } from './VoiceArchiveRepository';

type ArchiveLogger = { warn: (details: unknown, message?: string) => void };
type Mp3Encoder = (audio: Buffer, contentType: string, maxBytes: number) => Promise<Buffer>;

export type VoiceArchiveRequest = {
  voiceTurnId: string;
  direction: VoiceArtifactDirection;
  audio: Buffer;
  contentType: string;
  transcript?: string;
  engineId?: string;
  latencyMs?: number;
};

export class VoiceArchiveService {
  private readonly pending = new Set<Promise<void>>();
  private readonly linkedThreads = new Map<string, string>();

  constructor(
    private readonly repository: VoiceArchiveRepository,
    private readonly options: {
      enabled: boolean;
      maxAudioBytes: number;
      retentionDays: number;
      logger: ArchiveLogger;
      encodeMp3?: Mp3Encoder;
    }
  ) {}

  archive(request: VoiceArchiveRequest): void {
    if (!this.options.enabled || !isTrustedHomeAssistantTurn(request.voiceTurnId)) return;
    if (request.audio.length === 0 || request.audio.length > this.options.maxAudioBytes) {
      this.options.logger.warn(
        { voice_turn_id: request.voiceTurnId, bytes: request.audio.length },
        'voice_archive_input_rejected'
      );
      return;
    }
    const work = this.persist(request).catch((error) => {
      this.options.logger.warn(
        { voice_turn_id: request.voiceTurnId, direction: request.direction, err: error },
        'voice_archive_failed'
      );
    });
    this.pending.add(work);
    void work.finally(() => this.pending.delete(work));
  }

  linkTurn(voiceTurnId: string, threadId: string): void {
    if (!this.options.enabled || !isTrustedHomeAssistantTurn(voiceTurnId)) return;
    this.linkedThreads.set(voiceTurnId, threadId);
    if (this.linkedThreads.size > 256) {
      const oldest = this.linkedThreads.keys().next().value as string | undefined;
      if (oldest) this.linkedThreads.delete(oldest);
    }
    this.repository.linkTurn(voiceTurnId, threadId);
  }

  cleanup(nowMs = Date.now()): number {
    if (!this.options.enabled || this.options.retentionDays <= 0) return 0;
    return this.repository.purgeCreatedBefore(
      nowMs - this.options.retentionDays * 24 * 60 * 60 * 1000
    );
  }

  async close(): Promise<void> {
    await Promise.allSettled([...this.pending]);
  }

  private async persist(request: VoiceArchiveRequest): Promise<void> {
    const encoder = this.options.encodeMp3 ?? encodeMp3;
    const mp3Audio = await encoder(request.audio, request.contentType, this.options.maxAudioBytes);
    this.repository.save({
      voiceTurnId: request.voiceTurnId,
      direction: request.direction,
      threadId: this.linkedThreads.get(request.voiceTurnId),
      transcript: request.transcript,
      engineId: request.engineId,
      sourceContentType: request.contentType.slice(0, 128),
      sourceByteLength: request.audio.length,
      mp3Audio,
      latencyMs: request.latencyMs,
      createdAtMs: Date.now(),
    });
    if (request.direction === 'output') this.linkedThreads.delete(request.voiceTurnId);
  }
}

function isVoiceTurnId(value: string): boolean {
  return /^ha-turn-[a-f0-9]{32}$/u.test(value);
}

function isTrustedHomeAssistantTurn(value: string): boolean {
  if (!isVoiceTurnId(value)) return false;
  const scope = getCurrentDataOwnerScope();
  return scope.kind === 'service' && scope.serviceId === 'home-assistant-pc';
}

export async function encodeMp3(audio: Buffer, contentType: string, maxBytes: number): Promise<Buffer> {
  if (/^audio\/(?:mpeg|mp3)(?:;|$)/iu.test(contentType)) return Buffer.from(audio);
  return new Promise<Buffer>((resolve, reject) => {
    const child = spawn('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-i', 'pipe:0', '-vn', '-ac', '1',
      '-codec:a', 'libmp3lame', '-b:a', '64k', '-f', 'mp3', 'pipe:1',
    ], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    const chunks: Buffer[] = [];
    const errors: Buffer[] = [];
    let total = 0;
    child.stdout.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) child.kill();
      else chunks.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      if (errors.reduce((sum, item) => sum + item.length, 0) < 4096) errors.push(chunk);
    });
    child.on('error', reject);
    child.on('close', (code) => {
      const result = Buffer.concat(chunks);
      if (code === 0 && result.length > 0 && result.length <= maxBytes) resolve(result);
      else reject(new Error(`voice_archive_ffmpeg_failed:${code}:${Buffer.concat(errors).toString('utf8').slice(0, 200)}`));
    });
    child.stdin.end(audio);
  });
}
