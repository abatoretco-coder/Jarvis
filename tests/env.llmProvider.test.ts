import { describe, expect, test } from '@jest/globals';

import { loadEnv } from '../src/env';

describe('LLM provider configuration', () => {
  test('uses Ollama by default without configuring an OpenAI fallback', () => {
    const env = loadEnv({ REQUIRE_API_KEY: 'false' });

    expect(env.LLM_PROVIDER).toBe('ollama');
    expect(env.OPENAI_API_KEY).toBe('ollama');
    expect(env.LLM_FALLBACK_OPENAI_API_KEY).toBeUndefined();
    expect(env.LLM_FALLBACK_OPENAI_BASE_URL).toBeUndefined();
  });

  test('maps Ollama to the existing OpenAI-compatible chat configuration', () => {
    const env = loadEnv({
      REQUIRE_API_KEY: 'false',
      LLM_PROVIDER: 'ollama',
      OLLAMA_BASE_URL: 'http://localhost:11434/v1/',
      OLLAMA_MODEL: 'qwen3:8b',
    });

    expect(env.OPENAI_BASE_URL).toBe('http://localhost:11434/v1');
    expect(env.OPENAI_API_KEY).toBe('ollama');
    expect(env.OPENAI_MODEL_SUMMARY).toBe('qwen3:8b');
    expect(env.OPENAI_MODEL_MUSIC_AGENT).toBe('qwen3:8b');
    expect(env.OPENAI_MODEL_ROUTER).toBe('qwen3:8b');
  });

  test('keeps the original OpenAI settings as the hybrid fallback', () => {
    const env = loadEnv({
      REQUIRE_API_KEY: 'false',
      LLM_PROVIDER: 'hybrid',
      OLLAMA_BASE_URL: 'http://localhost:11434/v1',
      OLLAMA_MODEL: 'qwen3:4b-instruct',
      OPENAI_API_KEY: 'cloud-key',
      OPENAI_BASE_URL: 'https://api.openai.com/v1',
      OPENAI_MODEL_ROUTER: 'gpt-4o-mini',
    });

    expect(env.OPENAI_BASE_URL).toBe('http://localhost:11434/v1');
    expect(env.OPENAI_MODEL_ROUTER).toBe('qwen3:4b-instruct');
    expect(env.LLM_FALLBACK_OPENAI_API_KEY).toBe('cloud-key');
    expect(env.LLM_FALLBACK_OPENAI_BASE_URL).toBe('https://api.openai.com/v1');
    expect(env.LLM_FALLBACK_OPENAI_MODEL_ROUTER).toBe('gpt-4o-mini');
  });
});
