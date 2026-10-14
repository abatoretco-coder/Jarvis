import WebSocket from 'ws';

export type LiveTtsCandidate = {
  requestedText: string;
  outputTranscript: string;
  audio: Buffer;
  durationMs: number;
  quietWindowElapsed: boolean;
};

export type LiveTtsConfig = {
  apiKey: string;
  baseUrl: string;
  model: string;
  voice: string;
  timeoutMs: number;
  maxEventBytes: number;
};

export type LiveTtsResult = {
  audio: Buffer;
  sessionId: string;
  usageSeconds: number;
};

function normalizedWords(value: string): string[] {
  return value
    .normalize('NFKD')
    .replace(/\p{Diacritic}/gu, '')
    .toLocaleLowerCase('fr-FR')
    .replace(/[^\p{Letter}\p{Number}]+/gu, ' ')
    .trim()
    .split(/\s+/u)
    .filter(Boolean);
}

export class LiveTtsAdapter {
  private readonly activeSockets = new Set<WebSocket>();

  stop(): void {
    for (const socket of this.activeSockets) socket.terminate();
    this.activeSockets.clear();
  }

  validateCandidate(candidate: LiveTtsCandidate): { ok: true } | { ok: false; reason: string } {
    if (!candidate.quietWindowElapsed) return { ok: false, reason: 'live_tts_not_settled' };
    if (candidate.audio.byteLength < 480 || candidate.audio.byteLength > 12_000_000) {
      return { ok: false, reason: 'live_tts_audio_size_invalid' };
    }
    if (candidate.durationMs < 100 || candidate.durationMs > 12_000) {
      return { ok: false, reason: 'live_tts_duration_invalid' };
    }
    const requested = normalizedWords(candidate.requestedText);
    const output = normalizedWords(candidate.outputTranscript);
    if (requested.length === 0 || output.length === 0) {
      return { ok: false, reason: 'live_tts_transcript_missing' };
    }
    const matches = requested.filter((word, index) => output[index] === word).length;
    if (matches / Math.max(requested.length, output.length) < 0.98) {
      return { ok: false, reason: 'live_tts_fidelity_insufficient' };
    }
    return { ok: true };
  }

