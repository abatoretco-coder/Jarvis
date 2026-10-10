import { describe, expect, test } from '@jest/globals';

import { loadEnv } from '../src/env';

describe('Phase 1 cloud runtime policy', () => {
  test('disables legacy global API keys by default', () => {
    expect(loadEnv({ REQUIRE_API_KEY: 'false' }).ALLOW_LEGACY_API_KEYS).toBe(false);
    expect(() => loadEnv({
      REQUIRE_API_KEY: 'true',
      ALLOW_LEGACY_API_KEYS: 'true',
      API_KEY: 'retired-global-key',
    })).toThrow('legacy global API keys are retired');
  });

  test('uses OpenAI by default without fabricating credentials', () => {
    const env = loadEnv({ REQUIRE_API_KEY: 'false' });

    expect(env.LLM_PROVIDER).toBe('openai');
    expect(env.OPENAI_BASE_URL).toBe('https://api.openai.com/v1');
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env).toMatchObject({
      OPENAI_MODEL_ROUTER: 'gpt-6-luna',
      OPENAI_MODEL_SUMMARY: 'gpt-6-luna',
      OPENAI_MODEL_AGENT: 'gpt-6-luna',
      OPENAI_MODEL_MUSIC_AGENT: 'gpt-6-luna',
      OPENAI_MODEL_SYNTHESIS: 'gpt-6.1-sol',
      OPENAI_MAX_OUTPUT_TOKENS_ROUTER: 256,
      OPENAI_MAX_OUTPUT_TOKENS_SUMMARY: 512,
      OPENAI_MAX_OUTPUT_TOKENS_AGENT: 512,
      OPENAI_MAX_OUTPUT_TOKENS_MUSIC_AGENT: 384,
      OPENAI_MAX_OUTPUT_TOKENS_SYNTHESIS: 768,
      OPENAI_RETRY_MAX: 2,
      OPENAI_CIRCUIT_FAILURE_THRESHOLD: 5,
      OPENAI_BUDGET_MAX_REQUESTS: 2_000,
      OPENAI_BUDGET_MAX_TOKENS: 2_000_000,
    });
    expect(env.OPENAI_STT_MODEL).toBe('gpt-transcribe');
    expect(env.OPENAI_TTS_MODEL).toBe('gpt-realtime-2.1-mini');
  });

  test.each(['ollama', 'hybrid'])('rejects the removed local provider mode %s', (provider) => {
    expect(() =>
      loadEnv({
        REQUIRE_API_KEY: 'false',
        LLM_PROVIDER: provider,
      })
    ).toThrow('LLM_PROVIDER: Invalid input: expected "openai"');
  });

  test('preserves explicit OpenAI endpoints and model choices', () => {
    const env = loadEnv({
      REQUIRE_API_KEY: 'false',
      LLM_PROVIDER: 'openai',
      OPENAI_API_KEY: 'cloud-key',
      OPENAI_BASE_URL: 'https://gateway.example.test/v1',
      OPENAI_MODEL_ROUTER: 'router-model',
      OPENAI_STT_MODEL: 'transcription-model',
      OPENAI_TTS_MODEL: 'speech-model',
    });

    expect(env).toMatchObject({
      LLM_PROVIDER: 'openai',
      OPENAI_API_KEY: 'cloud-key',
      OPENAI_BASE_URL: 'https://gateway.example.test/v1',
      OPENAI_MODEL_ROUTER: 'router-model',
      OPENAI_STT_MODEL: 'transcription-model',
      OPENAI_TTS_MODEL: 'speech-model',
    });
  });

  test('rejects a retry ceiling shorter than the base delay', () => {
    expect(() =>
      loadEnv({
        REQUIRE_API_KEY: 'false',
        OPENAI_RETRY_BASE_DELAY_MS: '500',
        OPENAI_RETRY_MAX_DELAY_MS: '100',
      })
    ).toThrow('OPENAI_RETRY_MAX_DELAY_MS must be greater than or equal');
  });

  test('requires a complete and transport-safe OIDC configuration', () => {
    expect(() => loadEnv({ REQUIRE_API_KEY: 'false', OIDC_ENABLED: 'true' })).toThrow(
      'OIDC_ISSUER_URL'
    );
    expect(() =>
      loadEnv({
        REQUIRE_API_KEY: 'false',
        OIDC_ENABLED: 'true',
        OIDC_ISSUER_URL: 'http://identity.example.test/realms/jarvis',
        OIDC_AUDIENCE: 'jarvis-api',
      })
    ).toThrow('must use HTTPS');
    expect(
      loadEnv({
        REQUIRE_API_KEY: 'false',
        OIDC_ENABLED: 'true',
        OIDC_ISSUER_URL: 'http://127.0.0.1:8080/realms/jarvis',
        OIDC_AUDIENCE: 'jarvis-api',
      }).OIDC_ENABLED
    ).toBe(true);
  });

  test('fails closed when public edge prerequisites are incomplete', () => {
    expect(() =>
      loadEnv({
        REQUIRE_API_KEY: 'false',
        PUBLIC_EDGE_ENABLED: 'true',
      })
    ).toThrow('PUBLIC_BASE_URL');

    expect(() =>
      loadEnv({
        REQUIRE_API_KEY: 'true',
        ALLOW_LEGACY_API_KEYS: 'false',
        OIDC_ENABLED: 'true',
        OIDC_ISSUER_URL: 'https://identity.example.test/realms/jarvis',
        OIDC_AUDIENCE: 'jarvis-api',
        PUBLIC_EDGE_ENABLED: 'true',
        PUBLIC_BASE_URL: 'https://jarvis.example.test',
        TRUSTED_PROXY_CIDRS: 'not-a-cidr',
        EDGE_PROXY_SECRET: 'edge-secret-with-at-least-32-characters',
      })
    ).toThrow('TRUSTED_PROXY_CIDRS');

    const env = loadEnv({
      REQUIRE_API_KEY: 'true',
      ALLOW_LEGACY_API_KEYS: 'false',
      OIDC_ENABLED: 'true',
      OIDC_ISSUER_URL: 'https://identity.example.test/realms/jarvis',
      OIDC_AUDIENCE: 'jarvis-api',
      PUBLIC_EDGE_ENABLED: 'true',
      PUBLIC_BASE_URL: 'https://jarvis.example.test',
      TRUSTED_PROXY_CIDRS: '127.0.0.1/32,::1/128',
      EDGE_PROXY_SECRET: 'edge-secret-with-at-least-32-characters',
    });
    expect(env.PUBLIC_EDGE_ENABLED).toBe(true);

    expect(() =>
      loadEnv({
        REQUIRE_API_KEY: 'true',
        ALLOW_LEGACY_API_KEYS: 'false',
        OIDC_ENABLED: 'true',
        OIDC_ISSUER_URL: 'https://identity.example.test/realms/jarvis',
        OIDC_AUDIENCE: 'jarvis-api',
        OIDC_ALLOW_INSECURE_HTTP: 'true',
        PUBLIC_EDGE_ENABLED: 'true',
        PUBLIC_BASE_URL: 'https://jarvis.example.test',
        TRUSTED_PROXY_CIDRS: '127.0.0.1/32',
        EDGE_PROXY_SECRET: 'edge-secret-with-at-least-32-characters',
      })
    ).toThrow('OIDC_ALLOW_INSECURE_HTTP');
  });

  test('allows HTTP OIDC only through the explicit non-public PC escape hatch', () => {
    expect(() =>
      loadEnv({
        REQUIRE_API_KEY: 'true',
        SERVICE_API_KEYS_JSON: JSON.stringify([{ id: 'local-test', token: 'local-test-service-token-0123456789', permissions: ['chat'] }]),
        OIDC_ENABLED: 'true',
        OIDC_ISSUER_URL: 'http://identity:8080/realms/jarvis',
        OIDC_AUDIENCE: 'jarvis-api',
      })
    ).toThrow('OIDC_ISSUER_URL must use HTTPS');

    expect(
      loadEnv({
        REQUIRE_API_KEY: 'true',
        SERVICE_API_KEYS_JSON: JSON.stringify([{ id: 'local-test', token: 'local-test-service-token-0123456789', permissions: ['chat'] }]),
        OIDC_ENABLED: 'true',
        OIDC_ISSUER_URL: 'http://identity:8080/realms/jarvis',
        OIDC_AUDIENCE: 'jarvis-api',
        OIDC_ALLOW_INSECURE_HTTP: 'true',
      }).OIDC_ALLOW_INSECURE_HTTP
    ).toBe(true);
  });

  test('allows only the isolated edge identity service for internal HTTP JWKS', () => {
    const base = {
      REQUIRE_API_KEY: 'true',
      ALLOW_LEGACY_API_KEYS: 'false',
      OIDC_ENABLED: 'true',
      OIDC_ISSUER_URL: 'https://jarvis.example.test/realms/jarvis',
      OIDC_AUDIENCE: 'jarvis-api',
      PUBLIC_EDGE_ENABLED: 'true',
      PUBLIC_BASE_URL: 'https://jarvis.example.test',
      TRUSTED_PROXY_CIDRS: '172.30.91.10/32',
      EDGE_PROXY_SECRET: 'edge-secret-with-at-least-32-characters',
      OIDC_JWKS_ALLOW_INTERNAL_HTTP: 'true',
    };

    expect(
      loadEnv({
        ...base,
        OIDC_JWKS_URL: 'http://identity-edge-origin:8080/realms/jarvis/protocol/openid-connect/certs',
      }).OIDC_JWKS_ALLOW_INTERNAL_HTTP
    ).toBe(true);

    expect(() =>
      loadEnv({
        ...base,
        OIDC_JWKS_URL: 'http://identity:8080/realms/jarvis/protocol/openid-connect/certs',
      })
    ).toThrow('OIDC_JWKS_URL must use HTTPS');
  });
});
