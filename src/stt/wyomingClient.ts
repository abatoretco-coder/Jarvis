import net from 'node:net';

export type WyomingSttConfig = {
  host: string;
  port: number;
  timeoutMs: number;
  language?: string;
};

type WavPcm = {
  audio: Buffer;
  rate: number;
  width: number;
  channels: number;
};

type WyomingEvent = {
  type?: string;
  data?: Record<string, unknown>;
  data_length?: number;
  payload_length?: number;
};

function readWavPcm(wav: Buffer): WavPcm {
  if (wav.length < 44 || wav.toString('ascii', 0, 4) !== 'RIFF' || wav.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('local_stt_requires_wav');
  }

  let offset = 12;
  let rate = 0;
  let width = 0;
  let channels = 0;
  let audio: Buffer | undefined;
  while (offset + 8 <= wav.length) {
    const id = wav.toString('ascii', offset, offset + 4);
    const length = wav.readUInt32LE(offset + 4);
    const dataStart = offset + 8;
    // Streaming WAV writers (including Kokoro) use 0xffffffff until the
    // stream is finalized. In that case the data chunk extends to EOF.
    const dataEnd = length === 0xffffffff ? wav.length : dataStart + length;
    if (dataEnd > wav.length) break;
    if (id === 'fmt ' && length >= 16) {
      if (wav.readUInt16LE(dataStart) !== 1) throw new Error('local_stt_requires_pcm');
      channels = wav.readUInt16LE(dataStart + 2);
      rate = wav.readUInt32LE(dataStart + 4);
      width = wav.readUInt16LE(dataStart + 14) / 8;
    } else if (id === 'data') {
      audio = wav.subarray(dataStart, dataEnd);
    }
    offset = dataEnd + (length % 2);
  }

  if (!audio || !rate || !width || !channels) throw new Error('local_stt_invalid_wav');
  return { audio, rate, width, channels };
}

function eventLine(type: string, data?: Record<string, unknown>, payload?: Buffer): Buffer {
  const event: WyomingEvent = { type };
  if (data && Object.keys(data).length > 0) event.data = data;
  if (payload && payload.length > 0) event.payload_length = payload.length;
  const header = Buffer.from(`${JSON.stringify(event)}\n`, 'utf8');
  return payload ? Buffer.concat([header, payload]) : header;
}

/** Transcribe a PCM WAV with a Wyoming ASR service, without Home Assistant. */
export async function transcribeWithWyoming(wav: Buffer, config: WyomingSttConfig): Promise<string> {
  const pcm = readWavPcm(wav);
  return await new Promise<string>((resolve, reject) => {
    const socket = net.createConnection({ host: config.host, port: config.port });
    let pending = Buffer.alloc(0);
    let expectedData = 0;
    let expectedPayload = 0;
    let currentEvent: WyomingEvent | undefined;
    const transcriptChunks: string[] = [];
    let settled = false;

    const finish = (error?: Error, text?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      socket.destroy();
      if (error) reject(error);
      else resolve((text ?? transcriptChunks.join(' ')).trim());
    };
    const timeout = setTimeout(() => finish(new Error('local_stt_timeout')), config.timeoutMs);

    const consume = () => {
      while (true) {
        if (currentEvent && expectedData > 0) {
          if (pending.length < expectedData) return;
          try {
            const extra = JSON.parse(pending.subarray(0, expectedData).toString('utf8')) as Record<string, unknown>;
            currentEvent.data = { ...currentEvent.data, ...extra };
          } catch {
            finish(new Error('local_stt_invalid_response'));
            return;
          }
          pending = pending.subarray(expectedData);
          expectedData = 0;
        }
        if (currentEvent && expectedPayload > 0) {
          if (pending.length < expectedPayload) return;
          pending = pending.subarray(expectedPayload);
          expectedPayload = 0;
        }
        if (currentEvent) {
          const event = currentEvent;
          currentEvent = undefined;
          const text = typeof event.data?.text === 'string' ? event.data.text.trim() : '';
          if (event.type === 'transcript-chunk' && text) transcriptChunks.push(text);
          if (event.type === 'transcript') { finish(undefined, text || transcriptChunks.join(' ')); return; }
          // Some Wyoming servers only stream chunks; do not finish on an empty
          // stop event because legacy servers send the final transcript after it.
          if (event.type === 'transcript-stop' && transcriptChunks.length > 0) { finish(undefined, transcriptChunks.join(' ')); return; }
          if (event.type === 'error') { finish(new Error('local_stt_service_error')); return; }
          continue;
        }
        const newline = pending.indexOf(0x0a);
        if (newline < 0) return;
        const raw = pending.subarray(0, newline).toString('utf8');
        pending = pending.subarray(newline + 1);
        let event: WyomingEvent;
        try { event = JSON.parse(raw) as WyomingEvent; } catch { finish(new Error('local_stt_invalid_response')); return; }
        currentEvent = event;
        expectedData = Number(event.data_length ?? 0);
        expectedPayload = Number(event.payload_length ?? 0);
      }
    };

    socket.once('error', () => finish(new Error('local_stt_unavailable')));
    socket.on('data', (chunk: Buffer) => { pending = Buffer.concat([pending, chunk]); consume(); });
    socket.once('connect', () => {
      socket.write(eventLine('transcribe', config.language ? { language: config.language } : undefined));
      socket.write(eventLine('audio-start', { rate: pcm.rate, width: pcm.width, channels: pcm.channels }));
      socket.write(eventLine('audio-chunk', { rate: pcm.rate, width: pcm.width, channels: pcm.channels }, pcm.audio));
      socket.write(eventLine('audio-stop'));
    });
  });
}