  synthesize(text: string, config: LiveTtsConfig): Promise<LiveTtsResult> {
    const requestedText = text.trim();
    if (!requestedText || requestedText.length > 1_800) {
      return Promise.reject(new Error('live_tts_text_out_of_bounds'));
    }
    const endpoint = new URL(config.baseUrl);
    endpoint.protocol = endpoint.protocol === 'http:' ? 'ws:' : 'wss:';
    endpoint.pathname = `${endpoint.pathname.replace(/\/$/u, '')}/live/sessions`;
    endpoint.search = '';

    return new Promise<LiveTtsResult>((resolve, reject) => {
      const socket = new WebSocket(endpoint, {
        headers: { authorization: `Bearer ${config.apiKey}` },
      });
      this.activeSockets.add(socket);
      const audioChunks: Buffer[] = [];
      let transcript = '';
      let totalBytes = 0;
      let settled = false;
      let closeRequested = false;
      let sessionId = '';
      const startedAtMs = Date.now();
      let quietTimer: NodeJS.Timeout | undefined;
      const absoluteTimer = setTimeout(
        () => finish(new Error('live_tts_timeout')),
        config.timeoutMs
      );
      absoluteTimer.unref();

      const finish = (error?: Error): void => {
        if (settled) return;
        settled = true;
        this.activeSockets.delete(socket);
        clearTimeout(absoluteTimer);
        if (quietTimer) clearTimeout(quietTimer);
        if (socket.readyState === WebSocket.OPEN && !closeRequested) {
          closeRequested = true;
          socket.send(JSON.stringify({ type: 'session.close', event_id: 'ha_tts_close' }));
          const terminateTimer = setTimeout(() => socket.terminate(), 500);
          terminateTimer.unref();
        } else if (socket.readyState !== WebSocket.CLOSED) {
          socket.terminate();
        }
        if (error) {
          reject(error);
          return;
        }
        if (!sessionId) {
          reject(new Error('live_tts_session_missing'));
          return;
        }
        resolve({
          audio: pcm16MonoToWav(Buffer.concat(audioChunks), 24_000),
          sessionId,
          usageSeconds: Math.max(1, Math.ceil((Date.now() - startedAtMs) / 1_000)),
        });
      };

      const scheduleValidation = (): void => {
        if (quietTimer) clearTimeout(quietTimer);
        quietTimer = undefined;
        const durationMs = Math.floor((totalBytes / (24_000 * 2)) * 1_000);
        const currentVerdict = this.validateCandidate({
          requestedText,
          outputTranscript: transcript,
          audio: Buffer.concat(audioChunks),
          durationMs,
          quietWindowElapsed: true,
        });
        if (!currentVerdict.ok) return;
        quietTimer = setTimeout(() => {
          const verdict = this.validateCandidate({
            requestedText,
            outputTranscript: transcript,
            audio: Buffer.concat(audioChunks),
            durationMs: Math.floor((totalBytes / (24_000 * 2)) * 1_000),
            quietWindowElapsed: true,
          });
          if (verdict.ok) finish();
          else finish(new Error(verdict.reason));
        }, 400);
        quietTimer.unref();
      };

      socket.once('open', () => {
        socket.send(JSON.stringify({
          type: 'session.start',
          event_id: 'ha_tts_start',
          session: {
            model: config.model,
            instructions: 'Parle en français. Pour les commentaires reçus, conserve strictement les mots fournis, sans ajout.',
            audio: {
              format: { type: 'audio/pcm', rate: 24_000 },
              output: { voice: config.voice },
            },
            delegation: { type: 'client' },
            store: false,
          },
        }));
      });
      socket.on('message', (raw) => {
        if (settled) return;
        const bytes = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as ArrayBuffer);
        if (bytes.byteLength > config.maxEventBytes) {
          finish(new Error('live_tts_event_too_large'));
          return;
        }
        let event: Record<string, unknown>;
        try {
          event = JSON.parse(bytes.toString('utf8')) as Record<string, unknown>;
        } catch {
          finish(new Error('live_tts_invalid_event'));
          return;
        }
        if (event['type'] === 'session.started') {
          const session = event['session'];
          sessionId = session && typeof session === 'object' && !Array.isArray(session) &&
            typeof (session as Record<string, unknown>)['id'] === 'string'
            ? String((session as Record<string, unknown>)['id'])
            : '';
          if (!sessionId) {
            finish(new Error('live_tts_session_missing'));
            return;
          }
          socket.send(JSON.stringify({
            type: 'session.commentary.append',
            event_id: 'ha_tts_speak',
            delegation_id: null,
            content: requestedText,
          }));
          return;
        }
        if (event['type'] === 'session.output_audio.delta' && typeof event['delta'] === 'string') {
          const chunk = Buffer.from(event['delta'], 'base64');
          totalBytes += chunk.byteLength;
          if (totalBytes > 12_000_000) {
            finish(new Error('live_tts_audio_size_invalid'));
            return;
          }
          audioChunks.push(chunk);
          if (transcript) scheduleValidation();
          return;
        }
        if (event['type'] === 'session.output_transcript.delta' && typeof event['delta'] === 'string') {
          transcript += event['delta'];
          scheduleValidation();
          return;
        }
        if (event['type'] === 'error') finish(new Error('live_tts_provider_error'));
      });
      socket.once('error', () => finish(new Error('live_tts_connection_failed')));
      socket.once('close', () => {
        this.activeSockets.delete(socket);
        if (!settled) finish(new Error('live_tts_closed'));
      });
    });
  }
}

function pcm16MonoToWav(pcm: Buffer, sampleRate: number): Buffer {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}
