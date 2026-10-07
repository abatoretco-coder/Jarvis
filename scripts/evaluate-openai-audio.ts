import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { loadEnv } from '../src/env';
import {
  resolveOpenAiTtsRuntimeConfig,
  synthesizeOpenAiSpeech,
} from '../src/routes/ingest/audioRuntime';

async function main(): Promise<void> {
  const envFile = resolve(process.argv[2] || '.env.pc');
  if (existsSync(envFile)) process.loadEnvFile(envFile);

  const env = loadEnv(process.env);
  const ttsConfig = resolveOpenAiTtsRuntimeConfig(env);
  if (!ttsConfig) throw new Error('OpenAI audio is not configured.');

  const sampleText = 'Validation audio Jarvis.';
  const startedAt = Date.now();
  const speech = await synthesizeOpenAiSpeech(ttsConfig, sampleText);
  const ttsElapsedMs = Date.now() - startedAt;

  const form = new FormData();
  form.set('model', env.OPENAI_STT_MODEL);
  form.set('response_format', 'json');
  form.set('file', new Blob([speech.bytes], { type: speech.contentType }), 'jarvis-audio-smoke.wav');

  const sttStartedAt = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), env.OPENAI_STT_TIMEOUT_MS);
  try {
    const response = await fetch(`${(env.OPENAI_STT_BASE_URL || env.OPENAI_BASE_URL).replace(/\/$/, '')}/audio/transcriptions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${env.OPENAI_API_KEY}` },
      body: form,
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`STT smoke failed with HTTP ${response.status}.`);
    const payload = await response.json() as { text?: string };
    const transcriptChars = payload.text?.trim().length ?? 0;
    if (transcriptChars === 0) throw new Error('STT smoke returned an empty transcript.');
    process.stdout.write(JSON.stringify({
      ok: true,
      ttsModel: ttsConfig.model,
      sttModel: env.OPENAI_STT_MODEL,
      audioBytes: speech.bytes.length,
      transcriptChars,
      ttsElapsedMs,
      sttElapsedMs: Date.now() - sttStartedAt,
    }) + '\n');
  } finally {
    clearTimeout(timeout);
  }
}

void main();
