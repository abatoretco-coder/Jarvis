import { spawn } from 'node:child_process';

import type { Env } from '../../env';

export type AudioTransformOpts = { speed: number; pitchSemitones: number; clarity: boolean };
export type TtsRouteMode = 'auto' | 'ha' | 'openai';
export type OpenAiTtsRuntimeConfig = {
  apiKey: string;
  baseUrl: string;
  timeoutMs: number;
  model: string;
  voice: string;
  format: 'mp3' | 'wav' | 'opus' | 'aac' | 'flac' | 'pcm';
  instructions?: string;
  speed: number;
};

const DEFAULT_OPENAI_TTS_INSTRUCTIONS =
  'Parle en francais naturel, chaleureux et fluide. Voix conversationnelle, peu robotique, avec une intonation souple et des pauses legeres. Evite le ton monotone, saccade, trop rapide ou sur-articule. Garde un style simple, clair et en tutoiement.';

export function buildFfmpegFilters(opts: AudioTransformOpts, skipSpeed = false): string[] {
  const filters: string[] = [];
  if (opts.pitchSemitones !== 0) {
    const ratio = Math.pow(2, opts.pitchSemitones / 12);
    const shiftedRate = Math.round(44100 * ratio);
    filters.push(
      `asetrate=${shiftedRate}`,
      'aresample=44100',
      `atempo=${Math.max(0.5, Math.min(2.0, 1 / ratio)).toFixed(6)}`,
    );
  }
  if (!skipSpeed && opts.speed !== 1.0) {
    filters.push(`atempo=${Math.max(0.5, Math.min(2.0, opts.speed)).toFixed(6)}`);
  }
  if (opts.clarity) {
    filters.push('highpass=f=100', 'equalizer=f=3000:width_type=o:width=2:g=2');
  }
  return filters;
}

export function pipeStreamThroughFfmpeg(body: ReadableStream<Uint8Array>, filters: string[]): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const proc = spawn('ffmpeg', [
      '-f', 'mp3', '-i', 'pipe:0',
      '-filter:a', filters.join(','),
      '-f', 'mp3', 'pipe:1',
      '-loglevel', 'error',
    ]);
    const chunks: Buffer[] = [];
    let stderr = '';
    proc.stdout.on('data', (d: Buffer) => chunks.push(d));
    proc.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
    proc.on('close', (code) => {
      if (code === 0) resolve(Buffer.concat(chunks));
      else reject(new Error(`ffmpeg exit ${code}: ${stderr.slice(0, 200)}`));
    });
    proc.on('error', reject);
    const reader = body.getReader();
    const pump = (): void => {
      reader.read().then(({ done, value }) => {
        if (done) { proc.stdin.end(); return; }
        const ok = proc.stdin.write(value);
        if (ok) pump();
        else proc.stdin.once('drain', pump);
      }).catch((err: unknown) => { proc.stdin.destroy(err as Error); reject(err); });
    };
    pump();
  });
}

export function resolveOpenAiTtsRuntimeConfig(env: Env): OpenAiTtsRuntimeConfig | null {
  const apiKey = env.OPENAI_TTS_API_KEY?.trim() || env.OPENAI_API_KEY?.trim();
  const baseUrl = env.OPENAI_TTS_BASE_URL?.trim() || env.OPENAI_BASE_URL;
  if (!apiKey || !baseUrl) return null;
  return {
    apiKey,
    baseUrl,
    timeoutMs: env.OPENAI_TTS_TIMEOUT_MS,
    model: env.OPENAI_TTS_MODEL.trim(),
    voice: env.OPENAI_TTS_VOICE.trim(),
    format: env.OPENAI_TTS_FORMAT,
    instructions: env.OPENAI_TTS_INSTRUCTIONS?.trim() || DEFAULT_OPENAI_TTS_INSTRUCTIONS,
    speed: env.TTS_SPEED,
  };
}

export function hasHaTtsConfig(env: Env): boolean {
  return Boolean(env.HA_BASE_URL && env.HA_TOKEN);
}

export function resolveRequestedTtsMode(defaultMode: TtsRouteMode, requested?: TtsRouteMode): TtsRouteMode {
  if (defaultMode !== 'auto' || !requested || requested === 'auto') return defaultMode;
  return requested;
}

export function audioExtensionFromContentType(contentType: string): string {
  if (/wav/u.test(contentType)) return 'wav';
  if (/ogg|opus/u.test(contentType)) return 'ogg';
  if (/flac/u.test(contentType)) return 'flac';
  if (/aac|m4a|mp4/u.test(contentType)) return 'm4a';
  if (/mpeg|mp3/u.test(contentType)) return 'mp3';
  return 'wav';
}

export function bufferToWebBytes(buffer: Buffer): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(buffer.byteLength);
  bytes.set(buffer);
  return bytes;
}
