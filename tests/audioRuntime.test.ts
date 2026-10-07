import { describe, expect, test } from '@jest/globals';

import { loadEnv } from '../src/env';
import {
  isRealtimeSpeechModel,
  pcm16MonoToWav,
  resolveOpenAiTtsRuntimeConfig,
} from '../src/routes/ingest/audioRuntime';

describe('Phase 1 cloud TTS runtime', () => {
  test('uses the primary OpenAI credentials when no dedicated speech endpoint is set', () => {
    const env = loadEnv({ REQUIRE_API_KEY: 'false', OPENAI_API_KEY: 'primary-key' });
    expect(resolveOpenAiTtsRuntimeConfig(env)).toMatchObject({
      apiKey: 'primary-key',
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-realtime-2.1-mini',
      voice: 'marin',
    });
  });

  test('uses the single shared OpenAI service account for speech', () => {
    const env = loadEnv({
      REQUIRE_API_KEY: 'false',
      OPENAI_API_KEY: 'primary-key',
      OPENAI_BASE_URL: 'https://gateway.example.test/v1',
      OPENAI_TTS_MODEL: 'speech-model',
    });
    expect(resolveOpenAiTtsRuntimeConfig(env)).toMatchObject({
      apiKey: 'primary-key',
      baseUrl: 'https://gateway.example.test/v1',
      model: 'speech-model',
    });
  });

  test('stays disabled when no cloud credential is configured', () => {
    const env = loadEnv({ REQUIRE_API_KEY: 'false' });
    expect(resolveOpenAiTtsRuntimeConfig(env)).toBeNull();
  });

  test('routes current realtime speech models over the realtime transport', () => {
    expect(isRealtimeSpeechModel('gpt-realtime-2.1-mini')).toBe(true);
    expect(isRealtimeSpeechModel('gpt-4o-mini-tts')).toBe(false);
  });

  test('wraps realtime PCM chunks in a valid 24 kHz mono WAV container', () => {
    const wav = pcm16MonoToWav(Buffer.from([0, 0, 1, 0]));
    expect(wav.subarray(0, 4).toString('ascii')).toBe('RIFF');
    expect(wav.subarray(8, 12).toString('ascii')).toBe('WAVE');
    expect(wav.readUInt16LE(22)).toBe(1);
    expect(wav.readUInt32LE(24)).toBe(24_000);
    expect(wav.readUInt32LE(40)).toBe(4);
    expect(wav.subarray(44)).toEqual(Buffer.from([0, 0, 1, 0]));
  });
});
