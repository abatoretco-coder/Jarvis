import { spawn } from 'node:child_process';

import WebSocket from 'ws';

import type { Env } from '../../env';
import {
  executeOpenAiOperation,
  OpenAiHttpError,
  retryAfterMsFromHeaders,
} from '../../openai/resilience';

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

type RealtimeServerEvent = {
  type?: string;
  delta?: string;
  response?: { status?: string };
};

const MAX_REALTIME_TTS_BYTES = 20 * 1024 * 1024;

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
  const apiKey = env.OPENAI_API_KEY?.trim();
  const baseUrl = env.OPENAI_BASE_URL;
  if (!apiKey || !baseUrl) return null;
  return {
    apiKey,
    baseUrl,
    timeoutMs: env.OPENAI_TTS_TIMEOUT_MS ?? env.OPENAI_TIMEOUT_MS ?? 7_000,
    model: env.OPENAI_TTS_MODEL.trim(),
    voice: env.OPENAI_TTS_VOICE.trim(),
    format: env.OPENAI_TTS_FORMAT ?? 'mp3',
    instructions: env.OPENAI_TTS_INSTRUCTIONS?.trim() || DEFAULT_OPENAI_TTS_INSTRUCTIONS,
    speed: env.TTS_SPEED ?? 1,
  };
}

export function isRealtimeSpeechModel(model: string): boolean {
  return model.trim().startsWith('gpt-realtime');
}

export function pcm16MonoToWav(pcm: Buffer, sampleRate = 24_000): Buffer {
  const header = Buffer.alloc(44);
  const byteRate = sampleRate * 2;
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

export function synthesizeRealtimeSpeech(params: {
  apiKey: string;
  baseUrl: string;
  model: string;
  voice: string;
  input: string;
  instructions?: string;
  speed?: number;
  timeoutMs: number;
  signal?: AbortSignal;
}): Promise<Buffer> {
  const endpoint = new URL(params.baseUrl);
  endpoint.protocol = endpoint.protocol === 'http:' ? 'ws:' : 'wss:';
  endpoint.pathname = `${endpoint.pathname.replace(/\/$/, '')}/realtime`;
  endpoint.search = new URLSearchParams({ model: params.model }).toString();

  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    let settled = false;
    const socket = new WebSocket(endpoint, {
      headers: { Authorization: `Bearer ${params.apiKey}` },
    });
    const timeout = setTimeout(() => finish(new Error('openai_realtime_tts_timeout')), params.timeoutMs);
    const onAbort = (): void => finish(new DOMException('Aborted', 'AbortError'));
    params.signal?.addEventListener('abort', onAbort, { once: true });
    if (params.signal?.aborted) onAbort();

    function finish(error?: Error): void {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      params.signal?.removeEventListener('abort', onAbort);
      socket.close();
      if (error) {
        reject(error);
        return;
      }
      const pcm = Buffer.concat(chunks);
      if (pcm.length === 0) {
        reject(new Error('openai_realtime_tts_empty'));
        return;
      }
      resolve(pcm16MonoToWav(pcm));
    }

    socket.on('open', () => {
      socket.send(JSON.stringify({
        type: 'response.create',
        response: {
          output_modalities: ['audio'],
          instructions: [
            params.instructions,
            'Lis exactement le texte fourni, sans ajout, reformulation ni commentaire.',
          ].filter(Boolean).join(' '),
          input: [{
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: params.input }],
          }],
          audio: {
            output: {
              format: { type: 'audio/pcm', rate: 24_000 },
              voice: params.voice,
              speed: Math.max(0.25, Math.min(1.5, params.speed ?? 1)),
            },
          },
        },
      }));
    });
    socket.on('message', (raw) => {
      let event: RealtimeServerEvent;
      try {
        event = JSON.parse(raw.toString()) as RealtimeServerEvent;
      } catch {
        finish(new Error('openai_realtime_tts_invalid_event'));
        return;
      }
      if (event.type === 'response.output_audio.delta' && typeof event.delta === 'string') {
        const chunk = Buffer.from(event.delta, 'base64');
        totalBytes += chunk.length;
        if (totalBytes > MAX_REALTIME_TTS_BYTES) {
          finish(new Error('openai_realtime_tts_too_large'));
          return;
        }
        chunks.push(chunk);
      } else if (event.type === 'response.done') {
        finish(event.response?.status === 'completed' ? undefined : new Error('openai_realtime_tts_incomplete'));
      } else if (event.type === 'error') {
        finish(new Error('openai_realtime_tts_error'));
      }
    });
    socket.on('error', () => finish(new Error('openai_realtime_tts_connection_failed')));
    socket.on('close', () => {
      if (!settled) finish(new Error('openai_realtime_tts_closed'));
    });
  });
}

export async function synthesizeOpenAiSpeech(
  config: OpenAiTtsRuntimeConfig,
  input: string,
): Promise<{ bytes: Buffer; contentType: string }> {
  return executeOpenAiOperation({
    capability: 'tts',
    model: config.model,
    operation: async (_attempt, operationSignal) => {
      if (isRealtimeSpeechModel(config.model)) {
        return {
          value: {
            bytes: await synthesizeRealtimeSpeech({
              apiKey: config.apiKey,
              baseUrl: config.baseUrl,
              model: config.model,
              voice: config.voice,
              input,
              instructions: config.instructions,
              speed: config.speed,
              timeoutMs: config.timeoutMs,
              signal: operationSignal,
            }),
            contentType: 'audio/wav',
          },
          model: config.model,
        };
      }

      const response = await fetch(`${config.baseUrl.replace(/\/$/, '')}/audio/speech`, {
        method: 'POST',
        headers: { authorization: `Bearer ${config.apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          model: config.model,
          voice: config.voice,
          input,
          response_format: config.format,
          speed: config.speed,
          ...(config.instructions ? { instructions: config.instructions } : {}),
        }),
        signal: AbortSignal.any([operationSignal, AbortSignal.timeout(config.timeoutMs)]),
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new OpenAiHttpError(
          response.status,
          retryAfterMsFromHeaders(response.headers),
          `openai_tts_failed:${response.status}`,
        );
      }
      return {
        value: {
          bytes: Buffer.from(await response.arrayBuffer()),
          contentType: response.headers.get('content-type') ?? 'audio/mpeg',
        },
        status: response.status,
        model: config.model,
      };
    },
  });
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
