import type { Env } from '../env';

export type OpenAiTextCapability = 'router' | 'summary' | 'agent' | 'music' | 'synthesis';
export type OpenAiCapability = OpenAiTextCapability | 'embedding' | 'stt' | 'tts';

export type OpenAiCapabilityConfig = {
  model: string;
  maxOutputTokens: number;
  reasoningEffort?: 'none' | 'low';
};

export function resolveOpenAiCapability(env: Env, capability: OpenAiTextCapability): OpenAiCapabilityConfig {
  switch (capability) {
    case 'router':
      return {
        model: env.OPENAI_MODEL_ROUTER,
        maxOutputTokens: env.OPENAI_MAX_OUTPUT_TOKENS_ROUTER,
        reasoningEffort: 'none',
      };
    case 'summary':
      return {
        model: env.OPENAI_MODEL_SUMMARY,
        maxOutputTokens: env.OPENAI_MAX_OUTPUT_TOKENS_SUMMARY,
        reasoningEffort: 'none',
      };
    case 'agent':
      return {
        model: env.OPENAI_MODEL_AGENT,
        maxOutputTokens: env.OPENAI_MAX_OUTPUT_TOKENS_AGENT,
        reasoningEffort: 'none',
      };
    case 'music':
      return {
        model: env.OPENAI_MODEL_MUSIC_AGENT,
        maxOutputTokens: env.OPENAI_MAX_OUTPUT_TOKENS_MUSIC_AGENT,
        reasoningEffort: 'none',
      };
    case 'synthesis':
      return {
        model: env.OPENAI_MODEL_SYNTHESIS,
        maxOutputTokens: env.OPENAI_MAX_OUTPUT_TOKENS_SYNTHESIS,
        reasoningEffort: 'low',
      };
  }
}

export function supportsReasoningEffort(model: string): boolean {
  return /^gpt-(?:5|6)(?:[.-]|$)/i.test(model.trim());
}
